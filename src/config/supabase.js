import { createClient } from '@supabase/supabase-js';
import { realtimeOptions } from './websocket.js';
import { env } from './env.js';

/**
 * Realtime needs a WebSocket constructor at CONSTRUCTION time, which throws
 * on Node.js < 22 unless one is supplied. `realtimeOptions()` returns the
 * `ws` transport there and nothing on Node.js 22+ (native WebSocket).
 * See src/config/websocket.js for the full crash history.
 */
const realtime = () => realtimeOptions();

const authOptions = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
};

/**
 * Service-role client — SERVER ONLY.
 * Bypasses RLS. Used for privileged operations the API has already
 * authorized (admin actions, storage uploads, signed URLs, system
 * writes). NEVER expose this client or its key to the frontend.
 */
export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { ...authOptions },
  ...realtime(),
});

/**
 * Anonymous/public client — safe public surface (respects RLS).
 * Used for public catalog reads and auth flows (login/password reset).
 */
export const supabaseAnon = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { ...authOptions },
  ...realtime(),
});

/**
 * Creates a client bound to a specific end-user JWT so that every
 * query is executed under THAT user's RLS policies. Defense in depth:
 * the API also performs explicit authorization checks.
 */
export function supabaseForUser(accessToken) {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { ...authOptions },
    ...realtime(),
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}
