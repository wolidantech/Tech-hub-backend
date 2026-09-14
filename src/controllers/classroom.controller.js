/**
 * WOLI DAN TECH HUB — Unified Classroom API (student-facing)
 *
 * ONE integration surface for the classroom. Frontend flow:
 *
 *   Course listing  → GET /api/courses (public catalog)
 *   Course details  → GET /api/classroom/:idOrSlug/outline (public outline)
 *   Enrollment      → POST /api/enrollments + POST /api/payments
 *   Classroom       → GET /api/classroom/:idOrSlug (gated, full curriculum)
 *   Quiz            → GET/POST /api/classroom/quizzes/:quizId[/attempts]
 *   Assignment      → GET/POST /api/classroom/assignments/:assignmentId[/submissions]
 *   Final exam      → GET /api/classroom/:idOrSlug/assessments
 *
 * Legacy endpoints (/api/learning/*, /api/courses/:id/lessons,
 * /api/courses/:id/content, /api/mobile/*) are preserved unchanged in
 * behaviour and now share the same curriculum service + status flags.
 */

import { asyncHandler } from '../utils/errors.js';
import { sanitizeFileName } from '../utils/helpers.js';
import * as curriculum from '../services/curriculum.service.js';

/** GET /api/classroom/:idOrSlug/outline — public curriculum outline */
export const getOutline = asyncHandler(async (req, res) => {
  const data = await curriculum.getCourseOutline(req.validatedParams.idOrSlug, req.profile || null);
  res.json({ success: true, data });
});

/** GET /api/classroom/:idOrSlug — full gated classroom payload */
export const getClassroom = asyncHandler(async (req, res) => {
  const course = await curriculum.resolveCourse(req.validatedParams.idOrSlug, { requirePublished: true });
  const data = await curriculum.getClassroom(course.id, req.profile);
  res.json({ success: true, data });
});

/** GET /api/classroom/:idOrSlug/assessments — finals + my attempts */
export const getAssessments = asyncHandler(async (req, res) => {
  const course = await curriculum.resolveCourse(req.validatedParams.idOrSlug, { requirePublished: true });
  const data = await curriculum.getAssessments(course.id, req.profile);
  res.json({ success: true, data });
});

/** GET /api/classroom/quizzes/:quizId — student-safe quiz (no answers) */
export const getQuiz = asyncHandler(async (req, res) => {
  const data = await curriculum.getStudentQuiz(req.validatedParams.quizId, req.profile);
  res.json({ success: true, data });
});

/** POST /api/classroom/quizzes/:quizId/attempts — submit answers, get graded */
export const submitQuiz = asyncHandler(async (req, res) => {
  const { answers, started_at } = req.validatedBody;
  const data = await curriculum.submitQuizAttempt(
    req.validatedParams.quizId,
    req.profile,
    answers,
    started_at ? new Date(started_at).toISOString() : null
  );
  res.status(201).json({
    success: true,
    message: data.passed ? 'Quiz passed — well done!' : 'Attempt recorded',
    data,
  });
});

/** GET /api/classroom/quizzes/:quizId/attempts — my attempt history */
export const getMyAttempts = asyncHandler(async (req, res) => {
  const data = await curriculum.getMyAttempts(req.validatedParams.quizId, req.profile);
  res.json({ success: true, data });
});

/** GET /api/classroom/assignments/:assignmentId — assignment + my submissions */
export const getAssignment = asyncHandler(async (req, res) => {
  const data = await curriculum.getAssignment(req.validatedParams.assignmentId, req.profile);
  res.json({ success: true, data });
});

/**
 * POST /api/classroom/assignments/:assignmentId/submissions
 * multipart/form-data: optional "file" + optional "submission_text" field.
 */
export const submitAssignment = asyncHandler(async (req, res) => {
  const submissionText =
    typeof req.body?.submission_text === 'string' ? req.body.submission_text : undefined;
  const data = await curriculum.createSubmission(req.validatedParams.assignmentId, req.profile, {
    submissionText,
    file: req.file
      ? {
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          originalname: sanitizeFileName(req.file.originalname),
        }
      : null,
  });
  res.status(201).json({ success: true, message: 'Assignment submitted', data });
});
