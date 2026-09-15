/**
 * WOLI DAN TECH HUB — Secure AI Gateway (Express app).
 *
 * Exposes exactly three routes:
 *   GET  /health              (public, Railway healthcheck)
 *   POST /api/ai/generate     (Study Tools kinds for any authenticated user,
 *                              every other kind admin only — see auth.js)
 *   POST /api/dantech/chat    (any authenticated student)
 */
import { createHash } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { createRateLimiter } from './ratelimit.js';
import { createGenerateHandler } from './generate.controller.js';
import { createChatHandler, createChatStreamHandler } from './chat.controller.js';
import { createAiContentHandlers } from './ai-content.controller.js';
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

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ---- Request log: method, path, status, duration. No bodies, no tokens. ----
  app.use((req, res, next) => {
    const started = Date.now();
    // Mobile detection
    const ua = req.headers['user-agent'] || '';
    req.isMobile = /Mobile|Android|iPhone|iPad/i.test(ua) || req.headers['x-mobile'] === 'true';
    req.requestId = req.headers['x-request-id'] || req.headers['x-idempotency-key'] || null;

    // Timeout handling for mobile slow connections — 30s
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          success: false,
          error: { code: 'REQUEST_TIMEOUT', message: 'Request timed out, please retry' },
        });
      }
    }, 30000);

    res.on('finish', () => {
      clearTimeout(timeout);
      logger.info?.({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        uid: logId(req.userId),
        mobile: req.isMobile,
        requestId: req.requestId,
      });
    });
    res.on('close', () => {
      clearTimeout(timeout);
      // Connection interrupted — do not corrupt conversation, log only
      if (!res.writableFinished) {
        logger.warn?.({ route: req.path, outcome: 'connection_interrupted', mobile: req.isMobile });
      }
    });
    next();
  });

  // ---- Health (public) ----
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'woli-dan-tech-hub-ai-gateway', time: new Date().toISOString(), provider: provider.name });
  });

  app.get('/', (_req, res) => {
    res.json({
      name: `${PLATFORM} — Secure AI Gateway + Course Content Engine + CV Builder + Advanced DanTECH AI`,
      assistant: DANTECH_NAME,
      endpoints: [
        'GET /health',
        'POST /api/ai/generate (students: flashcards/notes/summary/exercise; all other kinds admin-only)',
        'POST /api/ai/courses/generate (admin) — full curriculum DRAFT',
        'POST /api/ai/courses/:courseId/populate (admin)',
        'POST /api/ai/lessons/generate (admin)',
        'POST /api/ai/quizzes/generate (admin)',
        'POST /api/ai/assignments/generate (admin)',
        'POST /api/ai/practicals/generate (admin)',
        'POST /api/ai/video/generate (admin) — QUEUED/PROCESSING/COMPLETED/FAILED',
        'GET /api/ai/jobs/:jobId (admin/owner)',
        'GET /api/ai/jobs (admin)',
        'POST /api/ai/bulk/generate-missing (admin)',
        'POST /api/dantech/chat (authenticated) — course-aware RAG, modes GENERAL/STUDY/CODING/RESEARCH/CAREER/DEEP_EXPLANATION',
        'POST /api/dantech/chat/stream (authenticated) — SSE streaming',
      ],
      pipeline: 'GENERATE → DRAFT → REVIEW → APPROVE → PUBLISH (never auto-publish)',
      modes: ['GENERAL', 'STUDY', 'CODING', 'RESEARCH', 'CAREER', 'DEEP_EXPLANATION'],
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
  const chatStream = createChatStreamHandler({ provider, supabase, config, logger });
  const aiContent = createAiContentHandlers({ logger });

  // ---- Routes ----
  // Existing AI Studio + DanTECH
  app.post(
    '/api/ai/generate',
    auth.requireAuth(),
    auth.requireAdminForProtectedKind,
    generateLimiter,
    asyncHandler(generate)
  );

  app.post(
    '/api/dantech/chat',
    auth.requireAuth(),
    chatLimiter,
    asyncHandler(chat)
  );

  // Advanced DanTECH AI — streaming, modes, course-aware
  app.post(
    '/api/dantech/chat/stream',
    auth.requireAuth(),
    chatLimiter,
    asyncHandler(chatStream)
  );

  // --- New production course content generation (spec sections 3, 6, 25-27, 30) ---
  // All admin-only, all DRAFT, never auto-publish
  app.post('/api/ai/courses/generate', auth.requireAuth(), auth.requireAdmin, generateLimiter, asyncHandler(aiContent.generateCourse));
  app.post('/api/ai/courses/:courseId/populate', auth.requireAuth(), auth.requireAdmin, generateLimiter, asyncHandler(aiContent.populateCourse));
  app.post('/api/ai/lessons/generate', auth.requireAuth(), auth.requireAdmin, generateLimiter, asyncHandler(aiContent.generateLesson));
  app.post('/api/ai/quizzes/generate', auth.requireAuth(), auth.requireAdmin, generateLimiter, asyncHandler(aiContent.generateQuiz));
  app.post('/api/ai/assignments/generate', auth.requireAuth(), auth.requireAdmin, generateLimiter, asyncHandler(aiContent.generateAssignment));
  app.post('/api/ai/practicals/generate', auth.requireAuth(), auth.requireAdmin, generateLimiter, asyncHandler(aiContent.generatePractical));
  app.post('/api/ai/video/generate', auth.requireAuth(), auth.requireAdmin, generateLimiter, asyncHandler(aiContent.generateVideo));
  app.get('/api/ai/jobs/:jobId', auth.requireAuth(), asyncHandler(aiContent.getJob));
  app.get('/api/ai/jobs', auth.requireAuth(), asyncHandler(aiContent.listJobs));
  app.post('/api/ai/bulk/generate-missing', auth.requireAuth(), auth.requireAdmin, generateLimiter, asyncHandler(aiContent.bulkGenerateMissing));

  // ---- 404 + error handling (never leak internals) — consistent machine-readable format for mobile ----
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'ROUTE_NOT_FOUND', message: 'That endpoint does not exist on the AI gateway.' },
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, next) => {
    const status = err?.status || 500;
    if (status >= 500) logger.error?.({ error: err?.message, code: err?.code });
    res.status(status).json({
      success: false,
      error: {
        code: err?.code || (status === 403 ? 'FORBIDDEN' : status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
        message: status >= 500 ? 'Something went wrong on our side. Please try again.' : err?.message || 'Invalid request.',
      },
    });
  });

  return app;
}

export default createApp;
