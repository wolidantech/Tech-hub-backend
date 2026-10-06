import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as jamb from '../controllers/jamb.controller.js';
import {
  jambExamIdParams,
  jambAttemptIdParams,
  listJambExamsQuery,
  listPastQuestionsQuery,
  startJambAttemptSchema,
  startJambPaperSchema,
  submitJambPaperSchema,
  saveJambAnswersSchema,
} from '../validation/jamb.schemas.js';

const router = Router();
const startAttemptParams = z.object({ examId: z.string().uuid('Invalid exam identifier') });

// Public catalogue metadata and published mock/practice exam templates.
router.get('/subjects', jamb.listSubjects);
router.get('/exams', validate({ query: listJambExamsQuery }), jamb.listExams);

// Released past questions for revision browsing. Holds the same paid-pass gate
// as starting an exam, and never returns answer keys or explanations.
router.get(
  '/past-questions',
  authenticate,
  validate({ query: listPastQuestionsQuery }),
  jamb.listPastQuestions
);

// Attempts require an authenticated student. The backend re-checks paid
// entitlement and never accepts a client-supplied student/profile ID.
router.get('/attempts', authenticate, jamb.listMyAttempts);
// Stable frontend contract: server resolves a reviewed template from subject
// IDs, mode and requested length; no exam/table IDs are selected by the client.
router.post(
  '/attempts',
  authenticate,
  validate({ body: startJambPaperSchema }),
  jamb.startPaper
);
router.post(
  '/exams/:examId/attempts',
  authenticate,
  validate({ params: startAttemptParams, body: startJambAttemptSchema }),
  jamb.startAttempt
);
router.get('/attempts/:attemptId', authenticate, validate({ params: jambAttemptIdParams }), jamb.getAttempt);
router.put(
  '/attempts/:attemptId/answers',
  authenticate,
  validate({ params: jambAttemptIdParams, body: saveJambAnswersSchema }),
  jamb.saveAnswers
);
router.post(
  '/attempts/:attemptId/submit',
  authenticate,
  validate({ params: jambAttemptIdParams, body: submitJambPaperSchema }),
  jamb.submitAttempt
);

export default router;
