import { createClient } from "@supabase/supabase-js";
import type { Database } from "../_shared/database.types.ts";
import { requireEnv } from "../_shared/env.ts";
import { check } from "../_shared/monitor-check.ts";
import type { CheckResult, MonitorRow } from "../_shared/monitor-check.ts";

const BATCH_LIMIT = 40;

Deno.serve(async (req) => {
  const env = Deno.env.toObject();

  if (!isAuthorized(req, env)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const client = createClient<Database>(
    requireEnv(env, "SUPABASE_URL"),
    requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const summary = { checked: 0, up: 0, down: 0, errors: 0 };

  const due = await dueMonitors(client);
  if (due.length === 0) {
    return json({ summary });
  }

  for (const monitor of due) {
    const claimed = await claim(client, monitor);
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
  const expected = requireEnv(env, "WORKER_SECRET");
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  // constant-time-ish compare to avoid trivial timing leaks
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
  monitor: MonitorRow,
): Promise<MonitorRow | null> {
  const now = new Date();
  const lease = new Date(now.getTime() + (monitor.timeout_seconds + 30) * 1000);

  const { data, error } = await client
    .from("monitors")
    .update({ check_started_at: now.toISOString(), check_lease_until: lease.toISOString() })
    .eq("id", monitor.id)
    .eq("is_paused", false)
    .lte("next_check_at", now.toISOString())
    .or(`check_started_at.is.null,check_lease_until.lt.${now.toISOString()}`)
    .select()
    .single();

  if (error) throw new Error(`Claim failed for ${monitor.id}: ${error.message}`);
  return data ?? null;
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
