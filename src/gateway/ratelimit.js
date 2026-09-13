/**
 * Per-user rate limiting (fixed window, in-memory).
 *
 * Keyed by the AUTHENTICATED user id, not by IP, because Railway sits behind
 * a proxy and every request would otherwise share one address.
 */

export function createRateLimiter({ limit, windowMs, name = 'rate_limit', now = () => Date.now() }) {
  const hits = new Map();

  function middleware(req, res, next) {
    const key = req.userId || req.ip || 'anonymous';
    const t = now();
    const bucket = hits.get(key);

    if (!bucket || t >= bucket.resetAt) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      // Opportunistic cleanup keeps memory bounded.
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
      }
      return next();
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests',
        message: `Rate limit reached (${limit} requests per minute). Please wait ${retryAfter}s.`,
        code: name,
        retryAfterSeconds: retryAfter,
      });
    }
    return next();
  }

  /** Test hook. */
  middleware.reset = () => hits.clear();
  return middleware;
}

export default createRateLimiter;
