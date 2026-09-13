/**
 * Runtime compatibility check — Supabase client construction.
 *
 * `@supabase/realtime-js` resolves its WebSocket constructor EAGERLY, inside
 * `createClient()`. On a runtime with no global `WebSocket` (Node.js 18/20)
 * it throws and the process dies while importing `src/config/supabase.js` —
 * before Express ever binds a port. That exact crash took the deploy down.
 *
 * This check imports the real clients in a runtime WITHOUT a native
 * WebSocket:
 *   • Node.js 21+  → started with `--no-experimental-websocket`
 *   • Node.js ≤ 20 → no global WebSocket exists by default, so a plain start
 *                    already reproduces the deployed condition.
 *
 * It is spawned by `scripts/check.js` (i.e. `npm run check`, the first step of
 * `npm test`) and can also be run standalone:
 *   node --no-experimental-websocket scripts/check-runtime.mjs
 */
process.env.SKIP_ENV_VALIDATION = 'true';

const { usingNativeWebSocket } = await import('../src/config/websocket.js');
const { supabaseAdmin, supabaseAnon, supabaseForUser } = await import('../src/config/supabase.js');

const hasNative = typeof globalThis.WebSocket !== 'undefined';
const failures = [];

for (const [name, client] of [
  ['supabaseAdmin', supabaseAdmin],
  ['supabaseAnon', supabaseAnon],
  ['supabaseForUser()', supabaseForUser('check-token')],
]) {
  if (!client || typeof client.from !== 'function') failures.push(name);
}

if (failures.length > 0) {
  console.error(`✗ Supabase client(s) failed to construct: ${failures.join(', ')}`);
  process.exit(1);
}

const mode = usingNativeWebSocket ? 'native WebSocket' : 'ws transport shim';
console.log(`✓ Supabase clients construct on Node ${process.versions.node} (${mode}).`);

if (hasNative && !usingNativeWebSocket) {
  console.log('  (this runtime exposes a native WebSocket — pass --no-experimental-websocket to check the shim path)');
}
