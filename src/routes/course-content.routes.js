import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import * as courseContent from '../controllers/course-content.controller.js';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';

const router = Router();

const courseIdParam = z.object({ courseId: z.string().min(1) });
const lessonIdParam = z.object({ lessonId: z.string().uuid() });

// Public / optional auth: complete curriculum (only APPROVED/PUBLISHED)
router.get('/courses/:courseId/content', optionalAuth, validate({ params: courseIdParam }), courseContent.getCourseContent);
router.get('/courses/:courseId/modules', optionalAuth, validate({ params: courseIdParam }), courseContent.getCourseModules);

// Student gated: full lesson detail requires ACTIVE enrollment
router.get('/lessons/:lessonId', authenticate, validate({ params: lessonIdParam }), courseContent.getLessonDetail);

export default router;
