import type { Tables } from "../../types.ts";

export type MonitorRow = Tables<"monitors">;

export type CheckError =
  | "TIMEOUT"
  | "DNS_ERROR"
  | "CONNECTION_ERROR"
  | "HTTP_4xx"
  | "HTTP_5xx"
  | "UNKNOWN_ERROR";

export interface CheckResult {
  status: "UP" | "DOWN";
  responseTimeMs: number | null;
  error: CheckError | null;
}

/**
 * Perform the HTTP check for a single monitor and classify the outcome.
 * 2xx -> UP (records response time), 4xx/5xx -> DOWN, network/timeout -> DOWN with a code.
 */
export async function check(
  monitor: Pick<MonitorRow, "url" | "timeout_seconds">,
): Promise<CheckResult> {
  const started = performance.now();
  try {
    const res = await fetch(monitor.url, {
      signal: AbortSignal.timeout(monitor.timeout_seconds * 1000),
      redirect: "follow",
    });
    const elapsed = Math.round(performance.now() - started);

    if (res.status >= 200 && res.status < 300) {
      return { status: "UP", responseTimeMs: elapsed, error: null };
    }
    return {
      status: "DOWN",
      responseTimeMs: elapsed,
      error: res.status < 500 ? "HTTP_4xx" : "HTTP_5xx",
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { status: "DOWN", responseTimeMs: null, error: "TIMEOUT" };
    }
    const cause = err as { cause?: { code?: string; message?: string } };
    const causeMsg = (cause?.cause?.message ?? "").toLowerCase();
    if (
      cause?.cause?.code === "ENOTFOUND" ||
      cause?.cause?.code === "EAI_AGAIN" ||
      /dns error|getaddrinfo|enotfound|no such host|lookup/i.test(causeMsg)
    ) {
      return { status: "DOWN", responseTimeMs: null, error: "DNS_ERROR" };
    }
    if (err instanceof TypeError) {
      return { status: "DOWN", responseTimeMs: null, error: "CONNECTION_ERROR" };
    }
    return { status: "DOWN", responseTimeMs: null, error: "UNKNOWN_ERROR" };
  }
}
