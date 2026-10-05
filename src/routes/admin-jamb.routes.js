import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as jamb from '../controllers/jamb.controller.js';
import {
  jambExamAdminIdParams,
  jambQuestionIdParams,
  jambSubjectIdParams,
  createJambSubjectSchema,
  updateJambSubjectSchema,
  createJambSyllabusVersionSchema,
  createJambExamSchema,
  updateJambExamSchema,
  importJambQuestionsSchema,
  updateJambQuestionSchema,
  listJambQuestionsQuery,
} from '../validation/jamb.schemas.js';

const router = Router();
router.use(authenticate, requireAdmin);

router.get('/subjects', jamb.adminListSubjects);
router.post('/subjects', validate({ body: createJambSubjectSchema }), jamb.adminCreateSubject);
router.patch(
  '/subjects/:subjectId',
  validate({ params: jambSubjectIdParams, body: updateJambSubjectSchema }),
  jamb.adminUpdateSubject
);

router.get('/syllabuses', jamb.adminListSyllabuses);
router.post('/syllabuses', validate({ body: createJambSyllabusVersionSchema }), jamb.adminCreateSyllabus);

router.get('/exams', jamb.adminListExams);
router.post('/exams', validate({ body: createJambExamSchema }), jamb.adminCreateExam);
router.patch(
  '/exams/:examId',
  validate({ params: jambExamAdminIdParams, body: updateJambExamSchema }),
  jamb.adminUpdateExam
);

router.get('/questions', validate({ query: listJambQuestionsQuery }), jamb.adminListQuestions);
router.post('/questions/import', validate({ body: importJambQuestionsSchema }), jamb.adminImportQuestions);
router.patch(
  '/questions/:questionId',
  validate({ params: jambQuestionIdParams, body: updateJambQuestionSchema }),
  jamb.adminUpdateQuestion
);

export default router;
