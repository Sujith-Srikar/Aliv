import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../types.ts";
import { check } from "../_shared/monitor-check.ts";
import type { CheckResult, MonitorRow } from "../_shared/monitor-check.ts";

const READ_QTY = 10;
const MAX_ROUNDS = 3;

type QueueMessage = { msg_id: string | number; message: unknown };

Deno.serve(async (req: Request) => {
  const env = Deno.env.toObject();

  if (!isAuthorized(req, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const url = env.SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const client = createClient<Database>(url, serviceRole, {
    auth: { persistSession: false },
  });

  const summary = { checked: 0, up: 0, down: 0, errors: 0 };

  // Drain the queue in concurrent batches. Bounded rounds keep the invocation
  // inside the wall-clock budget; messages left unacked stay under their pgmq
  // visibility timeout and are retried automatically.
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const batch = await readBatch(client);

    if (batch.length === 0) break;

    const settled = await Promise.allSettled(
      batch.map((msg) => processOne(client, msg, summary)),
    );

    for (let i = 0; i < batch.length; i++) {
      // Ack only fully-successful messages. Failures are left unacked so pgmq
      // re-delivers them after the visibility timeout (its own retry).
      if (settled[i]?.status === "fulfilled") {
        await ack(client, batch[i].msg_id);
      }
    }
  }

  return json({ summary });
});

function isAuthorized(req: Request, env: Record<string, string | undefined>): boolean {
  const expected = env.WORKER_SECRET;

  if(!expected) return false;

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function readBatch(
  client: ReturnType<typeof createClient<Database>>,
): Promise<QueueMessage[]> {
  const { data, error } = await client.rpc("read_monitor_checks", { p_qty: READ_QTY });

  if (error) throw new Error(`Failed to read queue: ${error.message}`);
  return ((data ?? []) as QueueMessage[]).filter((m) => m && m.msg_id != null);
}

async function ack(
  client: ReturnType<typeof createClient<Database>>,
  msgId: string | number,
): Promise<void> {
  const { error } = await client.rpc("delete_monitor_check", { p_msg_id: msgId });
  if (error) {
    // A failed ack is non-fatal: the message just reappears after vt and is
    // either acked or rejected as a no-op on the next pass.
    console.error(`Ack failed for msg ${msgId}: ${error.message}`);
  }
}

async function processOne(
  client: ReturnType<typeof createClient<Database>>,
  msg: QueueMessage,
  summary: { checked: number; up: number; down: number; errors: number },
): Promise<void> {
  const monitorId = (msg.message as { monitor_id?: string } | null)?.monitor_id;
  if (!monitorId) return; // malformed message -> ack it

  const claimed = await claim(client, monitorId);
  if (!claimed) return; // already claimed/paused/deleted -> ack as a no-op

  const result = await check(claimed);
  await persist(client, claimed, result);

  summary.checked += 1;
  if (result.status === "UP") summary.up += 1;
  else {
    summary.down += 1;
    summary.errors += 1;
  }
}

async function claim(
  client: ReturnType<typeof createClient<Database>>,
  id: string,
): Promise<MonitorRow | null> {
  const { data, error } = await client.rpc("claim_monitor", { p_id: id });

  if (error) throw new Error(`Claim failed for ${id}: ${error.message}`);
  const rows = (data ?? []) as MonitorRow[];
  return rows.length > 0 ? rows[0] : null;
}

async function persist(
  client: ReturnType<typeof createClient<Database>>,
  monitor: MonitorRow,
  result: CheckResult,
): Promise<void> {
  const anchored = new Date(new Date(monitor.next_check_at).getTime() + monitor.interval_minutes * 60_000);

  const { error } = await client
    .from("monitors")
    .update({
      status: result.status,
      response_time_ms: result.responseTimeMs,
      last_checked_at: new Date().toISOString(),
      last_error: result.error,
      next_check_at: anchored.toISOString(),
      check_started_at: null,
      check_lease_until: null,
    })
    .eq("id", monitor.id);

  if (error) {
    throw new Error(`Persist failed for ${monitor.id}: ${error.message}`);
  }
}
