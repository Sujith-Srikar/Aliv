import type { APIRoute } from 'astro';
import { fail, handleError, noContent, ok, readJson } from '../../../lib/http';
import { deleteMonitor, updateMonitor } from '../../../lib/monitors';
import { UpdateMonitorSchema } from '../../../shared/schemas';

export const PATCH: APIRoute = async ({ params, request }) => {
  try {
    const id = params.id;
    if (!id) return fail('NOT_FOUND', 'monitor not found', 404);

    const body = await readJson(request);
    const input = UpdateMonitorSchema.parse(body);
    const monitor = await updateMonitor(id, input);
    if (!monitor) return fail('NOT_FOUND', 'monitor not found', 404);
    return ok(monitor);
  } catch (e) {
    return handleError(e);
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const id = params.id;
    if (!id) return fail('NOT_FOUND', 'monitor not found', 404);

    const deleted = await deleteMonitor(id);
    if (!deleted) return fail('NOT_FOUND', 'monitor not found', 404);
    return noContent();
  } catch (e) {
    return handleError(e);
  }
};
