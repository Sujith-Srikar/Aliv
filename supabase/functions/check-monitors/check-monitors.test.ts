import { check } from "../_shared/monitor-check.ts";
import type { MonitorRow } from "../_shared/monitor-check.ts";

function monitor(overrides: Partial<MonitorRow> = {}): MonitorRow {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    user_id: "00000000-0000-0000-0000-000000000000",
    name: "t",
    url: "https://example.com",
    interval_minutes: 10,
    timeout_seconds: 5,
    is_paused: false,
    status: "DOWN",
    response_time_ms: null,
    last_checked_at: null,
    last_error: null,
    next_check_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    check_started_at: null,
    check_lease_until: null,
    ...overrides,
  };
}

async function startServer(handler: (r: Request) => Response | Promise<Response>): Promise<{ port: number; stop: () => Promise<void> }> {
  let port = 0;
  const server = Deno.serve({ port: 0, onListen: (addr) => { port = addr.port; } }, handler);
  while (port === 0) await new Promise((r) => setTimeout(r, 5));
  return { port, stop: () => server.shutdown() };
}

Deno.test("classifies 2xx as UP with response time", async () => {
  const { port, stop } = await startServer(() => new Response("ok", { status: 200 }));
  const result = await check(monitor({ url: `http://127.0.0.1:${port}` }));
  await stop();
  if (result.status !== "UP") throw new Error("expected UP");
  if (result.error !== null) throw new Error("expected no error");
  if (typeof result.responseTimeMs !== "number") throw new Error("expected response time");
});

Deno.test("classifies 404 as DOWN HTTP_4xx", async () => {
  const { port, stop } = await startServer(() => new Response("nf", { status: 404 }));
  const result = await check(monitor({ url: `http://127.0.0.1:${port}` }));
  await stop();
  if (result.status !== "DOWN" || result.error !== "HTTP_4xx") {
    throw new Error(`expected DOWN/HTTP_4xx, got ${result.status}/${result.error}`);
  }
});

Deno.test("classifies 500 as DOWN HTTP_5xx", async () => {
  const { port, stop } = await startServer(() => new Response("err", { status: 500 }));
  const result = await check(monitor({ url: `http://127.0.0.1:${port}` }));
  await stop();
  if (result.status !== "DOWN" || result.error !== "HTTP_5xx") {
    throw new Error(`expected DOWN/HTTP_5xx, got ${result.status}/${result.error}`);
  }
});

Deno.test("classifies timeout as DOWN TIMEOUT", async () => {
  // handler resolves after 3s, well past the 1s client timeout; will the client abort and classify TIMEOUT.
  const { port, stop } = await startServer(
    () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("slow")), 3000)),
  );
  const result = await check(monitor({ url: `http://127.0.0.1:${port}`, timeout_seconds: 1 }));
  await stop();
  if (result.status !== "DOWN" || result.error !== "TIMEOUT") {
    throw new Error(`expected DOWN/TIMEOUT, got ${result.status}/${result.error}`);
  }
});

Deno.test("classifies DNS failure as DOWN DNS_ERROR", async () => {
  const result = await check(monitor({ url: "http://does-not-exist.invalid" }));
  if (result.status !== "DOWN" || result.error !== "DNS_ERROR") {
    throw new Error(`expected DOWN/DNS_ERROR, got ${result.status}/${result.error}`);
  }
});

Deno.test("classifies connection refused as DOWN CONNECTION_ERROR", async () => {
  const result = await check(monitor({ url: "http://127.0.0.1:59999" }));
  if (result.status !== "DOWN" || result.error !== "CONNECTION_ERROR") {
    throw new Error(`expected DOWN/CONNECTION_ERROR, got ${result.status}/${result.error}`);
  }
});
