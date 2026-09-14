import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './config/env.js';
import { ApiError } from './utils/errors.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

import authRoutes from './routes/auth.routes.js';
import profileRoutes from './routes/profile.routes.js';
import catalogRoutes from './routes/catalog.routes.js';
import paymentsRoutes from './routes/payments.routes.js';
import learningRoutes from './routes/learning.routes.js';
import certificatesRoutes from './routes/certificates.routes.js';
import notificationsRoutes from './routes/notifications.routes.js';
import adminRoutes from './routes/admin.routes.js';
import publicRoutes from './routes/public.routes.js';
import aiContentRoutes from './routes/ai-content.routes.js';
import adminContentRoutes from './routes/admin-content.routes.js';
import courseContentRoutes from './routes/course-content.routes.js';
import cvRoutes from './routes/cv.routes.js';
import subjectsRoutes from './routes/subjects.routes.js';
import occupationsRoutes from './routes/occupations.routes.js';
import aiChatRoutes from './routes/ai-chat.routes.js';
import mobileRoutes from './routes/mobile.routes.js';
import mobileUploadsRoutes from './routes/mobile-uploads.routes.js';
import classroomRoutes from './routes/classroom.routes.js';
import adminCurriculumRoutes from './routes/admin-curriculum.routes.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security headers
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// CORS — only whitelisted frontends may call the API with credentials.
// The Arena/e2b live-preview hosts are allowed for development.
const allowedOrigins = new Set(env.frontendUrls);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // curl / server-to-server
      const isPreviewHost = /^https:\/\/[\w-]+\.e2b\.app$/.test(origin) && !env.isProduction;
      if (allowedOrigins.has(origin) || isPreviewHost) return callback(null, true);
      return callback(ApiError.forbidden('This origin is not allowed to access the API', 'CORS_BLOCKED'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

if (!env.isProduction) app.use(morgan('dev'));
else app.use(morgan('combined'));

app.use('/api', apiLimiter);

// Health + root
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'woli-dan-tech-hub-backend', time: new Date().toISOString() });
});
app.get('/', (_req, res) => {
  res.json({
    name: 'WOLI DAN TECH HUB API',
    tagline: 'LEARN • BUILD • GROW',
    version: '1.0.0',
    docs: 'See README.md for the full API reference',
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api', catalogRoutes); // /api/courses, /api/course-categories, /api/catalog-status
app.use('/api', paymentsRoutes); // /api/enrollments, /api/payments, /api/coupons
app.use('/api', courseContentRoutes); // /api/courses/:courseId/content, /api/courses/:courseId/modules, /api/lessons/:lessonId
app.use('/api/ai', aiContentRoutes); // /api/ai/courses/generate, /api/ai/lessons/generate, etc. (admin)
app.use('/api/cv', cvRoutes); // /api/cv/create, /api/cv/preview, /api/cv/export, /api/cv/ai/improve, /api/cv/templates, /api/cv/occupations/search (public + optionalAuth)
app.use('/api/subjects', subjectsRoutes); // /api/subjects/fields, /api/subjects/taxonomy (public)
app.use('/api/occupations', occupationsRoutes); // /api/occupations/search, /api/occupations/categories (public)
app.use('/api/dantech', aiChatRoutes); // /api/dantech/chat, /api/dantech/chat/stream, /api/dantech/conversations, /api/dantech/files, /api/dantech/research (authenticated)
app.use('/api/mobile', mobileRoutes); // /api/mobile/courses, /api/mobile/courses/:id/modules, /api/mobile/lessons/:id/video (mobile-optimized pagination, field selection, lazy loading)
app.use('/api/mobile/uploads', mobileUploadsRoutes); // /api/mobile/uploads/single, /init, /chunk, /session/:id (resumable, progress, retry, timeout handling)
app.use('/api/learning', learningRoutes);
app.use('/api/classroom', classroomRoutes); // unified classroom: outline, gated classroom, quizzes, assignments, assessments
app.use('/api/certificates', certificatesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminContentRoutes); // /api/admin/content, /api/admin/resources (admin review pipeline)
app.use('/api/admin', adminCurriculumRoutes); // /api/admin topics, contents, assignments, quizzes, assessments, publish
app.use('/api/admin/subjects', subjectsRoutes); // admin subjects management re-uses same router with auth
app.use('/api/public', publicRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
