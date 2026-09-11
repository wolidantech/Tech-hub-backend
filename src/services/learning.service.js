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
