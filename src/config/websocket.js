/**
 * WebSocket transport for the Supabase clients.
 *
 * Why this file exists
 * --------------------
 * `@supabase/supabase-js` builds a Realtime client inside `createClient()`,
 * and `@supabase/realtime-js` (since v2.79) resolves its WebSocket
 * constructor EAGERLY, at construction time — not when you subscribe.
 *
 * On any runtime without a global `WebSocket` — Node.js 18 and 20, which is
 * what this service was deploying on (Node.js v18.20.8) — that resolution
 * throws before Express ever binds a port:
 *
 *     Error: Node.js detected but native WebSocket not found.
 *     Suggested solution: Ensure you are running Node.js 22+ or provide a
 *     WebSocket implementation via the transport option.
 *       at WebSocketFactory.getWebSocketConstructor (...)
 *       at RealtimeClient._initializeOptions (...)
 *       at new SupabaseClient (...)
 *
 * The process dies on import of `src/config/supabase.js`, which the gateway
 * pulls in through its service layer — so the deploy crash-looped forever.
 *
 * Node.js 22+ ships a native WebSocket: we use it and pass nothing. On older
 * runtimes we hand realtime-js the `ws` implementation through the documented
 * `transport` option, which is Supabase's own recommended workaround
 * (see https://github.com/orgs/supabase/discussions/37869).
 *
 * The long-term fix is to run Node.js 22+ (see `engines` / `.nvmrc`). This
 * shim keeps the service bootable on the runtimes it may still be deployed
 * to, so a stale Node image degrades to a warning instead of a crash loop.
 */
import ws from 'ws';

/** The runtime's own WebSocket (Node.js 22+, browsers, Deno, Bun) — preferred. */
const native = typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : null;

/** `ws` exports the class as `module.exports` and also as `module.exports.default`. */
const polyfill = typeof ws === 'function' ? ws : (ws && ws.default) || null;

/** The implementation actually in use, or `null` if the runtime has none. */
export const webSocketImpl = native ?? polyfill;

/** True when the native implementation is used (no shim needed). */
export const usingNativeWebSocket = Boolean(native);

/**
 * Options to spread into `createClient()` so Realtime can always construct.
 *
 * Returns `{}` on Node.js 22+ (native WebSocket) so the library keeps using
 * its default path, and `{ realtime: { transport } }` everywhere else — the
 * `transport` key belongs *inside* the `realtime` options object, which is
 * how `createClient()` forwards it to the RealtimeClient.
 */
export function realtimeOptions() {
  if (native) return {};
  if (!polyfill) {
    // Nothing to hand over. Let realtime-js raise its own (clearer) error
    // rather than masking the real problem here.
    return {};
  }
  return { realtime: { transport: polyfill } };
}

export default realtimeOptions;
