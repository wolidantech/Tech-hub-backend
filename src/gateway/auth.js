/**
 * Authentication & authorisation.
 *
 * Token verification goes through the Supabase Auth API (`/auth/v1/user`) —
 * the official verification path. Nothing here parses or validates a JWT by
 * hand, so signing-key rotation and revocation are handled by Supabase.
 * Verified results are cached briefly (60s) to avoid a round-trip per request.
 *
 * Roles are ALWAYS read from `profiles` server-side. Claims inside the token
 * are never trusted for authorisation.
 */
import { createHash } from 'node:crypto';
import { isKnownKind, isStudentKind } from './kinds.js';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extractBearer(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function createAuth({ supabaseUrl, serviceKey, supabase, fetchImpl = globalThis.fetch, cacheTtlMs = CACHE_TTL_MS }) {
  const base = String(supabaseUrl).replace(/\/+$/, '');
  const cache = new Map();

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      cache.delete(key);
      return null;
    }
    return hit.value;
  }

  function cacheSet(key, value) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs });
  }

  /**
   * @returns {Promise<{ok:true, user:object}|{ok:false, reason:string, status?:number}>}
   */
  async function verifyToken(token) {
    if (!token) return { ok: false, reason: 'missing_token' };
    const key = sha256(token);
    const cached = cacheGet(key);
    if (cached) return cached;

    let res;
    try {
      res = await fetchImpl(`${base}/auth/v1/user`, {
        method: 'GET',
        headers: { apikey: serviceKey, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch {
      return { ok: false, reason: 'auth_unavailable', status: 503 };
    }

    if (res.status === 401 || res.status === 403) {
      const result = { ok: false, reason: 'invalid_token' };
      cacheSet(key, result);
      return result;
    }
    if (!res.ok) return { ok: false, reason: 'auth_unavailable', status: 503 };

    const user = await res.json().catch(() => null);
    if (!user?.id) return { ok: false, reason: 'invalid_token' };

    const result = { ok: true, user };
    cacheSet(key, result);
    return result;
  }

  /** Resolve the caller's role from `profiles` (never from the token). */
  async function resolveRole(userId) {
    try {
      const profile = await supabase.getProfile(userId);
      return { role: profile?.role || null, profile };
    } catch {
      return { role: null, profile: null };
    }
  }

  /** Express middleware: requires a valid Supabase session. */
  function requireAuth(handler) {
    return async (req, res, next) => {
      const token = extractBearer(req);
      if (!token) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing Authorization header. Send: Authorization: Bearer <supabase access token>',
        });
      }
      const verdict = await verifyToken(token);
      if (!verdict.ok) {
        const status = verdict.status || 401;
        return res.status(status).json({
          error: status === 401 ? 'Unauthorized' : 'Service unavailable',
          message:
            status === 401
              ? 'Your session is invalid or has expired. Please sign in again.'
              : 'We could not verify your session right now. Please try again in a moment.',
        });
      }
      req.authUser = verdict.user;
      req.userId = verdict.user.id;
      return handler ? handler(req, res, next) : next();
    };
  }

  /**
   * Express middleware for POST /api/ai/generate: students may use the Study
   * Tools kinds (flashcards, notes, summary, exercise); every other KNOWN kind
   * requires profiles.role === 'admin'. Unknown/missing kinds pass through so
   * the handler returns its uniform 400 (no role probing via status codes).
   * Must run after requireAuth (needs req.userId for the role lookup).
   */
  function requireAdminForProtectedKind(req, res, next) {
    const kind = req.body?.kind;
    if (isStudentKind(kind)) return next();
    if (!isKnownKind(kind)) return next(); // handler answers 400 for everyone
    return requireAdmin(req, res, next,
      `The "${kind}" generator is restricted to administrators. ` +
      'Students can use Study Tools: flashcards, study notes, summary and practice.'
    );
  }

  /** Express middleware: requires profiles.role === 'admin'. */
  function requireAdmin(req, res, next, message) {
    resolveRole(req.userId)
      .then(({ role, profile }) => {
        if (role !== 'admin') {
          return res.status(403).json({
            error: 'Forbidden',
            message: message || 'AI Studio generation is restricted to administrators.',
          });
        }
        req.profile = profile;
        req.role = role;
        return next();
      })
      .catch(() =>
        res.status(503).json({ error: 'Service unavailable', message: 'Could not confirm your role. Please try again.' })
      );
  }

  return { verifyToken, resolveRole, requireAuth, requireAdmin, requireAdminForProtectedKind, extractBearer };
}

export default createAuth;
