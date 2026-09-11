import { supabaseAdmin } from '../config/supabase.js';
import { BUCKETS } from '../config/env.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { createSignedUrl } from '../services/storage.service.js';
import { getCourseProgress, getContinueLearning } from '../services/learning.service.js';

/**
 * Authoritative course-access check. A student may open a course
 * when: enrollment.status in (ACTIVE, COMPLETED). Enrollment only
 * becomes ACTIVE after an admin approves the payment (DB function),
 * so authorization cannot be forged client-side.
 */
async function requireCourseAccess(req, courseId) {
  const profile = req.profile;
  if (profile.role === 'admin') {
    return { enrollment: null, roleOverride: 'admin' };
  }

  const { data: course } = await supabaseAdmin
    .from('courses')
    .select('id, instructor_id')
    .eq('id', courseId)
    .single();

  if (course?.instructor_id === profile.id) {
    return { enrollment: null, roleOverride: 'instructor' };
  }

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

/** Adds short-lived signed URLs for private lesson resource files. */
async function decorateLessons(lessons) {
  return Promise.all(
    (lessons || []).map(async (lesson) => {
      if (lesson.resource_url && !/^https?:\/\//i.test(lesson.resource_url)) {
        try {
          lesson.resource_signed_url = await createSignedUrl(
            BUCKETS.lessonResources,
            lesson.resource_url,
            3600
          );
        } catch {
          lesson.resource_signed_url = null;
        }
      }
      return lesson;
    })
  );
}

/** GET /api/learning/courses/:id — full course player payload */
export const getLearningCourse = asyncHandler(async (req, res) => {
  const courseId = req.validatedParams.id;
  const { enrollment, roleOverride } = await requireCourseAccess(req, courseId);

  const [{ data: course }, { data: modules }] = await Promise.all([
    supabaseAdmin
      .from('courses')
      .select(
        `id, title, slug, description, thumbnail_url, price, duration, difficulty_level,
         course_categories ( id, name ),
         instructor:profiles!courses_instructor_id_fkey ( id, full_name, profile_photo_url )`
      )
      .eq('id', courseId)
      .single(),
    supabaseAdmin
      .from('course_modules')
      .select('id, title, description, order_number')
      .eq('course_id', courseId)
      .order('order_number', { ascending: true }),
  ]);

  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const moduleIds = (modules || []).map((m) => m.id);
  let lessons = [];
  if (moduleIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('lessons')
      .select('id, module_id, title, description, lesson_type, video_url, content, resource_url, duration, order_number, is_published')
      .in('module_id', moduleIds)
      .order('order_number', { ascending: true });
    lessons = roleOverride ? data || [] : (data || []).filter((l) => l.is_published);
  }

  lessons = await decorateLessons(lessons);

  // Student's progress map
  let progressRows = [];
  if (!roleOverride) {
    const { data } = await supabaseAdmin
      .from('lesson_progress')
      .select('lesson_id, completed, last_position, updated_at')
      .eq('student_id', req.profile.id)
      .eq('course_id', courseId);
    progressRows = data || [];
  }

  const [progress, continueLearning] = await Promise.all([
    getCourseProgress(courseId, req.profile.id),
    getContinueLearning(courseId, req.profile.id),
  ]);

  // Certificate (if earned)
  const { data: certificate } = await supabaseAdmin
    .from('certificates')
    .select('id, certificate_number, issued_at, status')
    .eq('course_id', courseId)
    .eq('student_id', req.profile.id)
    .maybeSingle();

  res.json({
    success: true,
    data: {
      course,
      enrollment,
      modules: (modules || []).map((m) => ({
        ...m,
        lessons: lessons
          .filter((l) => l.module_id === m.id)
          .map((l) => ({
            ...l,
            progress: progressRows.find((p) => p.lesson_id === l.id) || null,
          })),
      })),
      progress,
      continue_learning: continueLearning,
      certificate: certificate?.status === 'ACTIVE' ? certificate : null,
    },
  });
});

/** GET /api/learning/lessons/:lessonId — single gated lesson */
export const getLesson = asyncHandler(async (req, res) => {
  const lessonId = req.validatedParams.id;

  const { data: lesson } = await supabaseAdmin
    .from('lessons')
    .select('*, course_modules!inner(id, title, course_id)')
    .eq('id', lessonId)
    .maybeSingle();

  if (!lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');

  await requireCourseAccess(req, lesson.course_modules.course_id);

  const [decorated] = await decorateLessons([lesson]);

  let myProgress = null;
  if (req.profile.role !== 'admin') {
    const { data } = await supabaseAdmin
      .from('lesson_progress')
      .select('completed, last_position, updated_at')
      .eq('student_id', req.profile.id)
      .eq('lesson_id', lessonId)
      .maybeSingle();
    myProgress = data;
  }

  res.json({ success: true, data: { lesson: decorated, my_progress: myProgress } });
});

/**
 * POST /api/learning/lessons/:lessonId/progress
 * Saves last_position (continue learning) and/or marks a lesson
 * complete. Completion cascades in the database: when every
 * published lesson is done the enrollment becomes COMPLETED and a
 * certificate is issued automatically.
 */
export const saveLessonProgress = asyncHandler(async (req, res) => {
  const lessonId = req.validatedParams.id;
  const { completed, last_position } = req.validatedBody;

  const { data: lesson } = await supabaseAdmin
    .from('lessons')
    .select('id, module_id, course_modules!inner(course_id)')
    .eq('id', lessonId)
    .maybeSingle();
  if (!lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');

  const courseId = lesson.course_modules.course_id;
  await requireCourseAccess(req, courseId);

  const payload = {
    student_id: req.profile.id,
    lesson_id: lessonId,
    course_id: courseId,
    updated_at: new Date().toISOString(),
  };
  if (typeof last_position === 'number') payload.last_position = last_position;
  if (completed === true) {
    payload.completed = true;
    payload.completed_at = new Date().toISOString();
  } else if (completed === false) {
    payload.completed = false;
    payload.completed_at = null;
  }

  const { error } = await supabaseAdmin
    .from('lesson_progress')
    .upsert(payload, { onConflict: 'student_id,lesson_id' });

  if (error) throw ApiError.internal('Unable to save progress');

  const progress = await getCourseProgress(courseId, req.profile.id);

  const [{ data: enrollment }, { data: certificate }] = await Promise.all([
    supabaseAdmin
      .from('enrollments')
      .select('status, completed_at')
      .eq('course_id', courseId)
      .eq('student_id', req.profile.id)
      .maybeSingle(),
    supabaseAdmin
      .from('certificates')
      .select('id, certificate_number, issued_at, status')
      .eq('course_id', courseId)
      .eq('student_id', req.profile.id)
      .maybeSingle(),
  ]);

  res.json({
    success: true,
    message: completed ? 'Lesson marked as complete' : 'Progress saved',
    data: {
      progress,
      enrollment_status: enrollment?.status || null,
      course_completed: enrollment?.status === 'COMPLETED',
      certificate: certificate?.status === 'ACTIVE' ? certificate : null,
    },
  });
});

/** GET /api/learning/courses/:id/progress */
export const getProgress = asyncHandler(async (req, res) => {
  const courseId = req.validatedParams.id;
  const { enrollment } = await requireCourseAccess(req, courseId);

  const [progress, continueLearning] = await Promise.all([
    getCourseProgress(courseId, req.profile.id),
    getContinueLearning(courseId, req.profile.id),
  ]);

  res.json({
    success: true,
    data: {
      course_id: courseId,
      progress,
      continue_learning: continueLearning,
      enrollment_status: enrollment?.status || null,
    },
  });
});
