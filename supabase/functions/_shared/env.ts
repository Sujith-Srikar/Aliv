/**
 * Runtime-agnostic required-env accessor for Edge Functions (pass
 * `Deno.env.toObject()`). Fails fast with a clear message so missing config
 * is never a silent bug.
 */
export function requireEnv(
  source: Record<string, string | undefined>,
  name: string,
): string {
  const value = source[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
