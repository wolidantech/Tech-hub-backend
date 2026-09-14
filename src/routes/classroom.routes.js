import { Router } from 'express';
import { z } from 'zod';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { resourceUpload } from '../middleware/upload.js';
import * as classroom from '../controllers/classroom.controller.js';
import { submitQuizAttemptSchema } from '../validation/schemas.js';

const router = Router();

const idOrSlugParams = z.object({ idOrSlug: z.string().trim().min(1).max(200) });
const quizParams = z.object({ quizId: z.string().uuid('Invalid quiz identifier') });
const assignmentParams = z.object({ assignmentId: z.string().uuid('Invalid assignment identifier') });

// Public outline (safe columns only; per-user context when authenticated)
router.get('/:idOrSlug/outline', optionalAuth, validate({ params: idOrSlugParams }), classroom.getOutline);

// Full classroom — gated by ACTIVE/COMPLETED enrollment (or admin/instructor)
router.get('/:idOrSlug', authenticate, validate({ params: idOrSlugParams }), classroom.getClassroom);
router.get(
  '/:idOrSlug/assessments',
  authenticate,
  validate({ params: idOrSlugParams }),
  classroom.getAssessments
);

// Quizzes — answers are always stripped; grading is server-side
router.get('/quizzes/:quizId', authenticate, validate({ params: quizParams }), classroom.getQuiz);
router.post(
  '/quizzes/:quizId/attempts',
  authenticate,
  validate({ params: quizParams, body: submitQuizAttemptSchema }),
  classroom.submitQuiz
);
router.get(
  '/quizzes/:quizId/attempts',
  authenticate,
  validate({ params: quizParams }),
  classroom.getMyAttempts
);

// Assignments
router.get(
  '/assignments/:assignmentId',
  authenticate,
  validate({ params: assignmentParams }),
  classroom.getAssignment
);
router.post(
  '/assignments/:assignmentId/submissions',
  authenticate,
  validate({ params: assignmentParams }),
  resourceUpload.single('file'),
  classroom.submitAssignment
);

export default router;
