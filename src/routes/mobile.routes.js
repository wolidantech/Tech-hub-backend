import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { cacheMiddleware, mobileOptimizeMiddleware, timeoutMiddleware, requestIdMiddleware, fieldSelectionMiddleware } from '../middleware/mobile.js';
import * as mobileCourses from '../controllers/mobile-courses.controller.js';

const router = Router();

// Global mobile middleware
router.use(mobileOptimizeMiddleware);
router.use(requestIdMiddleware);
router.use(timeoutMiddleware(30000)); // 30s timeout for mobile

// Course listing — paginated, field selection, cached for public
router.get(
  '/courses',
  cacheMiddleware(60 * 1000), // 60s cache for public catalog
  fieldSelectionMiddleware(['id', 'title', 'slug', 'description', 'thumbnail_url', 'price', 'duration', 'difficulty_level', 'created_at']),
  mobileCourses.listCoursesMobile
);

// Course metadata only — no lessons (mobile optimized)
router.get(
  '/courses/:idOrSlug',
  optionalAuth,
  cacheMiddleware(60 * 1000),
  mobileCourses.getCourseMetadata
);

// Modules — paginated
router.get(
  '/courses/:idOrSlug/modules',
  optionalAuth,
  mobileCourses.listModulesMobile
);

// Topics per module — paginated metadata only
router.get(
  '/courses/:idOrSlug/modules/:moduleId/topics',
  authenticate,
  mobileCourses.listTopicsMobile
);

// Lessons per module — paginated metadata only (optional ?topic_id filter)
router.get(
  '/courses/:idOrSlug/modules/:moduleId/lessons',
  authenticate,
  mobileCourses.listLessonsMobile
);

// Individual lesson — metadata + progress
router.get(
  '/lessons/:lessonId',
  authenticate,
  mobileCourses.getLessonMobile
);

// Video delivery — efficient signed URL with range support
router.get(
  '/lessons/:lessonId/video',
  authenticate,
  mobileCourses.getLessonVideoMobile
);

// Resources — paginated with signed URLs
router.get(
  '/lessons/:lessonId/resources',
  authenticate,
  mobileCourses.getLessonResourcesMobile
);

export default router;
