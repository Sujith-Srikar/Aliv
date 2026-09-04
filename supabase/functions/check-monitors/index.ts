import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../types.ts";
import { check } from "../_shared/monitor-check.ts";
import type { CheckResult, MonitorRow } from "../_shared/monitor-check.ts";

const BATCH_LIMIT = 40;

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

  const due = await dueMonitors(client);
  if (due.length === 0) {
    return json({ summary });
  }

  for (const monitor of due) {
    const claimed = await claim(client, monitor.id);
    if (!claimed) continue; // another run won this one

    const result = await check(claimed);
    await persist(client, claimed, result);

    summary.checked += 1;
    if (result.status === "UP") summary.up += 1;
    else {
      summary.down += 1;
      summary.errors += 1;
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

async function dueMonitors(
  client: ReturnType<typeof createClient<Database>>,
): Promise<MonitorRow[]> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("monitors")
    .select("*")
    .eq("is_paused", false)
    .lte("next_check_at", now)
    .or(`check_started_at.is.null,check_lease_until.lt.${now}`)
    .limit(BATCH_LIMIT);

  if (error) throw new Error(`Failed to load due monitors: ${error.message}`);
  return data ?? [];
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
