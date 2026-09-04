import { lookup } from 'node:dns/promises';

// Minimal SSRF guard for the Astro (Node) side. Called whenever a monitor URL
// is created or updated: reject if the hostname resolves to any private,
// loopback, link-local, or cloud-metadata address. The worker performs the same
// check again at fetch time (DNS can change).
//
// ponytail: the pure IP-classification logic below is duplicated in
// supabase/functions/_shared/ssrf.ts (Deno) because the worker may not import
// Astro shared/ code; revisit if it grows.

function ipv4Val(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let v = 0;
  for (const o of p) {
    if (!/^\d{1,3}$/.test(o)) return null;
    const n = Number(o);
    if (n > 255) return null;
    v = (v << 8) | n;
  }
  return v >>> 0;
}

function ipv6Val(ip: string): bigint | null {
  const m = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) {
    const o = m[1].split('.').map(Number);
    if (o.some((x) => x > 255)) return null;
    const v4 = (((o[0] << 8) | o[1]) << 16) | ((o[2] << 8) | o[3]);
    return (0xffffn << 32n) | BigInt(v4 >>> 0);
  }

  let body = ip;
  const emb = ip.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (emb) {
    const o = emb[1].split('.').map(Number);
    if (o.some((x) => x > 255)) return null;
    const v4 = (((o[0] << 8) | o[1]) << 16) | ((o[2] << 8) | o[3]);
    body = `${ip.slice(0, emb.index)}:${v4.toString(16)}`;
  }

  const hasDouble = body.includes('::');
  let head = body;
  let tail = '';
  if (hasDouble) {
    const idx = body.indexOf('::');
    head = body.slice(0, idx);
    tail = body.slice(idx + 2);
  }
  const hParts = head ? head.split(':').filter(Boolean) : [];
  const tParts = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - hParts.length - tParts.length;
  if (missing < 0) return null;
  const groups = [...hParts, ...Array(missing).fill('0'), ...tParts];
  if (groups.length !== 8) return null;

  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

const V4 = (ip: string): bigint => (0xffffn << 32n) | BigInt(ipv4Val(ip) as number);

const BLOCKED_RANGES: ReadonlyArray<readonly [bigint, bigint]> = [
  [V4('0.0.0.0'), V4('0.255.255.255')],
  [V4('10.0.0.0'), V4('10.255.255.255')],
  [V4('100.64.0.0'), V4('100.127.255.255')],
  [V4('127.0.0.0'), V4('127.255.255.255')],
  [V4('169.254.0.0'), V4('169.254.255.255')],
  [V4('172.16.0.0'), V4('172.31.255.255')],
  [V4('192.168.0.0'), V4('192.168.255.255')],
  [V4('192.0.0.0'), V4('192.0.0.255')],
  [V4('192.0.2.0'), V4('192.0.2.255')],
  [V4('198.18.0.0'), V4('198.19.255.255')],
  [V4('198.51.100.0'), V4('198.51.100.255')],
  [V4('203.0.113.0'), V4('203.0.113.255')],
  [V4('224.0.0.0'), V4('239.255.255.255')],
  [V4('240.0.0.0'), V4('255.255.255.255')],
  [0n, 0n],
  [1n, 1n],
  [0xfc00n << 112n, (0xfc00n << 112n) + (1n << 121n) - 1n],
  [0xfe80n << 112n, (0xfe80n << 112n) + (1n << 118n) - 1n],
];

function to128(ip: string): bigint | null {
  if (ip.includes(':')) return ipv6Val(ip);
  const v4 = ipv4Val(ip);
  return v4 === null ? null : (0xffffn << 32n) | BigInt(v4);
}

function isPrivateIp(ip: string): boolean {
  const v = to128(ip);
  if (v === null) return true;
  for (const [s, e] of BLOCKED_RANGES) {
    if (v >= s && v <= e) return true;
  }
  return false;
}

export class SsrfError extends Error {}

/**
 * Validate a URL is http(s) and its hostname resolves only to public IPs.
 * Throws SsrfError if unsafe.
 */
export async function assertSafeUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`only http(s) URLs are allowed: ${raw}`);
  }
  if (!url.hostname) {
    throw new SsrfError(`URL has no hostname: ${raw}`);
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    // DNS failure at create/update time is not proof of a private target;
    // let the worker surface the DNS error instead of blocking creation.
    return;
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new SsrfError(`hostname ${url.hostname} resolves to a blocked address (${address})`);
    }
  }
}
