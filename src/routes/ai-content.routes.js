import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as aiCourses from '../controllers/ai-courses.controller.js';
import { z } from 'zod';
import { uuidParams } from '../validation/schemas.js';

const router = Router();

// All AI generation requires admin (per spec, students cannot generate unlimited content)
router.use(authenticate, requireAdmin);

const courseIdParam = z.object({ courseId: z.string().min(1) });
const jobIdParam = z.object({ jobId: z.string().uuid() });

// Course generation
router.post('/courses/generate', aiCourses.generateCourse);
router.post('/courses/:courseId/populate', validate({ params: courseIdParam }), aiCourses.populateCourse);

// Lesson / quiz / assignment / practical / video generation
router.post('/lessons/generate', aiCourses.generateLesson);
router.post('/quizzes/generate', aiCourses.generateQuiz);
router.post('/assignments/generate', aiCourses.generateAssignment);
router.post('/practicals/generate', aiCourses.generatePractical);
router.post('/video/generate', aiCourses.generateVideo);

// Jobs
router.get('/jobs/:jobId', validate({ params: jobIdParam }), aiCourses.getJob);
router.get('/jobs', aiCourses.listJobs);
router.post('/bulk/generate-missing', aiCourses.bulkGenerateMissing);

export default router;
