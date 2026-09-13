/**
 * WOLI DAN TECH HUB — Secure AI Gateway (Express app).
 *
 * Exposes exactly three routes:
 *   GET  /health              (public, Railway healthcheck)
 *   POST /api/ai/generate     (admin only)
 *   POST /api/dantech/chat    (any authenticated student)
 */
import { createHash } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { createRateLimiter } from './ratelimit.js';
import { createGenerateHandler } from './generate.controller.js';
import { createChatHandler } from './chat.controller.js';
import { DANTECH_NAME, PLATFORM } from './config.js';

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Short, non-reversible tag so logs can be correlated without storing PII. */
function logId(userId) {
  return userId ? createHash('sha256').update(String(userId)).digest('hex').slice(0, 10) : null;
}

export function createApp(deps) {
  const { config, provider, supabase, auth, logger = console } = deps;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // ---- Security headers (no CSP needed: this API only serves JSON) ----
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // ---- CORS: only the origins listed in ALLOWED_ORIGINS ----
  const allowed = new Set(config.allowedOrigins);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // curl / server-to-server
        if (allowed.has(origin.replace(/\/+$/, ''))) return callback(null, true);
        return callback(Object.assign(new Error('Origin not allowed'), { status: 403, code: 'CORS_BLOCKED' }));
      },
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    })
  );

  app.use(express.json({ limit: '256kb' }));

  // ---- Request log: method, path, status, duration. No bodies, no tokens. ----
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.info?.({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        uid: logId(req.userId),
      });
    });
    next();
  });

  // ---- Health (public) ----
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'woli-dan-tech-hub-ai-gateway', time: new Date().toISOString(), provider: provider.name });
  });

  app.get('/', (_req, res) => {
    res.json({
      name: `${PLATFORM} — Secure AI Gateway`,
      assistant: DANTECH_NAME,
      endpoints: ['GET /health', 'POST /api/ai/generate (admin)', 'POST /api/dantech/chat (authenticated)'],
    });
  });

  // ---- Rate limiters (keyed by authenticated user id) ----
  const generateLimiter = createRateLimiter({
    limit: config.generateRateLimit,
    windowMs: config.rateWindowMs,
    name: 'GENERATE_RATE_LIMITED',
  });
  const chatLimiter = createRateLimiter({
    limit: config.chatRateLimit,
    windowMs: config.rateWindowMs,
    name: 'CHAT_RATE_LIMITED',
  });

  const generate = createGenerateHandler({ provider, config, logger });
  const chat = createChatHandler({ provider, supabase, config, logger });

  // ---- Routes ----
  app.post(
    '/api/ai/generate',
    auth.requireAuth(),
    auth.requireAdmin,
    generateLimiter,
    asyncHandler(generate)
  );

  app.post(
    '/api/dantech/chat',
    auth.requireAuth(),
    chatLimiter,
    asyncHandler(chat)
  );

  // ---- 404 + error handling (never leak internals) ----
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found', message: 'That endpoint does not exist on the AI gateway.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, next) => {
    const status = err?.status || 500;
    if (status >= 500) logger.error?.({ error: err?.message, code: err?.code });
    res.status(status).json({
      error: status === 403 ? 'Forbidden' : status >= 500 ? 'Internal error' : 'Bad request',
      message: status >= 500 ? 'Something went wrong on our side. Please try again.' : err?.message || 'Invalid request.',
      code: err?.code || 'ERROR',
    });
  });

  return app;
}

export default createApp;
