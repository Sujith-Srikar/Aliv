import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../shared/env';
import type { Database } from '../types';

let client: SupabaseClient<Database> | undefined;

function getDb(): SupabaseClient<Database> {
  if (!client) {
    client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

export const db = getDb();