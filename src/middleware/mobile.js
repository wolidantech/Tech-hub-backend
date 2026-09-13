/**
 * WOLI DAN TECH HUB — Mobile/API Compatibility Middleware
 * Per spec 33: support mobile networks, 4G/5G, slower/intermittent connections
 * Features: pagination, field selection, response size optimization, caching, compression hints
 */

import { ApiError } from '../utils/errors.js';

// ------------------------------------------------------------------
// Pagination — supports page/limit and cursor pagination
// ------------------------------------------------------------------
export function parseMobilePagination(req, defaultLimit = 20, maxLimit = 50) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let limit = parseInt(req.query.limit, 10) || defaultLimit;
  limit = Math.min(Math.max(1, limit), maxLimit);
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  const cursor = req.query.cursor || null;
  const offset = cursor ? parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10) || 0 : from;

  return { page, limit, from, to, offset, cursor };
}

export function buildCursorPagination({ data, limit, offset, total }) {
  const hasMore = data.length === limit;
  const nextCursor = hasMore ? Buffer.from(String(offset + limit)).toString('base64') : null;
  return {
    pagination: {
      limit,
      offset,
      total: total || null,
      has_more: hasMore,
      next_cursor: nextCursor,
    },
  };
}

// ------------------------------------------------------------------
// Field selection — ?fields=id,title,slug
// ------------------------------------------------------------------
export function applyFieldSelection(data, allowedFields, requestedFields) {
  if (!requestedFields) return data;
  const fields = requestedFields.split(',').map(f => f.trim()).filter(f => allowedFields.includes(f));
  if (fields.length === 0) return data;

  const pick = (obj) => {
    const out = {};
    for (const f of fields) if (f in obj) out[f] = obj[f];
    return out;
  };

  return Array.isArray(data) ? data.map(pick) : pick(data);
}

export function fieldSelectionMiddleware(allowedFields) {
  return (req, _res, next) => {
    const fields = req.query.fields;
    if (fields) {
      const requested = fields.split(',').map(f => f.trim()).filter(Boolean);
      const invalid = requested.filter(f => !allowedFields.includes(f));
      if (invalid.length > 0) {
        return next(ApiError.badRequest(`Invalid fields: ${invalid.join(', ')}. Allowed: ${allowedFields.join(', ')}`, 'INVALID_FIELDS'));
      }
      req.selectedFields = requested;
    }
    next();
  };
}

// ------------------------------------------------------------------
// Response size optimization — strip heavy fields for mobile
// ------------------------------------------------------------------
export function mobileOptimizeMiddleware(req, _res, next) {
  // Detect mobile via User-Agent or explicit header
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua) || req.headers['x-mobile'] === 'true';
  req.isMobile = isMobile;

  // Client can request minimal response via ?minimal=true
  req.minimal = req.query.minimal === 'true' || req.headers['x-minimal'] === 'true';

  next();
}

// ------------------------------------------------------------------
// Caching — simple in-memory cache for public endpoints (safe, no PII)
// ------------------------------------------------------------------
const cache = new Map();
const CACHE_TTL = 60 * 1000; // 60s default

export function cacheMiddleware(ttlMs = CACHE_TTL) {
  return (req, res, next) => {
    // Only cache GET public requests, no auth, no user-specific
    if (req.method !== 'GET' || req.headers.authorization) return next();
    if (req.query.fields || req.query.minimal) return next(); // Don't cache field-selected

    const key = `${req.path}?${JSON.stringify(req.query)}`;
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < ttlMs) {
      res.set('X-Cache', 'HIT');
      return res.json(entry.data);
    }

    const originalJson = res.json.bind(res);
    res.json = (data) => {
      // Only cache success responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(key, { data, ts: Date.now() });
        // Prune old entries
        if (cache.size > 200) {
          const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
          if (oldest) cache.delete(oldest[0]);
        }
      }
      res.set('X-Cache', 'MISS');
      return originalJson(data);
    };
    next();
  };
}

// ------------------------------------------------------------------
// Timeout handling — for mobile slow connections
// ------------------------------------------------------------------
export function timeoutMiddleware(ms = 30000) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          success: false,
          error: { code: 'REQUEST_TIMEOUT', message: 'Request timed out, please retry' },
        });
      }
    }, ms);

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  };
}

// ------------------------------------------------------------------
// Request ID for idempotency and retry handling
// ------------------------------------------------------------------
export function requestIdMiddleware(req, _res, next) {
  req.requestId = req.headers['x-request-id'] || req.headers['x-idempotency-key'] || null;
  next();
}
