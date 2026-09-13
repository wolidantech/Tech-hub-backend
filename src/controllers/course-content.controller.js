/**
 * WOLI DAN TECH HUB — Course Content Delivery (Student-facing)
 * Per spec sections 30, 32 — real professional school experience
 */

import { supabaseAdmin, supabaseAnon } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * GET /api/courses/:courseId/content — complete curriculum for student
 * Returns only APPROVED/PUBLISHED content, never DRAFT
 */
export const getCourseContent = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId || req.params.idOrSlug;

  let courseQuery = supabaseAdmin.from('courses').select('id, title, slug, description, price, is_published');
  courseQuery = isUuid(courseId) ? courseQuery.eq('id', courseId) : courseQuery.eq('slug', courseId);
  const { data: course } = await courseQuery.maybeSingle();

  if (!course || !course.is_published) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  // Check enrollment for access
  let hasAccess = false;
  if (req.profile) {
    if (req.profile.role === 'admin') hasAccess = true;
    else {
      const { data: enrollment } = await supabaseAdmin
        .from('enrollments')
        .select('status')
        .eq('course_id', course.id)
        .eq('student_id', req.profile.id)
        .maybeSingle();
      if (enrollment && ['ACTIVE', 'COMPLETED'].includes(enrollment.status)) hasAccess = true;
    }
  }

  // Get modules
  const { data: modules } = await supabaseAdmin
    .from('course_modules')
    .select('id, title, description, order_number')
    .eq('course_id', course.id)
    .order('order_number');

  const moduleIds = (modules || []).map(m => m.id);

  // Get lessons (only published)
  let lessons = [];
  if (moduleIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('lessons')
      .select('id, module_id, title, description, lesson_type, duration, order_number, is_published')
      .in('module_id', moduleIds)
      .eq('is_published', true)
      .order('order_number');
    lessons = data || [];
  }

  // Get approved AI content for this course (for RAG and delivery)
  const { data: aiContent } = await supabaseAdmin
    .from('ai_generated_content')
    .select('id, content_type, content, version, status, created_at')
    .eq('course_id', course.id)
    .in('status', ['APPROVED', 'PUBLISHED'])
    .order('created_at', { ascending: false })
    .limit(50);

  // Get approved resources
  const { data: resources } = await supabaseAdmin
    .from('course_resources')
    .select('id, title, description, url, source, license, resource_type, is_external')
    .eq('course_id', course.id)
    .eq('is_approved', true)
    .limit(20);

  // Get practicals (approved)
  const { data: practicals } = await supabaseAdmin
    .from('lesson_practicals')
    .select('id, lesson_id, title, objective, difficulty, estimated_time')
    .eq('course_id', course.id)
    .in('status', ['APPROVED', 'PUBLISHED'])
    .limit(20);

  // Get projects
  const { data: projects } = await supabaseAdmin
    .from('course_projects')
    .select('id, title, objective, difficulty, is_final')
    .eq('course_id', course.id)
    .in('status', ['APPROVED', 'PUBLISHED']);

  // Get quizzes
  const { data: quizzes } = await supabaseAdmin
    .from('quizzes')
    .select('id, lesson_id, module_id, title, passing_score')
    .eq('course_id', course.id)
    .in('status', ['APPROVED', 'PUBLISHED']);

  // Get completion rules
  const { data: completionRules } = await supabaseAdmin
    .from('course_completion_rules')
    .select('*')
    .eq('course_id', course.id)
    .maybeSingle();

  // Build outline with lessons
  const outline = (modules || []).map(m => ({
    ...m,
    lessons: lessons.filter(l => l.module_id === m.id),
  }));

  res.json({
    success: true,
    data: {
      course,
      has_access: hasAccess,
      modules: outline,
      total_lessons: lessons.length,
      ai_content: aiContent || [],
      resources: resources || [],
      practicals: practicals || [],
      projects: projects || [],
      quizzes: quizzes || [],
      completion_rules: completionRules || {
        required_lesson_completion_percentage: 80,
        minimum_quiz_score: 70,
        assignment_required: false,
        final_project_required: false,
      },
      // For frontend to show complete curriculum per spec 32
      curriculum_complete: outline.length > 0 && lessons.length > 0,
    },
  });
});

/**
 * GET /api/courses/:courseId/modules — modules only
 */
export const getCourseModules = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId;
  let q = supabaseAdmin.from('courses').select('id').eq('is_published', true);
  q = isUuid(courseId) ? q.eq('id', courseId) : q.eq('slug', courseId);
  const { data: course } = await q.maybeSingle();
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const { data: modules, error } = await supabaseAdmin
    .from('course_modules')
    .select('id, title, description, order_number, created_at')
    .eq('course_id', course.id)
    .order('order_number');

  if (error) throw ApiError.internal('Unable to load modules');

  res.json({ success: true, data: { modules: modules || [] } });
});

/**
 * GET /api/lessons/:lessonId — full lesson with content, video, resources, practical, quiz
 * Access gated: requires ACTIVE enrollment or admin
 */
export const getLessonDetail = asyncHandler(async (req, res) => {
  const lessonId = req.params.lessonId;

  // Try both lessons and course_lessons tables
  let lesson = null;
  let moduleId = null;
  let courseId = null;

  // Try lessons table first (backend schema)
  const { data: lessonBackend } = await supabaseAdmin
    .from('lessons')
    .select('id, module_id, title, description, lesson_type, content, video_url, resource_url, duration, is_published')
    .eq('id', lessonId)
    .maybeSingle();

  if (lessonBackend) {
    lesson = lessonBackend;
    moduleId = lessonBackend.module_id;
    // Get course_id via module
    const { data: mod } = await supabaseAdmin.from('course_modules').select('course_id').eq('id', moduleId).maybeSingle();
    courseId = mod?.course_id;
  } else {
    // Try course_lessons (frontend schema)
    const { data: lessonFrontend } = await supabaseAdmin
      .from('course_lessons')
      .select('id, module_id, course_id, title, description, content, video_url, duration, published, is_published')
      .eq('id', lessonId)
      .maybeSingle();
    if (lessonFrontend) {
      lesson = lessonFrontend;
      moduleId = lessonFrontend.module_id;
      courseId = lessonFrontend.course_id;
    }
  }

  if (!lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');

  // Check access
  const profile = req.profile;
  if (!profile) throw ApiError.unauthorized('Authentication required');
  
  const isAdmin = profile.role === 'admin';
  if (!isAdmin) {
    const { data: enrollment } = await supabaseAdmin
      .from('enrollments')
      .select('status')
      .eq('course_id', courseId)
      .eq('student_id', profile.id)
      .maybeSingle();
    if (!enrollment || !['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
      throw ApiError.forbidden('You need active enrollment to access this lesson', 'COURSE_ACCESS_DENIED');
    }
  }

  // Get approved AI content for this lesson (RAG-ready)
  const { data: aiContent } = await supabaseAdmin
    .from('ai_generated_content')
    .select('*')
    .eq('lesson_id', lessonId)
    .in('status', ['APPROVED', 'PUBLISHED'])
    .order('version', { ascending: false })
    .limit(5);

  // Get video
  const { data: videos } = await supabaseAdmin
    .from('lesson_videos')
    .select('*')
    .eq('lesson_id', lessonId)
    .eq('status', 'COMPLETED')
    .order('created_at', { ascending: false })
    .limit(1);

  // Get resources
  const { data: resources } = await supabaseAdmin
    .from('course_resources')
    .select('*')
    .eq('lesson_id', lessonId)
    .eq('is_approved', true);

  // Get practicals
  const { data: practicals } = await supabaseAdmin
    .from('lesson_practicals')
    .select('*')
    .eq('lesson_id', lessonId)
    .in('status', ['APPROVED', 'PUBLISHED']);

  // Get quiz
  const { data: quizzes } = await supabaseAdmin
    .from('quizzes')
    .select('id, title, passing_score, description')
    .eq('lesson_id', lessonId)
    .in('status', ['APPROVED', 'PUBLISHED']);

  let quizQuestions = [];
  if (quizzes && quizzes.length > 0) {
    const { data: questions } = await supabaseAdmin
      .from('quiz_questions')
      .select('*')
      .in('quiz_id', quizzes.map(q => q.id))
      .order('order_number');
    quizQuestions = questions || [];
  }

  // Get assignments
  const { data: assignments } = await supabaseAdmin
    .from('assignments')
    .select('*')
    .eq('lesson_id', lessonId)
    .in('status', ['APPROVED', 'PUBLISHED']);

  // Get RAG chunks for DanTECH AI context
  const { data: ragChunks } = await supabaseAdmin
    .from('lesson_content')
    .select('id, content, content_type, chunk_index')
    .eq('lesson_id', lessonId)
    .eq('is_approved', true)
    .limit(10);

  res.json({
    success: true,
    data: {
      lesson,
      course_id: courseId,
      module_id: moduleId,
      ai_content: aiContent || [],
      video: videos?.[0] || null,
      resources: resources || [],
      practicals: practicals || [],
      quizzes: quizzes || [],
      quiz_questions: quizQuestions,
      assignments: assignments || [],
      rag_chunks: ragChunks || [],
      // Professional teaching standard: ensure content has all 13 steps
      teaching_standard: {
        has_objectives: !!lesson.description,
        has_examples: (aiContent || []).some(c => c.content?.examples?.length > 0),
        has_practical: (practicals || []).length > 0,
        has_quiz: (quizzes || []).length > 0,
        has_resources: (resources || []).length > 0,
        has_video: !!videos?.[0],
      },
    },
  });
});
