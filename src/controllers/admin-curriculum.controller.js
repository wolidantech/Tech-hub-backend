/**
 * WOLI DAN TECH HUB — Admin Curriculum Management
 *
 * CRUD for the complete curriculum chain:
 *   topics → lesson contents → assignments (+ grading) →
 *   quizzes → questions → options → assessments →
 *   publish cascade → completion rules → course metadata
 *
 * Complements admin-courses.controller.js (courses/modules/lessons) and
 * admin-content.controller.js (AI review pipeline). All routes require
 * an authenticated admin (router-level guard).
 */

import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { parsePagination } from '../utils/helpers.js';
import { logAudit } from '../services/audit.service.js';
import { getCurriculumStatus } from '../services/curriculum.service.js';

const isUuid = (s) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

async function loadCourse(idOrSlug) {
  let query = supabaseAdmin.from('courses').select('*');
  query = isUuid(idOrSlug) ? query.eq('id', idOrSlug) : query.eq('slug', idOrSlug);
  const { data } = await query.maybeSingle();
  if (!data) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');
  return data;
}

async function nextOrder(table, column, value) {
  const { data } = await supabaseAdmin
    .from(table)
    .select('order_number')
    .eq(column, value)
    .order('order_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.order_number || 0) + 1;
}

function missingRelation(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '').toLowerCase();
  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    code === '42703' ||
    msg.includes('could not find the table') ||
    msg.includes('does not exist') ||
    msg.includes('schema cache')
  );
}

function throwMissingMigration(feature) {
  throw ApiError.internal(
    `${feature} requires database migration 014 (npm run migrate).`,
    'MIGRATION_REQUIRED'
  );
}

// ===========================================================================
// Curriculum status
// ===========================================================================

/** GET /api/admin/courses/:idOrSlug/curriculum-status */
export const getCurriculumStatusAdmin = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const status = await getCurriculumStatus(course.id);
  res.json({ success: true, data: { course_id: course.id, course_title: course.title, ...status } });
});

// ===========================================================================
// Topics
// ===========================================================================

/** POST /api/admin/modules/:id/topics */
export const createTopic = asyncHandler(async (req, res) => {
  const moduleId = req.validatedParams.id;
  const body = req.validatedBody;

  const { data: module } = await supabaseAdmin
    .from('course_modules')
    .select('id, course_id, title')
    .eq('id', moduleId)
    .maybeSingle();
  if (!module) throw ApiError.notFound('Module not found', 'MODULE_NOT_FOUND');

  const orderNumber = body.order_number || (await nextOrder('course_topics', 'module_id', moduleId));

  const { data, error } = await supabaseAdmin
    .from('course_topics')
    .insert({ ...body, course_id: module.course_id, module_id: moduleId, order_number: orderNumber })
    .select()
    .single();

  if (error) {
    if (missingRelation(error)) throwMissingMigration('Course topics');
    throw ApiError.internal('Unable to create topic. Check the order number is unique.');
  }

  await logAudit({
    adminId: req.profile.id,
    action: 'TOPIC_CREATED',
    targetType: 'topic',
    targetId: data.id,
    description: `Created topic "${data.title}" in module "${module.title}"`,
  });

  res.status(201).json({ success: true, message: 'Topic created', data: { topic: data } });
});

/** GET /api/admin/topics/:id — topic + its lessons */
export const getTopic = asyncHandler(async (req, res) => {
  const { data: topic, error } = await supabaseAdmin
    .from('course_topics')
    .select('*')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (error && missingRelation(error)) throwMissingMigration('Course topics');
  if (error) throw ApiError.internal('Unable to load topic');
  if (!topic) throw ApiError.notFound('Topic not found', 'TOPIC_NOT_FOUND');

  const { data: lessons } = await supabaseAdmin
    .from('lessons')
    .select('id, title, lesson_type, order_number, is_published')
    .eq('topic_id', topic.id)
    .order('order_number', { ascending: true });

  res.json({ success: true, data: { topic: { ...topic, lessons: lessons || [] } } });
});

/** PATCH /api/admin/topics/:id */
export const updateTopic = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('course_topics')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error && missingRelation(error)) throwMissingMigration('Course topics');
  if (error) throw ApiError.internal('Unable to update topic');
  if (!data) throw ApiError.notFound('Topic not found', 'TOPIC_NOT_FOUND');
  res.json({ success: true, message: 'Topic updated', data: { topic: data } });
});

/** DELETE /api/admin/topics/:id (lessons are kept, unlinked) */
export const deleteTopic = asyncHandler(async (req, res) => {
  const { data: topic } = await supabaseAdmin
    .from('course_topics')
    .select('id, title')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (!topic) throw ApiError.notFound('Topic not found', 'TOPIC_NOT_FOUND');

  await supabaseAdmin.from('lessons').update({ topic_id: null }).eq('topic_id', topic.id);

  const { error } = await supabaseAdmin.from('course_topics').delete().eq('id', topic.id);
  if (error) throw ApiError.internal('Unable to delete topic');

  await logAudit({
    adminId: req.profile.id,
    action: 'TOPIC_DELETED',
    targetType: 'topic',
    targetId: topic.id,
    description: `Deleted topic "${topic.title}" (lessons unlinked, not deleted)`,
  });

  res.json({ success: true, message: 'Topic deleted. Its lessons were kept and unlinked.' });
});

/** POST /api/admin/modules/:id/topics/reorder {ids: [...]} */
export const reorderTopics = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.rpc('reorder_topics', {
    p_module_id: req.validatedParams.id,
    p_topic_ids: req.validatedBody.ids,
  });
  if (error) {
    if (missingRelation(error)) throwMissingMigration('Topic reordering');
    throw ApiError.internal('Unable to reorder topics');
  }
  res.json({ success: true, message: 'Topics reordered' });
});

// ===========================================================================
// Lesson contents (structured blocks)
// ===========================================================================

/** POST /api/admin/lessons/:id/contents */
export const createLessonContent = asyncHandler(async (req, res) => {
  const lessonId = req.validatedParams.id;
  const body = req.validatedBody;

  const { data: lesson } = await supabaseAdmin
    .from('lessons')
    .select('id, title')
    .eq('id', lessonId)
    .maybeSingle();
  if (!lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');
  if (!body.body && !body.url && !body.storage_path) {
    throw ApiError.badRequest('Content needs a body, url or storage_path', 'CONTENT_PAYLOAD_REQUIRED');
  }

  const orderNumber = body.order_number || (await nextOrder('lesson_contents', 'lesson_id', lessonId));

  const { data, error } = await supabaseAdmin
    .from('lesson_contents')
    .insert({ ...body, lesson_id: lessonId, order_number: orderNumber, created_by: req.profile.id })
    .select()
    .single();

  if (error) {
    if (missingRelation(error)) throwMissingMigration('Lesson contents');
    throw ApiError.internal('Unable to create lesson content. Check the order number is unique.');
  }

  res.status(201).json({ success: true, message: 'Lesson content created', data: { content: data } });
});

/** PATCH /api/admin/contents/:id */
export const updateLessonContent = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('lesson_contents')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error && missingRelation(error)) throwMissingMigration('Lesson contents');
  if (error) throw ApiError.internal('Unable to update lesson content');
  if (!data) throw ApiError.notFound('Lesson content not found', 'CONTENT_NOT_FOUND');
  res.json({ success: true, message: 'Lesson content updated', data: { content: data } });
});

/** DELETE /api/admin/contents/:id */
export const deleteLessonContent = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('lesson_contents')
    .delete()
    .eq('id', req.validatedParams.id)
    .select('id')
    .maybeSingle();
  if (error && missingRelation(error)) throwMissingMigration('Lesson contents');
  if (error) throw ApiError.internal('Unable to delete lesson content');
  if (!data) throw ApiError.notFound('Lesson content not found', 'CONTENT_NOT_FOUND');
  res.json({ success: true, message: 'Lesson content deleted' });
});

/** POST /api/admin/lessons/:id/contents/reorder {ids: [...]} */
export const reorderLessonContents = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.rpc('reorder_lesson_contents', {
    p_lesson_id: req.validatedParams.id,
    p_content_ids: req.validatedBody.ids,
  });
  if (error) {
    if (missingRelation(error)) throwMissingMigration('Content reordering');
    throw ApiError.internal('Unable to reorder lesson contents');
  }
  res.json({ success: true, message: 'Lesson contents reordered' });
});

// ===========================================================================
// Assignments + grading
// ===========================================================================

/** POST /api/admin/courses/:idOrSlug/assignments */
export const createAssignment = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const body = req.validatedBody;

  const { data, error } = await supabaseAdmin
    .from('assignments')
    .insert({ ...body, course_id: course.id, created_by: req.profile.id })
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to create assignment');

  await logAudit({
    adminId: req.profile.id,
    action: 'ASSIGNMENT_CREATED',
    targetType: 'assignment',
    targetId: data.id,
    description: `Created assignment "${data.title}" in "${course.title}"`,
  });

  res.status(201).json({ success: true, message: 'Assignment created', data: { assignment: data } });
});

/** GET /api/admin/assignments/:id — detail + submission stats */
export const getAssignmentAdmin = asyncHandler(async (req, res) => {
  const { data: assignment, error } = await supabaseAdmin
    .from('assignments')
    .select('*')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to load assignment');
  if (!assignment) throw ApiError.notFound('Assignment not found', 'ASSIGNMENT_NOT_FOUND');

  const { count: submissionsCount } = await supabaseAdmin
    .from('assignment_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('assignment_id', assignment.id);
  const { count: pendingCount } = await supabaseAdmin
    .from('assignment_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('assignment_id', assignment.id)
    .in('status', ['SUBMITTED', 'UNDER_REVIEW']);

  res.json({
    success: true,
    data: {
      assignment: {
        ...assignment,
        submissions_count: submissionsCount || 0,
        pending_review_count: pendingCount || 0,
      },
    },
  });
});

/** PATCH /api/admin/assignments/:id */
export const updateAssignment = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('assignments')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to update assignment');
  if (!data) throw ApiError.notFound('Assignment not found', 'ASSIGNMENT_NOT_FOUND');
  res.json({ success: true, message: 'Assignment updated', data: { assignment: data } });
});

/** DELETE /api/admin/assignments/:id */
export const deleteAssignment = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('assignments')
    .delete()
    .eq('id', req.validatedParams.id)
    .select('id')
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to delete assignment');
  if (!data) throw ApiError.notFound('Assignment not found', 'ASSIGNMENT_NOT_FOUND');
  res.json({ success: true, message: 'Assignment deleted' });
});

/** GET /api/admin/assignments/:id/submissions — review queue */
export const listSubmissions = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);
  const status = typeof req.query.status === 'string' ? req.query.status : null;

  const { data: assignment } = await supabaseAdmin
    .from('assignments')
    .select('id, title, course_id')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (!assignment) throw ApiError.notFound('Assignment not found', 'ASSIGNMENT_NOT_FOUND');

  let query = supabaseAdmin
    .from('assignment_submissions')
    .select(
      `*, student:profiles!assignment_submissions_student_id_fkey ( id, full_name, email )`,
      { count: 'exact' }
    )
    .eq('assignment_id', assignment.id)
    .order('submitted_at', { ascending: false })
    .range(from, to);

  if (status && ['SUBMITTED', 'UNDER_REVIEW', 'GRADED', 'RETURNED'].includes(status)) {
    query = query.eq('status', status);
  }

  const { data, error, count } = await query;
  if (error) {
    if (missingRelation(error)) throwMissingMigration('Assignment submissions');
    throw ApiError.internal('Unable to load submissions');
  }

  res.json({
    success: true,
    data: {
      assignment,
      submissions: data || [],
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/** POST /api/admin/submissions/:id/grade {score, feedback, status} */
export const gradeSubmission = asyncHandler(async (req, res) => {
  const { score, feedback, status } = req.validatedBody;

  const { data: submission } = await supabaseAdmin
    .from('assignment_submissions')
    .select('id, assignment_id, student_id, course_id')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (!submission) throw ApiError.notFound('Submission not found', 'SUBMISSION_NOT_FOUND');

  const { data, error } = await supabaseAdmin
    .from('assignment_submissions')
    .update({
      score,
      feedback: feedback ?? null,
      status,
      graded_by: req.profile.id,
      graded_at: new Date().toISOString(),
    })
    .eq('id', submission.id)
    .select()
    .single();

  if (error) throw ApiError.internal('Unable to grade submission');

  await supabaseAdmin.from('notifications').insert({
    user_id: submission.student_id,
    title: status === 'GRADED' ? 'Assignment graded' : 'Assignment returned',
    message:
      status === 'GRADED'
        ? `Your assignment was graded: ${score}/100.${feedback ? ` Feedback: ${feedback}` : ''}`
        : `Your assignment was returned for revision.${feedback ? ` Feedback: ${feedback}` : ''}`,
    type: 'LESSON_COMPLETED',
  });

  await logAudit({
    adminId: req.profile.id,
    action: 'SUBMISSION_GRADED',
    targetType: 'submission',
    targetId: submission.id,
    description: `Graded submission (${score}/100, ${status})`,
  });

  res.json({ success: true, message: 'Submission graded', data: { submission: data } });
});

// ===========================================================================
// Quizzes + questions + options
// ===========================================================================

/** POST /api/admin/courses/:idOrSlug/quizzes */
export const createQuiz = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const body = req.validatedBody;

  const { data, error } = await supabaseAdmin
    .from('quizzes')
    .insert({ ...body, course_id: course.id, created_by: req.profile.id })
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to create quiz');

  await logAudit({
    adminId: req.profile.id,
    action: 'QUIZ_CREATED',
    targetType: 'quiz',
    targetId: data.id,
    description: `Created quiz "${data.title}" (${data.scope}) in "${course.title}"`,
  });

  res.status(201).json({ success: true, message: 'Quiz created', data: { quiz: data } });
});

/** GET /api/admin/quizzes/:id — full bank (WITH answers — admin only) */
export const getQuizAdmin = asyncHandler(async (req, res) => {
  const { data: quiz, error } = await supabaseAdmin
    .from('quizzes')
    .select('*')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to load quiz');
  if (!quiz) throw ApiError.notFound('Quiz not found', 'QUIZ_NOT_FOUND');

  const { data: questions } = await supabaseAdmin
    .from('quiz_questions')
    .select('*')
    .eq('quiz_id', quiz.id)
    .order('order_number', { ascending: true });

  let options = [];
  if ((questions || []).length > 0) {
    const { data } = await supabaseAdmin
      .from('quiz_options')
      .select('*')
      .in('question_id', questions.map((q) => q.id))
      .order('order_number', { ascending: true });
    options = data || [];
  }

  const { count: attemptsCount } = await supabaseAdmin
    .from('quiz_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('quiz_id', quiz.id);

  res.json({
    success: true,
    data: {
      quiz: {
        ...quiz,
        questions: (questions || []).map((q) => ({
          ...q,
          options: options.filter((o) => o.question_id === q.id),
        })),
        attempts_count: attemptsCount || 0,
      },
    },
  });
});

/** PATCH /api/admin/quizzes/:id */
export const updateQuiz = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('quizzes')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to update quiz');
  if (!data) throw ApiError.notFound('Quiz not found', 'QUIZ_NOT_FOUND');
  res.json({ success: true, message: 'Quiz updated', data: { quiz: data } });
});

/** DELETE /api/admin/quizzes/:id */
export const deleteQuiz = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('quizzes')
    .delete()
    .eq('id', req.validatedParams.id)
    .select('id')
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to delete quiz');
  if (!data) throw ApiError.notFound('Quiz not found', 'QUIZ_NOT_FOUND');
  res.json({ success: true, message: 'Quiz deleted' });
});

/** POST /api/admin/quizzes/:id/questions */
export const createQuestion = asyncHandler(async (req, res) => {
  const quizId = req.validatedParams.id;
  const body = req.validatedBody;

  const { data: quiz } = await supabaseAdmin.from('quizzes').select('id').eq('id', quizId).maybeSingle();
  if (!quiz) throw ApiError.notFound('Quiz not found', 'QUIZ_NOT_FOUND');

  const orderNumber = body.order_number || (await nextOrder('quiz_questions', 'quiz_id', quizId));

  const { data, error } = await supabaseAdmin
    .from('quiz_questions')
    .insert({ ...body, quiz_id: quizId, order_number: orderNumber })
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to create question');

  res.status(201).json({ success: true, message: 'Question created', data: { question: data } });
});

/** PATCH /api/admin/questions/:id */
export const updateQuestion = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('quiz_questions')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to update question');
  if (!data) throw ApiError.notFound('Question not found', 'QUESTION_NOT_FOUND');
  res.json({ success: true, message: 'Question updated', data: { question: data } });
});

/** DELETE /api/admin/questions/:id */
export const deleteQuestion = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('quiz_questions')
    .delete()
    .eq('id', req.validatedParams.id)
    .select('id')
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to delete question');
  if (!data) throw ApiError.notFound('Question not found', 'QUESTION_NOT_FOUND');
  res.json({ success: true, message: 'Question deleted' });
});

/** POST /api/admin/questions/:id/options */
export const createOption = asyncHandler(async (req, res) => {
  const questionId = req.validatedParams.id;
  const body = req.validatedBody;

  const { data: question } = await supabaseAdmin
    .from('quiz_questions')
    .select('id')
    .eq('id', questionId)
    .maybeSingle();
  if (!question) throw ApiError.notFound('Question not found', 'QUESTION_NOT_FOUND');

  const orderNumber = body.order_number || (await nextOrder('quiz_options', 'question_id', questionId));

  const { data, error } = await supabaseAdmin
    .from('quiz_options')
    .insert({ ...body, question_id: questionId, order_number: orderNumber })
    .select()
    .single();

  if (error) {
    if (missingRelation(error)) throwMissingMigration('Quiz options');
    throw ApiError.internal('Unable to create option. Check the order number is unique.');
  }

  res.status(201).json({ success: true, message: 'Option created', data: { option: data } });
});

/** PATCH /api/admin/options/:id */
export const updateOption = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('quiz_options')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error && missingRelation(error)) throwMissingMigration('Quiz options');
  if (error) throw ApiError.internal('Unable to update option');
  if (!data) throw ApiError.notFound('Option not found', 'OPTION_NOT_FOUND');
  res.json({ success: true, message: 'Option updated', data: { option: data } });
});

/** DELETE /api/admin/options/:id */
export const deleteOption = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('quiz_options')
    .delete()
    .eq('id', req.validatedParams.id)
    .select('id')
    .maybeSingle();
  if (error && missingRelation(error)) throwMissingMigration('Quiz options');
  if (error) throw ApiError.internal('Unable to delete option');
  if (!data) throw ApiError.notFound('Option not found', 'OPTION_NOT_FOUND');
  res.json({ success: true, message: 'Option deleted' });
});

/** GET /api/admin/quizzes/:id/attempts — attempt review */
export const listQuizAttempts = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);

  const { data: quiz } = await supabaseAdmin
    .from('quizzes')
    .select('id, title, course_id')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (!quiz) throw ApiError.notFound('Quiz not found', 'QUIZ_NOT_FOUND');

  const { data, error, count } = await supabaseAdmin
    .from('quiz_attempts')
    .select(`*, student:profiles!quiz_attempts_student_id_fkey ( id, full_name, email )`, { count: 'exact' })
    .eq('quiz_id', quiz.id)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    if (missingRelation(error)) throwMissingMigration('Quiz attempts');
    throw ApiError.internal('Unable to load attempts');
  }

  res.json({
    success: true,
    data: {
      quiz,
      attempts: data || [],
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

// ===========================================================================
// Assessments
// ===========================================================================

/** POST /api/admin/courses/:idOrSlug/assessments */
export const createAssessment = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const body = req.validatedBody;

  const { data, error } = await supabaseAdmin
    .from('course_assessments')
    .insert({ ...body, course_id: course.id, created_by: req.profile.id })
    .select()
    .single();

  if (error) {
    if (missingRelation(error)) throwMissingMigration('Course assessments');
    throw ApiError.internal('Unable to create assessment');
  }

  await logAudit({
    adminId: req.profile.id,
    action: 'ASSESSMENT_CREATED',
    targetType: 'assessment',
    targetId: data.id,
    description: `Created ${data.assessment_type} "${data.title}" in "${course.title}"`,
  });

  res.status(201).json({ success: true, message: 'Assessment created', data: { assessment: data } });
});

/** GET /api/admin/assessments/:id — detail + linked quizzes */
export const getAssessmentAdmin = asyncHandler(async (req, res) => {
  const { data: assessment, error } = await supabaseAdmin
    .from('course_assessments')
    .select('*')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (error && missingRelation(error)) throwMissingMigration('Course assessments');
  if (error) throw ApiError.internal('Unable to load assessment');
  if (!assessment) throw ApiError.notFound('Assessment not found', 'ASSESSMENT_NOT_FOUND');

  const { data: quizzes } = await supabaseAdmin
    .from('quizzes')
    .select('id, title, scope, status, passing_score')
    .eq('assessment_id', assessment.id)
    .order('order_number', { ascending: true });

  res.json({ success: true, data: { assessment: { ...assessment, quizzes: quizzes || [] } } });
});

/** PATCH /api/admin/assessments/:id */
export const updateAssessment = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('course_assessments')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error && missingRelation(error)) throwMissingMigration('Course assessments');
  if (error) throw ApiError.internal('Unable to update assessment');
  if (!data) throw ApiError.notFound('Assessment not found', 'ASSESSMENT_NOT_FOUND');
  res.json({ success: true, message: 'Assessment updated', data: { assessment: data } });
});

/** DELETE /api/admin/assessments/:id */
export const deleteAssessment = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('course_assessments')
    .delete()
    .eq('id', req.validatedParams.id)
    .select('id')
    .maybeSingle();
  if (error && missingRelation(error)) throwMissingMigration('Course assessments');
  if (error) throw ApiError.internal('Unable to delete assessment');
  if (!data) throw ApiError.notFound('Assessment not found', 'ASSESSMENT_NOT_FOUND');
  res.json({ success: true, message: 'Assessment deleted' });
});

// ===========================================================================
// Publish cascade + completion rules + course metadata
// ===========================================================================

/**
 * POST /api/admin/courses/:idOrSlug/publish
 * Publishes (or unpublishes) the whole teachable chain in one action:
 * course → modules → topics → lessons → lesson contents.
 * Quizzes/assignments/assessments stay on their own review pipeline
 * unless explicitly included.
 */
export const publishCourseCascade = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const { publish, include_quizzes, include_assignments, include_assessments } = req.validatedBody;

  // Try the database RPC first (single transaction); fall back to
  // direct updates on databases where migration 014 is not applied.
  const { error: rpcError } = await supabaseAdmin.rpc('publish_course_content', {
    p_course_id: course.id,
    p_publish: publish,
  });

  if (rpcError && !missingRelation(rpcError)) throw ApiError.internal('Unable to publish course');

  if (rpcError && missingRelation(rpcError)) {
    const { error } = await supabaseAdmin
      .from('courses')
      .update({ is_published: publish })
      .eq('id', course.id);
    if (error) throw ApiError.internal('Unable to publish course');

    const { data: modules } = await supabaseAdmin
      .from('course_modules')
      .select('id')
      .eq('course_id', course.id);
    const moduleIds = (modules || []).map((m) => m.id);
    if (moduleIds.length > 0) {
      await supabaseAdmin.from('lessons').update({ is_published: publish }).in('module_id', moduleIds);
    }
  }

  if (include_quizzes) {
    await supabaseAdmin
      .from('quizzes')
      .update({ status: publish ? 'PUBLISHED' : 'UNPUBLISHED' })
      .eq('course_id', course.id);
  }
  if (include_assignments) {
    await supabaseAdmin
      .from('assignments')
      .update({ status: publish ? 'PUBLISHED' : 'UNPUBLISHED' })
      .eq('course_id', course.id);
  }
  if (include_assessments) {
    const { error } = await supabaseAdmin
      .from('course_assessments')
      .update({ status: publish ? 'PUBLISHED' : 'UNPUBLISHED' })
      .eq('course_id', course.id);
    if (error && !missingRelation(error)) throw ApiError.internal('Unable to publish assessments');
  }

  await logAudit({
    adminId: req.profile.id,
    action: publish ? 'COURSE_PUBLISHED' : 'COURSE_UNPUBLISHED',
    targetType: 'course',
    targetId: course.id,
    description: `${publish ? 'Published' : 'Unpublished'} "${course.title}" with full curriculum cascade`,
  });

  const status = await getCurriculumStatus(course.id);
  res.json({
    success: true,
    message: publish ? 'Course and curriculum published' : 'Course and curriculum unpublished',
    data: { course_id: course.id, published: publish, curriculum_status: status },
  });
});

/** GET /api/admin/courses/:idOrSlug/completion-rules */
export const getCompletionRules = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const { data } = await supabaseAdmin
    .from('course_completion_rules')
    .select('*')
    .eq('course_id', course.id)
    .maybeSingle();
  res.json({ success: true, data: { course_id: course.id, rules: data || null } });
});

/** PUT /api/admin/courses/:idOrSlug/completion-rules */
export const upsertCompletionRules = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const { data, error } = await supabaseAdmin
    .from('course_completion_rules')
    .upsert({ ...req.validatedBody, course_id: course.id }, { onConflict: 'course_id' })
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to save completion rules');

  await logAudit({
    adminId: req.profile.id,
    action: 'COMPLETION_RULES_UPDATED',
    targetType: 'course',
    targetId: course.id,
    description: `Updated completion rules for "${course.title}"`,
  });

  res.json({ success: true, message: 'Completion rules saved', data: { rules: data } });
});

/** PATCH /api/admin/courses/:idOrSlug/meta — outcomes / prerequisites / objectives */
export const updateCourseMeta = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const { data, error } = await supabaseAdmin
    .from('courses')
    .update(req.validatedBody)
    .eq('id', course.id)
    .select()
    .single();
  if (error) {
    if (missingRelation(error)) throwMissingMigration('Course metadata');
    throw ApiError.internal('Unable to update course metadata');
  }
  res.json({ success: true, message: 'Course metadata updated', data: { course: data } });
});
