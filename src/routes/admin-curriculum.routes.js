import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as curriculum from '../controllers/admin-curriculum.controller.js';
import {
  uuidParams,
  reorderSchema,
  createTopicSchema,
  updateTopicSchema,
  createLessonContentSchema,
  updateLessonContentSchema,
  createAssignmentSchema,
  updateAssignmentSchema,
  gradeSubmissionSchema,
  createQuizSchema,
  updateQuizSchema,
  createQuestionSchema,
  updateQuestionSchema,
  createOptionSchema,
  updateOptionSchema,
  createAssessmentSchema,
  updateAssessmentSchema,
  publishCourseSchema,
  completionRulesSchema,
  updateCourseMetaSchema,
} from '../validation/schemas.js';

const router = Router();

// Everything here requires a verified ADMIN profile.
router.use(authenticate, requireAdmin);

const idOrSlugParams = z.object({ idOrSlug: z.string().trim().min(1).max(200) });

// ---------------- curriculum status ----------------
router.get(
  '/courses/:idOrSlug/curriculum-status',
  validate({ params: idOrSlugParams }),
  curriculum.getCurriculumStatusAdmin
);

// ---------------- topics ----------------
router.post(
  '/modules/:id/topics',
  validate({ params: uuidParams, body: createTopicSchema }),
  curriculum.createTopic
);
router.post(
  '/modules/:id/topics/reorder',
  validate({ params: uuidParams, body: reorderSchema }),
  curriculum.reorderTopics
);
router.get('/topics/:id', validate({ params: uuidParams }), curriculum.getTopic);
router.patch('/topics/:id', validate({ params: uuidParams, body: updateTopicSchema }), curriculum.updateTopic);
router.delete('/topics/:id', validate({ params: uuidParams }), curriculum.deleteTopic);

// ---------------- lesson contents ----------------
router.post(
  '/lessons/:id/contents',
  validate({ params: uuidParams, body: createLessonContentSchema }),
  curriculum.createLessonContent
);
router.post(
  '/lessons/:id/contents/reorder',
  validate({ params: uuidParams, body: reorderSchema }),
  curriculum.reorderLessonContents
);
router.patch(
  '/contents/:id',
  validate({ params: uuidParams, body: updateLessonContentSchema }),
  curriculum.updateLessonContent
);
router.delete('/contents/:id', validate({ params: uuidParams }), curriculum.deleteLessonContent);

// ---------------- assignments + grading ----------------
router.post(
  '/courses/:idOrSlug/assignments',
  validate({ params: idOrSlugParams, body: createAssignmentSchema }),
  curriculum.createAssignment
);
router.get('/assignments/:id', validate({ params: uuidParams }), curriculum.getAssignmentAdmin);
router.patch(
  '/assignments/:id',
  validate({ params: uuidParams, body: updateAssignmentSchema }),
  curriculum.updateAssignment
);
router.delete('/assignments/:id', validate({ params: uuidParams }), curriculum.deleteAssignment);
router.get(
  '/assignments/:id/submissions',
  validate({ params: uuidParams }),
  curriculum.listSubmissions
);
router.post(
  '/submissions/:id/grade',
  validate({ params: uuidParams, body: gradeSubmissionSchema }),
  curriculum.gradeSubmission
);

// ---------------- quizzes + questions + options ----------------
router.post(
  '/courses/:idOrSlug/quizzes',
  validate({ params: idOrSlugParams, body: createQuizSchema }),
  curriculum.createQuiz
);
router.get('/quizzes/:id', validate({ params: uuidParams }), curriculum.getQuizAdmin);
router.patch('/quizzes/:id', validate({ params: uuidParams, body: updateQuizSchema }), curriculum.updateQuiz);
router.delete('/quizzes/:id', validate({ params: uuidParams }), curriculum.deleteQuiz);
router.get('/quizzes/:id/attempts', validate({ params: uuidParams }), curriculum.listQuizAttempts);
router.post(
  '/quizzes/:id/questions',
  validate({ params: uuidParams, body: createQuestionSchema }),
  curriculum.createQuestion
);
router.patch(
  '/questions/:id',
  validate({ params: uuidParams, body: updateQuestionSchema }),
  curriculum.updateQuestion
);
router.delete('/questions/:id', validate({ params: uuidParams }), curriculum.deleteQuestion);
router.post(
  '/questions/:id/options',
  validate({ params: uuidParams, body: createOptionSchema }),
  curriculum.createOption
);
router.patch(
  '/options/:id',
  validate({ params: uuidParams, body: updateOptionSchema }),
  curriculum.updateOption
);
router.delete('/options/:id', validate({ params: uuidParams }), curriculum.deleteOption);

// ---------------- assessments ----------------
router.post(
  '/courses/:idOrSlug/assessments',
  validate({ params: idOrSlugParams, body: createAssessmentSchema }),
  curriculum.createAssessment
);
router.get('/assessments/:id', validate({ params: uuidParams }), curriculum.getAssessmentAdmin);
router.patch(
  '/assessments/:id',
  validate({ params: uuidParams, body: updateAssessmentSchema }),
  curriculum.updateAssessment
);
router.delete('/assessments/:id', validate({ params: uuidParams }), curriculum.deleteAssessment);

// ---------------- publish cascade / rules / metadata ----------------
router.post(
  '/courses/:idOrSlug/publish',
  validate({ params: idOrSlugParams, body: publishCourseSchema }),
  curriculum.publishCourseCascade
);
router.get(
  '/courses/:idOrSlug/completion-rules',
  validate({ params: idOrSlugParams }),
  curriculum.getCompletionRules
);
router.put(
  '/courses/:idOrSlug/completion-rules',
  validate({ params: idOrSlugParams, body: completionRulesSchema }),
  curriculum.upsertCompletionRules
);
router.patch(
  '/courses/:idOrSlug/meta',
  validate({ params: idOrSlugParams, body: updateCourseMetaSchema }),
  curriculum.updateCourseMeta
);

export default router;
