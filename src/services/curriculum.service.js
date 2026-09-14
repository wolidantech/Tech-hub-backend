/**
 * WOLI DAN TECH HUB — Curriculum service (single source of truth)
 *
 * Assembles the complete classroom chain for enrolled students:
 *
 *   course → modules → topics → lessons → contents / videos / resources
 *     → practicals → assignments (+ my submissions) → quizzes (answers
 *     stripped) → assessments → progress → certificate
 *
 * Every NEW-curriculum table (migration 014) is queried defensively:
 * when the table/column does not exist yet (migration not applied), the
 * section degrades to an empty list instead of failing the request.
 * Core tables (courses, course_modules, lessons) are required.
 */

import { supabaseAdmin } from '../config/supabase.js';
import { BUCKETS } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { createSignedUrl, uploadObject } from './storage.service.js';
import { getCourseProgress, getContinueLearning } from './learning.service.js';

const isUuid = (s) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

const COURSE_META_SELECT = `
  id, title, slug, description, thumbnail_url, price, duration,
  difficulty_level, instructor_id, is_published, created_at, updated_at,
  learning_outcomes, prerequisites, learning_objectives, level, category
`;

/** A table/column that does not exist yet degrades to `fallback`. */
function isMissingRelation(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '').toLowerCase();
  return (
    code === 'PGRST205' || // table not found in schema cache
    code === '42P01' || // undefined table
    code === '42703' || // undefined column
    code === 'PGRST202' || // function not found (RPC fallback path)
    msg.includes('could not find the table') ||
    msg.includes('does not exist') ||
    msg.includes('schema cache')
  );
}

async function optionalList(queryBuilder) {
  const { data, error } = await queryBuilder;
  if (error) {
    if (isMissingRelation(error)) return [];
    throw ApiError.internal('Unable to load curriculum data');
  }
  return data || [];
}

async function optionalSingle(queryBuilder) {
  const { data, error } = await queryBuilder;
  if (error) {
    if (isMissingRelation(error)) return null;
    throw ApiError.internal('Unable to load curriculum data');
  }
  return data || null;
}

/** Course is student-visible when published on EITHER flag convention. */
export function isCourseVisible(course) {
  if (!course) return false;
  return Boolean(course.is_published || course.published) && course.archived !== true;
}

function isLessonVisible(lesson) {
  if (!lesson) return false;
  return Boolean(lesson.is_published || lesson.published);
}

/**
 * Resolves a course by UUID or slug (service role — RLS bypassed, the
 * caller decides visibility). Throws 404 when missing or hidden.
 */
export async function resolveCourse(idOrSlug, { requirePublished = true } = {}) {
  let query = supabaseAdmin.from('courses').select(`${COURSE_META_SELECT}, published, archived`);
  query = isUuid(idOrSlug) ? query.eq('id', idOrSlug) : query.eq('slug', idOrSlug);
  let { data: course, error } = await query.maybeSingle();

  if (error && isMissingRelation(error)) {
    // Pre-migration-014 database: legacy column set only.
    let legacy = supabaseAdmin.from('courses').select('*');
    legacy = isUuid(idOrSlug) ? legacy.eq('id', idOrSlug) : legacy.eq('slug', idOrSlug);
    const res = await legacy.maybeSingle();
    course = res.data;
    error = res.error;
  }
  if (error) throw ApiError.internal('Unable to load course');
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');
  if (requirePublished && !isCourseVisible(course)) {
    throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');
  }

  const [{ data: category }, { data: instructor }] = await Promise.all([
    course.category_id
      ? supabaseAdmin.from('course_categories').select('id, name').eq('id', course.category_id).maybeSingle()
      : { data: null },
    course.instructor_id
      ? supabaseAdmin
          .from('profiles')
          .select('id, full_name, profile_photo_url')
          .eq('id', course.instructor_id)
          .maybeSingle()
      : { data: null },
  ]);

  return {
    ...course,
    learning_outcomes: course.learning_outcomes || [],
    prerequisites: course.prerequisites || [],
    learning_objectives: course.learning_objectives || [],
    course_categories: category || null,
    instructor: instructor || null,
  };
}

/**
 * Authoritative access check. Students need ACTIVE/COMPLETED enrollment.
 * Admins and the course instructor always pass (roleOverride).
 */
export async function requireCourseAccess(courseId, profile) {
  if (!profile) throw ApiError.unauthorized('Authentication required');
  if (profile.role === 'admin') return { enrollment: null, roleOverride: 'admin' };

  const { data: course } = await supabaseAdmin
    .from('courses')
    .select('id, instructor_id')
    .eq('id', courseId)
    .maybeSingle();
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');
  if (course.instructor_id === profile.id) return { enrollment: null, roleOverride: 'instructor' };

  const { data: enrollment } = await supabaseAdmin
    .from('enrollments')
    .select('id, status, enrolled_at, completed_at')
    .eq('course_id', courseId)
    .eq('student_id', profile.id)
    .maybeSingle();

  if (!enrollment || !['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
    throw ApiError.forbidden(
      'You do not have access to this course. A verified payment is required.',
      'COURSE_ACCESS_DENIED'
    );
  }
  return { enrollment, roleOverride: null };
}

/** Best-effort enrollment lookup (null when anonymous/unenrolled). */
export async function findEnrollment(courseId, profile) {
  if (!profile) return null;
  const { data } = await supabaseAdmin
    .from('enrollments')
    .select('id, status, enrolled_at, completed_at')
    .eq('course_id', courseId)
    .eq('student_id', profile.id)
    .maybeSingle();
  return data || null;
}

// ---------------------------------------------------------------------------
// Curriculum status / diagnostics
// ---------------------------------------------------------------------------

/**
 * Counts every curriculum layer for a course and reports whether the
 * classroom is actually teachable. Used by catalog, classroom and admin
 * diagnostics so "preview works but classroom is empty" is diagnosable
 * instead of silent.
 */
export async function getCurriculumStatus(courseId) {
  const { data: modules } = await supabaseAdmin
    .from('course_modules')
    .select('id')
    .eq('course_id', courseId);
  const moduleIds = (modules || []).map((m) => m.id);

  const [topics, lessons, quizzes, assignments, assessments] = await Promise.all([
    optionalList(
      supabaseAdmin.from('course_topics').select('id, is_published').eq('course_id', courseId)
    ),
    moduleIds.length > 0
      ? optionalList(
          supabaseAdmin.from('lessons').select('id, is_published').in('module_id', moduleIds)
        )
      : [],
    optionalList(
      supabaseAdmin.from('quizzes').select('id, status').eq('course_id', courseId)
    ),
    optionalList(
      supabaseAdmin.from('assignments').select('id, status').eq('course_id', courseId)
    ),
    optionalList(
      supabaseAdmin.from('course_assessments').select('id, status').eq('course_id', courseId)
    ),
  ]);

  const publishedLessons = lessons.filter((l) => l.is_published).length;
  const liveQuizzes = quizzes.filter((q) => ['APPROVED', 'PUBLISHED'].includes(q.status)).length;
  const liveAssignments = assignments.filter((a) => ['APPROVED', 'PUBLISHED'].includes(a.status)).length;
  const liveAssessments = assessments.filter((a) => ['APPROVED', 'PUBLISHED'].includes(a.status)).length;

  const complete = (modules || []).length > 0 && publishedLessons > 0;
  let message;
  if (complete) {
    message = `Curriculum ready — ${(modules || []).length} module(s), ${publishedLessons} published lesson(s)`;
  } else if ((modules || []).length === 0) {
    message = 'Curriculum incomplete — this course has no modules yet. An admin must build the curriculum.';
  } else if (lessons.length === 0) {
    message = 'Curriculum incomplete — modules exist but no lessons have been added yet.';
  } else {
    message = 'Curriculum incomplete — lessons exist but none are published yet.';
  }

  return {
    complete,
    modules_count: (modules || []).length,
    topics_count: topics.length,
    lessons_count: lessons.length,
    published_lessons_count: publishedLessons,
    quizzes_count: quizzes.length,
    live_quizzes_count: liveQuizzes,
    assignments_count: assignments.length,
    live_assignments_count: liveAssignments,
    assessments_count: assessments.length,
    live_assessments_count: liveAssessments,
    message,
  };
}

// ---------------------------------------------------------------------------
// Public outline (safe columns only)
// ---------------------------------------------------------------------------

/** PUBLIC outline: module/topic/lesson titles only — never content URLs. */
export async function getCourseOutline(courseId, profile = null) {
  const [course, status] = await Promise.all([
    resolveCourse(courseId, { requirePublished: true }),
    getCurriculumStatus(courseId),
  ]);

  const { data: modules, error: mErr } = await supabaseAdmin
    .from('course_modules')
    .select('id, title, description, order_number')
    .eq('course_id', course.id)
    .order('order_number', { ascending: true });
  if (mErr) throw ApiError.internal('Unable to load course outline');

  const moduleIds = (modules || []).map((m) => m.id);
  const [topics, lessons] = await Promise.all([
    moduleIds.length > 0
      ? optionalList(
          supabaseAdmin
            .from('course_topics')
            .select('id, module_id, title, description, order_number, is_published')
            .in('module_id', moduleIds)
            .order('order_number', { ascending: true })
        )
      : [],
    moduleIds.length > 0
      ? optionalList(
          supabaseAdmin
            .from('lessons')
            .select(
              'id, module_id, topic_id, title, description, lesson_type, duration, order_number, is_published, is_free_preview'
            )
            .in('module_id', moduleIds)
            .order('order_number', { ascending: true })
        )
      : [],
  ]);

  const visibleTopics = topics.filter((t) => t.is_published !== false);
  const visibleLessons = lessons.filter((l) => isLessonVisible(l));

  const outline = (modules || []).map((m) => {
    const moduleTopics = visibleTopics.filter((t) => t.module_id === m.id);
    const moduleLessons = visibleLessons.filter((l) => l.module_id === m.id);
    return {
      ...m,
      topics: moduleTopics.map((t) => ({
        ...t,
        lessons_count: moduleLessons.filter((l) => l.topic_id === t.id).length,
      })),
      lessons: moduleLessons.map((l) => ({
        id: l.id,
        module_id: l.module_id,
        topic_id: l.topic_id || null,
        title: l.title,
        description: l.description,
        lesson_type: l.lesson_type,
        duration: l.duration,
        order_number: l.order_number,
        is_free_preview: Boolean(l.is_free_preview),
      })),
      topics_count: moduleTopics.length,
      lessons_count: moduleLessons.length,
    };
  });

  const totalLessons = outline.reduce((n, m) => n + m.lessons_count, 0);

  let enrollment = null;
  let progress = null;
  if (profile) {
    enrollment = await findEnrollment(course.id, profile);
    if (enrollment && ['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
      progress = await getCourseProgress(course.id, profile.id);
    }
  }

  return {
    course,
    modules: outline,
    total_lessons: totalLessons,
    counts: {
      modules: outline.length,
      topics: outline.reduce((n, m) => n + m.topics_count, 0),
      lessons: totalLessons,
      quizzes: status.live_quizzes_count,
      assignments: status.live_assignments_count,
      assessments: status.live_assessments_count,
    },
    curriculum_complete: status.complete,
    curriculum_status: status,
    enrollment,
    progress,
    has_access: Boolean(enrollment && ['ACTIVE', 'COMPLETED'].includes(enrollment.status)),
  };
}

// ---------------------------------------------------------------------------
// Full classroom (gated)
// ---------------------------------------------------------------------------

async function signedUrlOrNull(bucket, path, expiresIn = 3600) {
  if (!path || /^https?:\/\//i.test(path)) return path || null;
  try {
    return await createSignedUrl(bucket, path, expiresIn);
  } catch {
    return null;
  }
}

/** Strip correctness from a question + its options (student-safe). */
export function toStudentQuestion(question, options) {
  return {
    id: question.id,
    quiz_id: question.quiz_id,
    question: question.question,
    question_type: question.question_type,
    difficulty: question.difficulty,
    topic: question.topic,
    order_number: question.order_number,
    options: (options || []).map((o) => ({ id: o.id, text: o.option_text, order_number: o.order_number })),
  };
}

function normaliseAnswer(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim().toLowerCase();
  return JSON.stringify(value).trim().toLowerCase();
}

/**
 * Grades one question. Prefers normalised quiz_options rows; falls back
 * to the legacy options JSONB + correct_answer payload. Mirrors the
 * grade_quiz_attempt() database function.
 */
export function gradeQuestion(question, options, submitted) {
  const type = question.question_type || 'multiple_choice';
  const normOptions = (options || []).map((o) => ({
    id: String(o.id),
    text: normaliseAnswer(o.option_text ?? o.text),
    correct: Boolean(o.is_correct),
  }));

  if (type === 'multiple_answer') {
    const submittedSet = new Set(
      (Array.isArray(submitted) ? submitted : [submitted]).map((a) => {
        const hit = normOptions.find((o) => o.id === String(a));
        return hit ? hit.id : normaliseAnswer(a);
      })
    );
    let correctSet;
    if (normOptions.length > 0) {
      correctSet = new Set(normOptions.filter((o) => o.correct).map((o) => o.id));
    } else {
      const raw = Array.isArray(question.correct_answer)
        ? question.correct_answer
        : [question.correct_answer];
      correctSet = new Set(raw.map(normaliseAnswer));
      return (
        correctSet.size === submittedSet.size &&
        [...correctSet].every((c) => submittedSet.has(c) || submittedSet.has(normaliseAnswer(c)))
      );
    }
    if (correctSet.size === 0 || correctSet.size !== submittedSet.size) return false;
    return [...correctSet].every((c) => submittedSet.has(c));
  }

  // single-answer types
  const submittedValues = Array.isArray(submitted) ? submitted : [submitted];
  const first = submittedValues[0];
  if (normOptions.length > 0) {
    const byId = normOptions.find((o) => o.id === String(first));
    if (byId) return byId.correct;
    const byText = normOptions.find((o) => o.text === normaliseAnswer(first));
    if (byText) return byText.correct;
    // boolean answers may be sent as true/false while options say True/False
    const asBool = normaliseAnswer(first);
    const boolHit = normOptions.find((o) => o.text === asBool);
    return Boolean(boolHit?.correct);
  }

  const expected = question.correct_answer;
  if (Array.isArray(expected)) {
    return expected.map(normaliseAnswer).includes(normaliseAnswer(first));
  }
  if (typeof expected === 'boolean') {
    return normaliseAnswer(first) === (expected ? 'true' : 'false');
  }
  if (expected === null || expected === undefined) return false;
  return normaliseAnswer(first) === normaliseAnswer(expected);
}

/** Grades a full answer set. Returns {score, passed, correct_count, total, results}. */
export function gradeAnswers(questions, optionsByQuestion, answers, passingScore = 70) {
  const results = (questions || []).map((q) => {
    const submitted = (answers || []).find((a) => String(a?.question_id) === String(q.id));
    const correct = gradeQuestion(q, optionsByQuestion[q.id] || [], submitted?.answer);
    return { question_id: q.id, correct, explanation: q.explanation || null };
  });
  const total = results.length;
  const correctCount = results.filter((r) => r.correct).length;
  const score = total === 0 ? 0 : Math.round((correctCount / total) * 100 * 100) / 100;
  return {
    score,
    passed: score >= Number(passingScore),
    correct_count: correctCount,
    total_questions: total,
    results,
  };
}

// ---------------------------------------------------------------------------
// Quizzes (student-safe)
// ---------------------------------------------------------------------------

async function loadQuizBank(quizId) {
  const { data: quiz, error } = await supabaseAdmin.from('quizzes').select('*').eq('id', quizId).maybeSingle();
  if (error) throw ApiError.internal('Unable to load quiz');
  if (!quiz) throw ApiError.notFound('Quiz not found', 'QUIZ_NOT_FOUND');
  if (!['APPROVED', 'PUBLISHED'].includes(quiz.status)) {
    throw ApiError.forbidden('This quiz is not available yet', 'QUIZ_NOT_AVAILABLE');
  }

  const { data: questions } = await supabaseAdmin
    .from('quiz_questions')
    .select('*')
    .eq('quiz_id', quiz.id)
    .order('order_number', { ascending: true });

  let options = [];
  if ((questions || []).length > 0) {
    const { data, error: optErr } = await supabaseAdmin
      .from('quiz_options')
      .select('*')
      .in('question_id', questions.map((q) => q.id))
      .order('order_number', { ascending: true });
    if (!optErr) options = data || [];
  }

  return { quiz, questions: questions || [], options };
}

/** Student-safe quiz payload: questions + display options, answers stripped. */
export async function getStudentQuiz(quizId, profile) {
  const { quiz, questions, options } = await loadQuizBank(quizId);
  await requireCourseAccess(quiz.course_id, profile);

  const optionsByQuestion = {};
  for (const q of questions) optionsByQuestion[q.id] = options.filter((o) => o.question_id === q.id);

  let attempts = [];
  let bestScore = null;
  if (profile.role !== 'admin') {
    const { data } = await supabaseAdmin
      .from('quiz_attempts')
      .select('id, score, passed, created_at')
      .eq('quiz_id', quiz.id)
      .eq('student_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(20);
    attempts = data || [];
    if (attempts.length > 0) bestScore = Math.max(...attempts.map((a) => Number(a.score)));
  }

  return {
    quiz: {
      id: quiz.id,
      course_id: quiz.course_id,
      module_id: quiz.module_id,
      topic_id: quiz.topic_id || null,
      lesson_id: quiz.lesson_id,
      assessment_id: quiz.assessment_id || null,
      scope: quiz.scope || 'LESSON',
      title: quiz.title,
      description: quiz.description,
      passing_score: quiz.passing_score,
      time_limit: quiz.time_limit,
      questions: questions.map((q) => toStudentQuestion(q, optionsByQuestion[q.id])),
    },
    my_attempts_count: attempts.length,
    my_best_score: bestScore,
    my_attempts: attempts,
  };
}

/**
 * Grades a submission server-side and records an immutable attempt.
 * Prefers the grade_quiz_attempt() RPC (single implementation); falls
 * back to identical JS grading on pre-migration-014 databases.
 */
export async function submitQuizAttempt(quizId, profile, answers, startedAt = null) {
  const { quiz, questions, options } = await loadQuizBank(quizId);
  await requireCourseAccess(quiz.course_id, profile);

  if (!Array.isArray(answers) || answers.length === 0) {
    throw ApiError.badRequest('Submit at least one answer', 'ANSWERS_REQUIRED');
  }
  if (questions.length === 0) {
    throw ApiError.badRequest('This quiz has no questions yet', 'QUIZ_EMPTY');
  }

  // Assessment attempt caps.
  if (quiz.assessment_id) {
    const { data: assessment } = await supabaseAdmin
      .from('course_assessments')
      .select('max_attempts')
      .eq('id', quiz.assessment_id)
      .maybeSingle();
    if (assessment?.max_attempts) {
      const { count } = await supabaseAdmin
        .from('quiz_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('quiz_id', quiz.id)
        .eq('student_id', profile.id);
      if ((count || 0) >= assessment.max_attempts) {
        throw ApiError.forbidden('No attempts left for this assessment', 'MAX_ATTEMPTS_REACHED');
      }
    }
  }

  // Preferred path: database grades + inserts atomically.
  const { data: graded, error: rpcError } = await supabaseAdmin.rpc('submit_quiz_attempt_for', {
    p_quiz_id: quiz.id,
    p_student_id: profile.id,
    p_answers: answers,
  });

  if (!rpcError && graded) {
    if (startedAt) {
      await supabaseAdmin.from('quiz_attempts').update({ started_at: startedAt }).eq('id', graded.attempt_id);
    }
    return graded;
  }
  if (rpcError && !isMissingRelation(rpcError)) {
    const msg = String(rpcError.message || '');
    if (msg.includes('MAX_ATTEMPTS_REACHED')) {
      throw ApiError.forbidden('No attempts left for this assessment', 'MAX_ATTEMPTS_REACHED');
    }
    if (msg.includes('QUIZ_NOT_AVAILABLE') || msg.includes('QUIZ_EMPTY')) {
      throw ApiError.badRequest('This quiz is not available', 'QUIZ_NOT_AVAILABLE');
    }
    if (msg.includes('COURSE_ACCESS_DENIED')) {
      throw ApiError.forbidden('You do not have access to this course', 'COURSE_ACCESS_DENIED');
    }
    throw ApiError.internal('Unable to grade quiz attempt');
  }

  // Fallback: identical JS grading (pre-migration-014 databases).
  const optionsByQuestion = {};
  for (const q of questions) optionsByQuestion[q.id] = options.filter((o) => o.question_id === q.id);
  const result = gradeAnswers(questions, optionsByQuestion, answers, quiz.passing_score);

  const { data: attempt, error } = await supabaseAdmin
    .from('quiz_attempts')
    .insert({
      quiz_id: quiz.id,
      student_id: profile.id,
      course_id: quiz.course_id,
      score: result.score,
      passed: result.passed,
      total_questions: result.total_questions,
      correct_count: result.correct_count,
      answers,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    if (isMissingRelation(error)) {
      throw ApiError.internal('Quiz attempts require database migration 014 (npm run migrate)');
    }
    throw ApiError.internal('Unable to record quiz attempt');
  }

  // Best-effort completion check (the DB trigger covers migrated DBs).
  try {
    await supabaseAdmin.rpc('check_course_completion', {
      p_student_id: profile.id,
      p_course_id: quiz.course_id,
    });
  } catch {
    /* trigger or RPC handles completion; ignore */
  }

  return {
    attempt_id: attempt.id,
    quiz_id: quiz.id,
    score: result.score,
    passed: result.passed,
    passing_score: quiz.passing_score,
    correct_count: result.correct_count,
    total_questions: result.total_questions,
    results: result.results,
  };
}

/** Attempt history + best score for the calling student. */
export async function getMyAttempts(quizId, profile) {
  const { data: quiz } = await supabaseAdmin.from('quizzes').select('id, course_id, title').eq('id', quizId).maybeSingle();
  if (!quiz) throw ApiError.notFound('Quiz not found', 'QUIZ_NOT_FOUND');
  await requireCourseAccess(quiz.course_id, profile);

  const { data, error } = await supabaseAdmin
    .from('quiz_attempts')
    .select('id, score, passed, total_questions, correct_count, created_at')
    .eq('quiz_id', quiz.id)
    .eq('student_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    if (isMissingRelation(error)) return { quiz, attempts: [], best_score: null };
    throw ApiError.internal('Unable to load attempts');
  }

  return {
    quiz,
    attempts: data || [],
    best_score: (data || []).length > 0 ? Math.max(...data.map((a) => Number(a.score))) : null,
  };
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function getAssignment(assignmentId, profile) {
  const { data: assignment, error } = await supabaseAdmin
    .from('assignments')
    .select('*')
    .eq('id', assignmentId)
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to load assignment');
  if (!assignment) throw ApiError.notFound('Assignment not found', 'ASSIGNMENT_NOT_FOUND');
  if (!['APPROVED', 'PUBLISHED'].includes(assignment.status) && profile.role !== 'admin') {
    throw ApiError.forbidden('This assignment is not available yet', 'ASSIGNMENT_NOT_AVAILABLE');
  }
  await requireCourseAccess(assignment.course_id, profile);

  const { data: submissions } = await supabaseAdmin
    .from('assignment_submissions')
    .select('id, attempt_number, submission_text, file_name, file_type, status, score, feedback, submitted_at, graded_at')
    .eq('assignment_id', assignment.id)
    .eq('student_id', profile.id)
    .order('attempt_number', { ascending: false });

  return { assignment, my_submissions: submissions || [] };
}

export async function createSubmission(assignmentId, profile, { submissionText, file }) {
  const { data: assignment, error } = await supabaseAdmin
    .from('assignments')
    .select('*')
    .eq('id', assignmentId)
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to load assignment');
  if (!assignment) throw ApiError.notFound('Assignment not found', 'ASSIGNMENT_NOT_FOUND');
  if (!['APPROVED', 'PUBLISHED'].includes(assignment.status)) {
    throw ApiError.forbidden('This assignment is not available yet', 'ASSIGNMENT_NOT_AVAILABLE');
  }
  await requireCourseAccess(assignment.course_id, profile);

  const text = typeof submissionText === 'string' ? submissionText.trim() : '';
  if (!text && !file) {
    throw ApiError.badRequest('Submit text, a file, or both', 'SUBMISSION_EMPTY');
  }
  if (text && text.length > 50000) {
    throw ApiError.badRequest('Submission text is too long (max 50,000 characters)', 'SUBMISSION_TOO_LONG');
  }

  const { data: existing } = await supabaseAdmin
    .from('assignment_submissions')
    .select('attempt_number')
    .eq('assignment_id', assignment.id)
    .eq('student_id', profile.id)
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  const attemptNumber = (existing?.attempt_number || 0) + 1;

  let filePath = null;
  let fileName = null;
  let fileType = null;
  if (file) {
    fileName = file.originalname || 'submission';
    fileType = file.mimetype;
    filePath = `${profile.user_id}/${assignment.id}/${Date.now()}-${fileName}`;
    await uploadObject(BUCKETS.submissions, filePath, file.buffer, file.mimetype, { upsert: false });
  }

  const { data, error: insertError } = await supabaseAdmin
    .from('assignment_submissions')
    .insert({
      assignment_id: assignment.id,
      student_id: profile.id,
      course_id: assignment.course_id,
      lesson_id: assignment.lesson_id,
      attempt_number: attemptNumber,
      submission_text: text || null,
      file_path: filePath,
      file_name: fileName,
      file_type: fileType,
      status: 'SUBMITTED',
    })
    .select()
    .single();

  if (insertError) {
    if (isMissingRelation(insertError)) {
      throw ApiError.internal('Assignment submissions require database migration 014 (npm run migrate)');
    }
    throw ApiError.internal('Unable to submit assignment');
  }

  return { submission: data };
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

export async function getAssessments(courseId, profile) {
  const course = await resolveCourse(courseId, { requirePublished: true });
  await requireCourseAccess(course.id, profile);

  const assessments = await optionalList(
    supabaseAdmin
      .from('course_assessments')
      .select('*')
      .eq('course_id', course.id)
      .order('order_number', { ascending: true })
  );

  const visible =
    profile.role === 'admin'
      ? assessments
      : assessments.filter((a) => ['APPROVED', 'PUBLISHED'].includes(a.status));

  const quizzes = await optionalList(
    supabaseAdmin
      .from('quizzes')
      .select('id, assessment_id, title, description, scope, passing_score, time_limit, status, order_number')
      .eq('course_id', course.id)
      .order('order_number', { ascending: true })
  );
  const liveQuizzes = quizzes.filter((q) => ['APPROVED', 'PUBLISHED'].includes(q.status));
  const finalQuizzes = liveQuizzes.filter((q) => q.scope === 'FINAL' || q.assessment_id);

  let attempts = [];
  if (profile.role !== 'admin' && finalQuizzes.length > 0) {
    attempts = await optionalList(
      supabaseAdmin
        .from('quiz_attempts')
        .select('quiz_id, score, passed, created_at')
        .eq('student_id', profile.id)
        .in('quiz_id', finalQuizzes.map((q) => q.id))
        .order('created_at', { ascending: false })
    );
  }

  const withQuizzes = visible.map((a) => {
    const linked = liveQuizzes.filter((q) => q.assessment_id === a.id);
    return {
      ...a,
      quizzes: linked.map((q) => {
        const mine = attempts.filter((t) => t.quiz_id === q.id);
        return {
          ...q,
          my_attempts: mine.length,
          my_best_score: mine.length > 0 ? Math.max(...mine.map((t) => Number(t.score))) : null,
          passed: mine.some((t) => t.passed),
        };
      }),
    };
  });

  const standaloneFinals = finalQuizzes
    .filter((q) => !q.assessment_id)
    .map((q) => {
      const mine = attempts.filter((t) => t.quiz_id === q.id);
      return {
        ...q,
        my_attempts: mine.length,
        my_best_score: mine.length > 0 ? Math.max(...mine.map((t) => Number(t.score))) : null,
        passed: mine.some((t) => t.passed),
      };
    });

  return { assessments: withQuizzes, standalone_final_quizzes: standaloneFinals };
}

/** Gated full classroom assembly (modules → topics → lessons → everything). */
export async function getClassroom(courseId, profile) {
  const course = await resolveCourse(courseId, { requirePublished: true });
  const { enrollment, roleOverride } = await requireCourseAccess(course.id, profile);
  const privileged = Boolean(roleOverride);

  const [status, modules, rules, assessmentsData] = await Promise.all([
    getCurriculumStatus(course.id),
    optionalList(
      supabaseAdmin
        .from('course_modules')
        .select('id, title, description, order_number')
        .eq('course_id', course.id)
        .order('order_number', { ascending: true })
    ),
    optionalSingle(
      supabaseAdmin.from('course_completion_rules').select('*').eq('course_id', course.id).maybeSingle()
    ),
    getAssessments(course.id, profile).catch(() => ({ assessments: [], standalone_final_quizzes: [] })),
  ]);

  const moduleIds = modules.map((m) => m.id);

  const [topics, lessons, progressRows] = await Promise.all([
    moduleIds.length > 0
      ? optionalList(
          supabaseAdmin
            .from('course_topics')
            .select('id, module_id, title, description, summary, order_number, is_published')
            .in('module_id', moduleIds)
            .order('order_number', { ascending: true })
        )
      : [],
    moduleIds.length > 0
      ? optionalList(
          supabaseAdmin
            .from('lessons')
            .select(
              'id, module_id, topic_id, title, description, lesson_type, video_url, content, resource_url, duration, order_number, is_published, is_free_preview'
            )
            .in('module_id', moduleIds)
            .order('order_number', { ascending: true })
        )
      : [],
    privileged
      ? []
      : optionalList(
          supabaseAdmin
            .from('lesson_progress')
            .select('lesson_id, completed, completed_at, last_position, updated_at')
            .eq('student_id', profile.id)
            .eq('course_id', course.id)
        ),
  ]);

  const visibleLessons = privileged ? lessons : lessons.filter(isLessonVisible);
  const visibleTopics = privileged ? topics : topics.filter((t) => t.is_published !== false);
  const lessonIds = visibleLessons.map((l) => l.id);

  const [contents, videos, resources, practicals, assignments, quizzes, questions, options, submissions, attempts] =
    await Promise.all([
      lessonIds.length > 0
        ? optionalList(
            supabaseAdmin
              .from('lesson_contents')
              .select('id, lesson_id, block_type, title, body, url, storage_path, duration_seconds, order_number, is_published')
              .in('lesson_id', lessonIds)
              .order('order_number', { ascending: true })
          )
        : [],
      lessonIds.length > 0
        ? optionalList(
            supabaseAdmin
              .from('lesson_videos')
              .select('id, lesson_id, title, video_url, storage_path, duration, thumbnail_url, transcript, status')
              .in('lesson_id', lessonIds)
              .eq('status', 'COMPLETED')
          )
        : [],
      optionalList(
        supabaseAdmin
          .from('course_resources')
          .select('id, course_id, module_id, lesson_id, topic_id, title, description, url, storage_path, source, license, resource_type, is_external')
          .eq('course_id', course.id)
      ),
      optionalList(
        supabaseAdmin
          .from('lesson_practicals')
          .select('id, lesson_id, module_id, topic_id, title, objective, scenario, instructions, requirements, expected_output, difficulty, estimated_time, status')
          .eq('course_id', course.id)
      ),
      optionalList(supabaseAdmin.from('assignments').select('*').eq('course_id', course.id)),
      optionalList(supabaseAdmin.from('quizzes').select('*').eq('course_id', course.id).order('order_number', { ascending: true })),
      optionalList(
        supabaseAdmin.from('quiz_questions').select('id, quiz_id, question, question_type, difficulty, topic, order_number')
      ),
      optionalList(supabaseAdmin.from('quiz_options').select('id, question_id, option_text, order_number')),
      privileged
        ? []
        : optionalList(
            supabaseAdmin
              .from('assignment_submissions')
              .select('id, assignment_id, attempt_number, status, score, feedback, submitted_at, graded_at')
              .eq('student_id', profile.id)
              .eq('course_id', course.id)
              .order('submitted_at', { ascending: false })
          ),
      privileged
        ? []
        : optionalList(
            supabaseAdmin
              .from('quiz_attempts')
              .select('quiz_id, score, passed, created_at')
              .eq('student_id', profile.id)
              .eq('course_id', course.id)
          ),
    ]);

  const approvedResources = resources.filter((r) => r.is_approved !== false);
  const livePracticals = practicals.filter((p) => !p.status || ['APPROVED', 'PUBLISHED'].includes(p.status));
  const liveAssignments = privileged ? assignments : assignments.filter((a) => ['APPROVED', 'PUBLISHED'].includes(a.status));
  const liveQuizzes = privileged ? quizzes : quizzes.filter((q) => ['APPROVED', 'PUBLISHED'].includes(q.status));
  const visibleContents = privileged ? contents : contents.filter((c) => c.is_published !== false);

  // Signed URLs for private files (never expose raw storage paths).
  const signedContents = await Promise.all(
    visibleContents.map(async (c) => ({
      ...c,
      signed_url: c.storage_path ? await signedUrlOrNull(BUCKETS.courseResources, c.storage_path) : c.url || null,
    }))
  );
  const signedVideos = await Promise.all(
    videos.map(async (v) => ({
      ...v,
      signed_url: v.storage_path ? await signedUrlOrNull(BUCKETS.courseVideos, v.storage_path) : v.video_url || null,
    }))
  );
  const signedResources = await Promise.all(
    approvedResources.map(async (r) => ({
      ...r,
      signed_url: !r.is_external && r.storage_path ? await signedUrlOrNull(BUCKETS.courseResources, r.storage_path) : r.url || null,
    }))
  );

  const questionQuizIds = new Set(liveQuizzes.map((q) => q.id));
  const liveQuestions = questions.filter((q) => questionQuizIds.has(q.quiz_id));
  const liveQuestionIds = new Set(liveQuestions.map((q) => q.id));
  const liveOptions = options.filter((o) => liveQuestionIds.has(o.question_id));

  const fullModules = await Promise.all(
    modules.map(async (m) => {
      const moduleTopics = visibleTopics.filter((t) => t.module_id === m.id);
      const moduleLessons = visibleLessons.filter((l) => l.module_id === m.id);

      const enrichedLessons = await Promise.all(
        moduleLessons.map(async (l) => {
          const resourceSignedUrl =
            l.resource_url && !/^https?:\/\//i.test(l.resource_url)
              ? await signedUrlOrNull(BUCKETS.lessonResources, l.resource_url)
              : null;
          const mySubs = submissions.filter((s) => liveAssignments.some((a) => a.id === s.assignment_id && a.lesson_id === l.id));
          return {
            ...l,
            resource_signed_url: resourceSignedUrl,
            contents: signedContents.filter((c) => c.lesson_id === l.id),
            videos: signedVideos.filter((v) => String(v.lesson_id) === String(l.id)),
            resources: signedResources.filter((r) => String(r.lesson_id) === String(l.id)),
            practicals: livePracticals.filter((p) => String(p.lesson_id) === String(l.id)),
            assignments: liveAssignments
              .filter((a) => a.lesson_id === l.id)
              .map((a) => ({
                ...a,
                my_submissions: submissions.filter((s) => s.assignment_id === a.id),
              })),
            quizzes: liveQuizzes
              .filter((q) => q.lesson_id === l.id)
              .map((q) => {
                const mine = attempts.filter((t) => t.quiz_id === q.id);
                return {
                  id: q.id,
                  title: q.title,
                  description: q.description,
                  scope: q.scope,
                  passing_score: q.passing_score,
                  time_limit: q.time_limit,
                  questions: liveQuestions
                    .filter((qq) => qq.quiz_id === q.id)
                    .map((qq) => ({
                      ...qq,
                      options: liveOptions
                        .filter((o) => o.question_id === qq.id)
                        .map((o) => ({ id: o.id, text: o.option_text, order_number: o.order_number })),
                    })),
                  my_attempts: mine.length,
                  my_best_score: mine.length > 0 ? Math.max(...mine.map((t) => Number(t.score))) : null,
                  passed: mine.some((t) => t.passed),
                };
              }),
            my_submissions_count: mySubs.length,
            progress: progressRows.find((p) => p.lesson_id === l.id) || null,
          };
        })
      );

      return {
        ...m,
        topics: moduleTopics.map((t) => ({
          ...t,
          lessons: enrichedLessons.filter((l) => l.topic_id === t.id),
          lessons_count: enrichedLessons.filter((l) => l.topic_id === t.id).length,
        })),
        lessons: enrichedLessons,
        lessons_count: enrichedLessons.length,
        topics_count: moduleTopics.length,
      };
    })
  );

  const [progress, continueLearning] = await Promise.all([
    getCourseProgress(course.id, profile.id),
    getContinueLearning(course.id, profile.id),
  ]);

  const quizBest = {};
  for (const t of attempts) {
    const s = Number(t.score);
    if (quizBest[t.quiz_id] === undefined || s > quizBest[t.quiz_id]) quizBest[t.quiz_id] = s;
  }
  const bestScores = Object.values(quizBest);

  const { data: certificate } = await supabaseAdmin
    .from('certificates')
    .select('id, certificate_number, issued_at, status')
    .eq('course_id', course.id)
    .eq('student_id', profile.id)
    .maybeSingle();

  return {
    course: { ...course, completion_rules: rules },
    enrollment,
    modules: fullModules,
    progress: {
      ...progress,
      quizzes: {
        total: liveQuizzes.length,
        attempted: Object.keys(quizBest).length,
        average_best_score: bestScores.length > 0 ? Math.round((bestScores.reduce((a, b) => a + b, 0) / bestScores.length) * 100) / 100 : null,
      },
      assignments: {
        total: liveAssignments.length,
        submitted: new Set(submissions.map((s) => s.assignment_id)).size,
        graded: submissions.filter((s) => s.status === 'GRADED').length,
      },
    },
    continue_learning: continueLearning,
    certificate: certificate?.status === 'ACTIVE' ? certificate : null,
    completion_rules: rules,
    assessments: assessmentsData.assessments,
    standalone_final_quizzes: assessmentsData.standalone_final_quizzes,
    curriculum_complete: status.complete,
    curriculum_status: status,
  };
}
