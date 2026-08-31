import type { APIRoute } from 'astro';
import { created, handleError, ok, readJson } from '../../../lib/http';
import { createMonitor, listMonitorsForUser } from '../../../../supabase/db/monitors';
import { CreateMonitorSchema, ListMonitorsQuerySchema } from '../../../../shared/schemas';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await readJson(request);
    const input = CreateMonitorSchema.parse(body);
    return created(await createMonitor(input));
  } catch (e) {
    return handleError(e);
  }
};

export const GET: APIRoute = async ({ url }) => {
  try {
    const { username } = ListMonitorsQuerySchema.parse({
      username: url.searchParams.get('username') ?? '',
    });
    const monitors = await listMonitorsForUser(username);
    return ok(monitors);
  } catch (e) {
    return handleError(e);
  }
};
