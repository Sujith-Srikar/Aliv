import type { CreateMonitorInput, UpdateMonitorInput } from '../../shared/schemas';
import type { Tables, TablesInsert, TablesUpdate } from '../types';
import { db } from './client';

export type Monitor = Tables<'monitors'>;

async function findOrCreateUser(username: string): Promise<string> {
  const { data: found } = await db
    .from('users')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (found) return found.id;

  const { data: created, error: createError } = await db.from('users').insert({ username }).select('id').maybeSingle();
  if (created) return created.id;

  if(createError?.code !== '23505') throw createError;

  const { data: retried } = await db
    .from('users')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (retried) return retried.id;

  throw new Error('Failed to find or create user');
}

export async function createMonitor(input: CreateMonitorInput): Promise<Monitor> {
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
  const { data, error } = await db.from('monitors').select().eq('id', id).maybeSingle();
  if(error) throw error;
  return data;
}

export async function listMonitorsForUser(username: string): Promise<Monitor[]> {
  const { data: user, error: userError } = await db.from('users').select('id').eq('username', username).maybeSingle();

  if(userError) throw userError;
  if (!user) return [];

  const { data, error } = await db
    .from('monitors')
    .select()
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if(error) throw error;
  return data;
}

export async function updateMonitor(id: string, input: UpdateMonitorInput): Promise<Monitor | null> {
  const existing = await getMonitor(id);
  if (!existing) return null;

  const patch: TablesUpdate<'monitors'> = {};

  if (input.name !== undefined) patch.name = input.name;
  if (input.url !== undefined) patch.url = input.url;
  if (input.intervalMinutes !== undefined) patch.interval_minutes = input.intervalMinutes;
  if (input.timeoutSeconds !== undefined) patch.timeout_seconds = input.timeoutSeconds;
  if (input.isPaused !== undefined) patch.is_paused = input.isPaused;

  const intervalChanged = patch.interval_minutes !== undefined && patch.interval_minutes !== existing.interval_minutes;
  const resuming = patch.is_paused === false && existing.is_paused === true;

  if (intervalChanged && patch.interval_minutes !== undefined) {
    patch.next_check_at = new Date(Date.now() + patch.interval_minutes * 60_000).toISOString();
  } else if (resuming) {
    patch.next_check_at = new Date().toISOString();
  }

  const { data, error } = await db.from('monitors').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteMonitor(id: string): Promise<boolean> {
  const { data, error } = await db
    .from('monitors')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
