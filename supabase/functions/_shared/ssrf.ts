// Minimal SSRF guard for the worker.
//
// Resolves a hostname and rejects it if it maps to any private, loopback,
// link-local, or cloud-metadata address; the HTTP check must never hit an
// internal endpoint. Resolution is validated before every fetch and again on
// each redirect hop because DNS can change and a public target can redirect
// to an internal one.
//
// Note: this is hardening, not a guarantee. fetch() re-resolves the hostname
// at connect time, so a DNS-rebinding race (validate public, then swap the
// record to internal before the fetch connects) cannot be fully closed from
// userland without pinning the IP, which Deno's fetch does not allow.
// ponytail: pure IP-classification logic is duplicated in shared/ssrf.ts (Astro)
// because the worker may not import Astro shared/ code; revisit if it grows.

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

// Inclusive [start, end] ranges in the 128-bit IPv4-mapped space.
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

export function isPrivateIp(ip: string): boolean {
  const v = to128(ip);
  if (v === null) return true; // unparseable -> fail closed
  for (const [s, e] of BLOCKED_RANGES) {
    if (v >= s && v <= e) return true;
  }
  return false;
}

export class SsrfError extends Error {}

/**
 * Validate a URL (http/https only) and that its hostname resolves only to
 * public IPs. Throws SsrfError if unsafe. Called before fetch and on each
 * redirect hop with the hop's own URL.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
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

  // Test-only escape hatch: the check harness serves targets on 127.0.0.1.
  // Never set in production; the worker deployment leaves it unset/absent.
  if (Deno.env.get('ALLOW_PRIVATE_MONITOR_URLS') === '1') {
    return url;
  }

  let addresses: string[] = [];
  try {
    addresses = await Deno.resolveDns(url.hostname, 'A');
  } catch {
    /* A lookup can fail for v6-only hosts; AAAA below decides. */
  }
  try {
    addresses = addresses.concat(await Deno.resolveDns(url.hostname, 'AAAA'));
  } catch {
    /* ignore lookup errors; fetch will surface the real DNS error */
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new SsrfError(`hostname ${url.hostname} resolves to a blocked address (${addr})`);
    }
  }
  return url;
}
