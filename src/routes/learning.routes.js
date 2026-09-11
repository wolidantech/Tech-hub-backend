import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as learning from '../controllers/learning.controller.js';
import * as payments from '../controllers/payments.controller.js';
import { lessonProgressSchema, uuidParams } from '../validation/schemas.js';

const router = Router();

router.use(authenticate);

const lessonParams = z.object({ lessonId: z.string().uuid('Invalid lesson identifier') });

// get-my-courses (alias of /api/enrollments/me)
router.get('/my-courses', payments.getMyCourses);

// Course player + per-course progress
router.get('/courses/:id', validate({ params: uuidParams }), learning.getLearningCourse);
router.get('/courses/:id/progress', validate({ params: uuidParams }), learning.getProgress);

// Single lesson + mark complete / save position
router.get('/lessons/:lessonId', validate({ params: lessonParams }), learning.getLesson);
router.post(
  '/lessons/:lessonId/progress',
  validate({ params: lessonParams, body: lessonProgressSchema }),
  learning.saveLessonProgress
);

export default router;
