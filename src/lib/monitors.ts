import type { CreateMonitorInput, UpdateMonitorInput } from '../shared/schemas';
import type { Tables, TablesInsert, TablesUpdate } from './database.types';
import { getDb } from './db';

export type Monitor = Tables<'monitors'>;

async function findOrCreateUser(username: string): Promise<string> {
  const db = getDb();
  const { data: found } = await db
    .from('users')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (found) return found.id;

  const { data: created } = await db.from('users').insert({ username }).select('id').maybeSingle();
  if (created) return created.id;

  // Lost a race against a concurrent create for the same username; re-fetch.
  const { data: retried } = await db
    .from('users')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (retried) return retried.id;

  throw new Error('Failed to find or create user');
}

export async function createMonitor(input: CreateMonitorInput): Promise<Monitor> {
  const db = getDb();
  const userId = await findOrCreateUser(input.username);
  const row: TablesInsert<'monitors'> = {
    user_id: userId,
    name: input.name,
    url: input.url,
    interval_minutes: input.intervalMinutes,
    timeout_seconds: input.timeoutSeconds,
  };
  const { data, error } = await db.from('monitors').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function getMonitor(id: string): Promise<Monitor | null> {
  const db = getDb();
  const { data } = await db.from('monitors').select().eq('id', id).maybeSingle();
  return data ?? null;
}

export async function listMonitorsForUser(username: string): Promise<Monitor[]> {
  const db = getDb();
  const { data: user } = await db.from('users').select('id').eq('username', username).maybeSingle();
  if (!user) return [];

  const { data } = await db
    .from('monitors')
    .select()
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });
  return data ?? [];
}

export async function updateMonitor(
  id: string,
  input: UpdateMonitorInput,
): Promise<Monitor | null> {
  const existing = await getMonitor(id);
  if (!existing) return null;

  const patch: TablesUpdate<'monitors'> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.url !== undefined) patch.url = input.url;
  if (input.intervalMinutes !== undefined) patch.interval_minutes = input.intervalMinutes;
  if (input.timeoutSeconds !== undefined) patch.timeout_seconds = input.timeoutSeconds;
  if (input.isPaused !== undefined) patch.is_paused = input.isPaused;

  // Re-base the schedule when interval changes; make a resumed monitor due now.
  const intervalChanged =
    patch.interval_minutes !== undefined && patch.interval_minutes !== existing.interval_minutes;
  const resuming = patch.is_paused === false && existing.is_paused === true;
  if (intervalChanged && patch.interval_minutes !== undefined) {
    patch.next_check_at = new Date(Date.now() + patch.interval_minutes * 60_000).toISOString();
  } else if (resuming) {
    patch.next_check_at = new Date().toISOString();
  }

  const db = getDb();
  const { data, error } = await db.from('monitors').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteMonitor(id: string): Promise<boolean> {
  const db = getDb();
  const { data, error } = await db
    .from('monitors')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
