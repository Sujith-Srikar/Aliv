import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../shared/env';
import type { Database } from './database.types';

let client: SupabaseClient<Database> | undefined;

// Server-only client bound to the service-role key. Never exposed to the
// browser (no PUBLIC_ prefix), so it only ever runs inside API/SSR code.
export function getDb(): SupabaseClient<Database> {
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
