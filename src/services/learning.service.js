import { supabaseAdmin } from '../config/supabase.js';
import { ApiError } from '../utils/errors.js';

/** Count of published lessons belonging to a course. */
export async function countCourseLessons(courseId) {
  const { count, error } = await supabaseAdmin
    .from('lessons')
    .select('id, course_modules!inner(course_id)', { count: 'exact', head: true })
    .eq('course_modules.course_id', courseId)
    .eq('is_published', true);

  if (error) throw ApiError.internal('Unable to compute course progress');
  return count || 0;
}

/** Count of lessons the student has completed in the course. */
export async function countCompletedLessons(courseId, studentProfileId) {
  const { count, error } = await supabaseAdmin
    .from('lesson_progress')
    .select('id', { count: 'exact', head: true })
    .eq('course_id', courseId)
    .eq('student_id', studentProfileId)
    .eq('completed', true);

  if (error) throw ApiError.internal('Unable to compute course progress');
  return count || 0;
}

/** 13 / 20 lessons -> { completed_lessons, total_lessons, percentage } */
export async function getCourseProgress(courseId, studentProfileId) {
  const [total, completed] = await Promise.all([
    countCourseLessons(courseId),
    countCompletedLessons(courseId, studentProfileId),
  ]);
  const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total_lessons: total, completed_lessons: completed, percentage };
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

/** Per-module completion breakdown (topic-aware when migration 014 exists). */
export async function getModuleProgress(courseId, studentProfileId) {
  const { data: modules, error } = await supabaseAdmin
    .from('course_modules')
    .select('id, title, order_number')
    .eq('course_id', courseId)
    .order('order_number', { ascending: true });
  if (error) throw ApiError.internal('Unable to compute module progress');

  const moduleIds = (modules || []).map((m) => m.id);
  if (moduleIds.length === 0) return [];

  let lessonsSelect = 'id, module_id, is_published';
  let { data: lessons, error: lErr } = await supabaseAdmin
    .from('lessons')
    .select('id, module_id, topic_id, is_published')
    .in('module_id', moduleIds);
  if (lErr && missingRelation(lErr)) {
    const retry = await supabaseAdmin.from('lessons').select(lessonsSelect).in('module_id', moduleIds);
    lessons = retry.data;
    lErr = retry.error;
  }
  if (lErr) throw ApiError.internal('Unable to compute module progress');

  const { data: progress } = await supabaseAdmin
    .from('lesson_progress')
    .select('lesson_id, completed')
    .eq('student_id', studentProfileId)
    .eq('course_id', courseId);
  const done = new Set((progress || []).filter((p) => p.completed).map((p) => p.lesson_id));

  return (modules || []).map((m) => {
    const total = (lessons || []).filter((l) => l.module_id === m.id && l.is_published).length;
    const completed = (lessons || []).filter(
      (l) => l.module_id === m.id && l.is_published && done.has(l.id)
    ).length;
    return {
      module_id: m.id,
      module_title: m.title,
      order_number: m.order_number,
      total_lessons: total,
      completed_lessons: completed,
      percentage: total === 0 ? 0 : Math.round((completed / total) * 100),
    };
  });
}

/** Quiz performance summary: best score per live quiz + average. */
export async function getQuizStats(courseId, studentProfileId) {
  const { data: quizzes, error } = await supabaseAdmin
    .from('quizzes')
    .select('id, title, scope, passing_score, status')
    .eq('course_id', courseId);
  if (error) {
    if (missingRelation(error)) return { total_quizzes: 0, attempted: 0, passed: 0, average_best_score: null, quizzes: [] };
    throw ApiError.internal('Unable to compute quiz statistics');
  }
  const live = (quizzes || []).filter((q) => ['APPROVED', 'PUBLISHED'].includes(q.status));
  if (live.length === 0) {
    return { total_quizzes: 0, attempted: 0, passed: 0, average_best_score: null, quizzes: [] };
  }

  const { data: attempts, error: aErr } = await supabaseAdmin
    .from('quiz_attempts')
    .select('quiz_id, score, passed')
    .eq('student_id', studentProfileId)
    .eq('course_id', courseId);
  if (aErr && !missingRelation(aErr)) throw ApiError.internal('Unable to compute quiz statistics');

  const perQuiz = live.map((q) => {
    const mine = (attempts || []).filter((a) => a.quiz_id === q.id);
    const best = mine.length > 0 ? Math.max(...mine.map((a) => Number(a.score))) : null;
    return {
      quiz_id: q.id,
      title: q.title,
      scope: q.scope,
      passing_score: q.passing_score,
      attempts: mine.length,
      best_score: best,
      passed: best !== null && best >= Number(q.passing_score),
    };
  });

  const attempted = perQuiz.filter((q) => q.attempts > 0).length;
  const passed = perQuiz.filter((q) => q.passed).length;
  const bests = perQuiz.map((q) => q.best_score).filter((s) => s !== null);
  return {
    total_quizzes: live.length,
    attempted,
    passed,
    average_best_score: bests.length > 0 ? Math.round((bests.reduce((a, b) => a + b, 0) / bests.length) * 100) / 100 : null,
    quizzes: perQuiz,
  };
}

/** Assignment performance summary: latest graded score per live assignment. */
export async function getAssignmentStats(courseId, studentProfileId) {
  const { data: assignments, error } = await supabaseAdmin
    .from('assignments')
    .select('id, title, status, pass_score')
    .eq('course_id', courseId);
  if (error) {
    if (missingRelation(error)) {
      return { total_assignments: 0, submitted: 0, graded: 0, passed: 0, assignments: [] };
    }
    throw ApiError.internal('Unable to compute assignment statistics');
  }
  const live = (assignments || []).filter((a) => ['APPROVED', 'PUBLISHED'].includes(a.status));
  if (live.length === 0) {
    return { total_assignments: 0, submitted: 0, graded: 0, passed: 0, assignments: [] };
  }

  const { data: submissions, error: sErr } = await supabaseAdmin
    .from('assignment_submissions')
    .select('assignment_id, status, score, submitted_at')
    .eq('student_id', studentProfileId)
    .eq('course_id', courseId)
    .order('submitted_at', { ascending: false });
  if (sErr && !missingRelation(sErr)) throw ApiError.internal('Unable to compute assignment statistics');

  const perAssignment = live.map((a) => {
    const mine = (submissions || []).filter((s) => s.assignment_id === a.id);
    const graded = mine.find((s) => s.status === 'GRADED' && s.score !== null);
    return {
      assignment_id: a.id,
      title: a.title,
      pass_score: a.pass_score,
      submissions: mine.length,
      latest_status: mine[0]?.status || null,
      score: graded ? Number(graded.score) : null,
      passed: graded ? Number(graded.score) >= Number(a.pass_score ?? 50) : false,
    };
  });

  return {
    total_assignments: live.length,
    submitted: perAssignment.filter((a) => a.submissions > 0).length,
    graded: perAssignment.filter((a) => a.score !== null).length,
    passed: perAssignment.filter((a) => a.passed).length,
    assignments: perAssignment,
  };
}

/**
 * "Continue learning": the most recently touched lesson (with its
 * saved video position) or the first published lesson of the course.
 */
export async function getContinueLearning(courseId, studentProfileId) {
  const { data: latest, error } = await supabaseAdmin
    .from('lesson_progress')
    .select(`lesson_id, last_position, completed, updated_at,
             lessons!inner ( id, title, lesson_type, order_number, is_published,
                             course_modules!inner ( id, title, order_number, course_id ) )`)
    .eq('student_id', studentProfileId)
    .eq('course_id', courseId)
    .eq('lessons.is_published', true)
    .eq('lessons.course_modules.course_id', courseId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw ApiError.internal('Unable to load continue-learning data');

  if (latest?.lessons) {
    return {
      source: 'progress',
      lesson_id: latest.lesson_id,
      lesson_title: latest.lessons.title,
      module_id: latest.lessons.course_modules.id,
      module_title: latest.lessons.course_modules.title,
      last_position: latest.last_position,
      completed: latest.completed,
    };
  }

  // Fallback: first published lesson in the course
  const { data: firstModule } = await supabaseAdmin
    .from('course_modules')
    .select('id, title')
    .eq('course_id', courseId)
    .order('order_number', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!firstModule) return null;

  const { data: firstLesson } = await supabaseAdmin
    .from('lessons')
    .select('id, title')
    .eq('module_id', firstModule.id)
    .eq('is_published', true)
    .order('order_number', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!firstLesson) return null;

  return {
    source: 'start',
    lesson_id: firstLesson.id,
    lesson_title: firstLesson.title,
    module_id: firstModule.id,
    module_title: firstModule.title,
    last_position: 0,
    completed: false,
  };
}
