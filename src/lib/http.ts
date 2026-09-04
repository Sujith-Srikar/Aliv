import { ZodError } from 'zod';
import { logger } from '../../shared/logger';
import { MonitorLimitError } from '../../shared/monitor-limit';
import { SsrfError } from '../../shared/ssrf';

export class HttpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    status,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function ok(data: unknown): Response {
  return json({ data });
}

export function created(data: unknown): Response {
  return json({ data }, 201);
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function fail(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}

export async function readJson(
  request: Request,
  maxBytes = 16_384,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new HttpError('BODY_TOO_LARGE', 'request body too large', 413);
  }
  if (text.trim().length === 0) {
    throw new HttpError('EMPTY_BODY', 'request body is required', 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError('BAD_JSON', 'request body must be valid JSON', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError('BAD_JSON', 'request body must be a JSON object', 400);
  }
  return parsed as Record<string, unknown>;
}

function isPostgrestError(e: unknown): e is { code?: string; message?: string } {
  return typeof e === 'object' && e !== null && ('code' in e || 'message' in e);
}

export function handleError(e: unknown): Response {
  if (e instanceof HttpError) {
    return fail(e.code, e.message, e.status);
  }
  if (e instanceof ZodError) {
    return fail('VALIDATION_ERROR', e.issues[0]?.message ?? 'invalid input', 400);
  }
  if (e instanceof SsrfError) {
    return fail('SSRF_BLOCKED', e.message, 400);
  }
  if (e instanceof MonitorLimitError) {
    return fail('LIMIT_EXCEEDED', e.message, 429);
  }
  if (isPostgrestError(e) && e.code === '23505') {
    return fail('CONFLICT', 'a resource with these details already exists', 409);
  }
  logger.error('api error', e);
  return fail('INTERNAL', 'internal server error', 500);
}
