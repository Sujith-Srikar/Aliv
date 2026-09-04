import type { Tables } from "../../types.ts";
import { assertSafeUrl, SsrfError } from "./ssrf.ts";

export type MonitorRow = Tables<"monitors">;

export type CheckError =
  | "TIMEOUT"
  | "DNS_ERROR"
  | "CONNECTION_ERROR"
  | "HTTP_4xx"
  | "HTTP_5xx"
  | "SSRF_BLOCKED"
  | "UNKNOWN_ERROR";

export interface CheckResult {
  status: "UP" | "DOWN";
  responseTimeMs: number | null;
  error: CheckError | null;
}

/**
 * Perform the HTTP check for a single monitor and classify the outcome.
 * 2xx -> UP (records response time), 4xx/5xx -> DOWN, network/timeout -> DOWN with a code.
 *
 * SSRF guard: the initial URL and every redirect hop are resolved and rejected
 * if they point at a private/loopback/link-local/metadata address. Redirects
 * are followed manually (never the library's auto-follow) so each hop is vetted.
 * A blocked target yields DOWN with SSRF_BLOCKED rather than a silent internal hit.
 */
export async function check(
  monitor: Pick<MonitorRow, "url" | "timeout_seconds">,
): Promise<CheckResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timeoutMs = monitor.timeout_seconds * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url = await assertSafeUrl(monitor.url);

    const MAX_REDIRECTS = 5;
    let response: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect) break;

      const location = response.headers.get("location");
      if (!location) break; // malformed redirect -> treat final response as the result

      url = await assertSafeUrl(new URL(location, url).toString());
    }

    const elapsed = Math.round(performance.now() - started);

    if (response!.status >= 200 && response!.status < 300) {
      return { status: "UP", responseTimeMs: elapsed, error: null };
    }
    return {
      status: "DOWN",
      responseTimeMs: elapsed,
      error: response!.status < 500 ? "HTTP_4xx" : "HTTP_5xx",
    };
  } catch (err) {
    if (err instanceof SsrfError) {
      return { status: "DOWN", responseTimeMs: null, error: "SSRF_BLOCKED" };
    }
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
  } finally {
    clearTimeout(timer);
  }
}
