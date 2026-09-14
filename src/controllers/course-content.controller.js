/**
 * WOLI DAN TECH HUB — Course Content Delivery (Student-facing)
 * Per spec sections 30, 32 + Mobile compatibility (spec 33)
 * - Pagination, field selection, lazy loading, separate metadata from detailed content
 * - Avoids sending thousands of lessons/resources in one response
 * - Mobile: Course → Modules → Lessons → Individual lesson
 */

import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function parsePagination(req, defaultLimit = 20, maxLimit = 100) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let limit = parseInt(req.query.limit, 10) || defaultLimit;
  limit = Math.min(Math.max(1, limit), maxLimit);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * GET /api/courses/:courseId/content — complete curriculum
 * Mobile optimized: ?include=modules,lessons,resources,practicals,projects,quizzes,all&minimal=true&fields=
 * For mobile, returns metadata only unless include specified, with links to paginated endpoints
 */
export const getCourseContent = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId || req.params.idOrSlug;
  const { include, minimal } = req.query;
  const includeSet = include ? new Set(include.split(',').map(s => s.trim())) : null;
  const isMobile = req.isMobile || minimal === 'true';

  let courseQuery = supabaseAdmin.from('courses').select('id, title, slug, description, price, is_published, thumbnail_url, duration, difficulty_level');
  courseQuery = isUuid(courseId) ? courseQuery.eq('id', courseId) : courseQuery.eq('slug', courseId);
  const { data: course } = await courseQuery.maybeSingle();

  if (!course || !course.is_published) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  let hasAccess = false;
  if (req.profile) {
    if (req.profile.role === 'admin') hasAccess = true;
    else {
      const { data: enrollment } = await supabaseAdmin.from('enrollments').select('status').eq('course_id', course.id).eq('student_id', req.profile.id).maybeSingle();
      if (enrollment && ['ACTIVE', 'COMPLETED'].includes(enrollment.status)) hasAccess = true;
    }
  }

  // Mobile: return metadata only with links to paginated endpoints if no include
  if (isMobile && !includeSet) {
    const { count: modulesCount } = await supabaseAdmin.from('course_modules').select('id', { count: 'exact', head: true }).eq('course_id', course.id);
    return res.json({
      success: true,
      data: {
        course,
        has_access: hasAccess,
        modules_count: modulesCount || 0,
        message: 'Mobile optimized: use ?include=modules,lessons for full curriculum or /api/mobile/courses/:id/modules for paginated',
        _links: {
          modules: `/api/mobile/courses/${course.id}/modules`,
          content_full: `/api/courses/${course.id}/content?include=modules,lessons,resources`,
        },
      },
    });
  }

  const { page, limit, offset } = parsePagination(req, 50, 100);

  let modulesQuery = supabaseAdmin.from('course_modules').select('id, title, description, order_number', { count: 'exact' }).eq('course_id', course.id).order('order_number');
  if (!includeSet || includeSet.has('modules') || includeSet.has('lessons') || includeSet.has('topics')) {
    modulesQuery = modulesQuery.range(offset, offset + limit - 1);
  } else {
    modulesQuery = modulesQuery.limit(20);
  }
  const { data: modules, count: modulesTotal } = await modulesQuery;
  const moduleIds = (modules || []).map(m => m.id);

  let lessons = [];
  let topics = [];
  if (moduleIds.length > 0 && (!includeSet || includeSet.has('lessons') || includeSet.has('topics'))) {
    const [lessonRes, topicRes] = await Promise.all([
      supabaseAdmin.from('lessons').select('id, module_id, topic_id, title, description, lesson_type, duration, order_number, is_published, is_free_preview').in('module_id', moduleIds).eq('is_published', true).order('order_number').limit(isMobile ? 50 : 100),
      (!includeSet || includeSet.has('topics') || includeSet.has('lessons'))
        ? supabaseAdmin.from('course_topics').select('id, module_id, title, description, order_number, is_published').in('module_id', moduleIds).order('order_number').limit(100)
        : { data: [], error: null },
    ]);
    lessons = lessonRes.data || [];
    // course_topics degrades to [] on pre-migration-014 databases.
    topics = topicRes.error ? [] : (topicRes.data || []);
  }

  let aiContent = [], resources = [], practicals = [], projects = [], quizzes = [], completionRules = null;

  if (!includeSet || includeSet.has('ai_content') || includeSet.has('all')) {
    if (includeSet && (includeSet.has('ai_content') || includeSet.has('all'))) {
      const { data } = await supabaseAdmin.from('ai_generated_content').select('id, content_type, content, version, status, created_at').eq('course_id', course.id).in('status', ['APPROVED', 'PUBLISHED']).order('created_at', { ascending: false }).limit(isMobile ? 10 : 50);
      aiContent = data || [];
    }
  }
  if (includeSet && (includeSet.has('resources') || includeSet.has('all'))) {
    const { data } = await supabaseAdmin.from('course_resources').select('id, title, description, url, source, license, resource_type, is_external').eq('course_id', course.id).eq('is_approved', true).limit(isMobile ? 10 : 20);
    resources = data || [];
  }
  if (includeSet && (includeSet.has('practicals') || includeSet.has('all'))) {
    const { data } = await supabaseAdmin.from('lesson_practicals').select('id, lesson_id, title, objective, difficulty, estimated_time').eq('course_id', course.id).in('status', ['APPROVED', 'PUBLISHED']).limit(isMobile ? 10 : 20);
    practicals = data || [];
  }
  if (includeSet && (includeSet.has('projects') || includeSet.has('all'))) {
    const { data } = await supabaseAdmin.from('course_projects').select('id, title, objective, difficulty, is_final').eq('course_id', course.id).in('status', ['APPROVED', 'PUBLISHED']);
    projects = data || [];
  }
  if (includeSet && (includeSet.has('quizzes') || includeSet.has('all'))) {
    const { data } = await supabaseAdmin.from('quizzes').select('id, lesson_id, module_id, topic_id, title, scope, passing_score').eq('course_id', course.id).in('status', ['APPROVED', 'PUBLISHED']).limit(isMobile ? 10 : 50);
    quizzes = data || [];
  }
  let assessments = [];
  if (includeSet && (includeSet.has('assessments') || includeSet.has('all'))) {
    const { data, error } = await supabaseAdmin.from('course_assessments').select('id, module_id, title, description, assessment_type, passing_score, time_limit_minutes, max_attempts').eq('course_id', course.id).in('status', ['APPROVED', 'PUBLISHED']).limit(20);
    assessments = error ? [] : (data || []);
  }
  if (includeSet && (includeSet.has('completion_rules') || includeSet.has('all'))) {
    const { data } = await supabaseAdmin.from('course_completion_rules').select('*').eq('course_id', course.id).maybeSingle();
    completionRules = data;
  }

  const outline = (modules || []).map(m => ({
    ...m,
    topics: topics.filter(t => t.module_id === m.id),
    lessons: lessons.filter(l => l.module_id === m.id),
  }));
  const totalTopics = outline.reduce((n, m) => n + m.topics.length, 0);

  res.json({
    success: true,
    data: {
      course,
      has_access: hasAccess,
      modules: outline,
      total_lessons: lessons.length,
      total_topics: totalTopics,
      modules_total: modulesTotal || modules.length,
      ...(aiContent.length > 0 ? { ai_content: aiContent } : {}),
      ...(resources.length > 0 ? { resources } : {}),
      ...(practicals.length > 0 ? { practicals } : {}),
      ...(projects.length > 0 ? { projects } : {}),
      ...(quizzes.length > 0 ? { quizzes } : {}),
      ...(assessments.length > 0 ? { assessments } : {}),
      ...(completionRules ? { completion_rules: completionRules } : { completion_rules: { required_lesson_completion_percentage: 80, minimum_quiz_score: 70, assignment_required: false, final_project_required: false } }),
      curriculum_complete: outline.length > 0 && lessons.length > 0,
      curriculum_status: {
        complete: outline.length > 0 && lessons.length > 0,
        modules_count: outline.length,
        topics_count: totalTopics,
        published_lessons_count: lessons.length,
        message: outline.length > 0 && lessons.length > 0
          ? `Curriculum ready — ${outline.length} module(s), ${lessons.length} lesson(s)`
          : 'Curriculum incomplete — this course has no published lessons yet.',
      },
      _meta: {
        mobile_optimized: true,
        pagination: modulesTotal > limit ? { total: modulesTotal, limit, has_more: modulesTotal > limit + offset } : null,
      },
    },
  });
});

/**
 * GET /api/courses/:courseId/modules — modules only, paginated for mobile
 */
export const getCourseModules = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId;
  const { page, limit, offset } = parsePagination(req, 20, 50);

  let q = supabaseAdmin.from('courses').select('id').eq('is_published', true);
  q = isUuid(courseId) ? q.eq('id', courseId) : q.eq('slug', courseId);
  const { data: course } = await q.maybeSingle();
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const { data: modules, error, count } = await supabaseAdmin.from('course_modules').select('id, title, description, order_number, created_at', { count: 'exact' }).eq('course_id', course.id).order('order_number').range(offset, offset + limit - 1);

  if (error) throw ApiError.internal('Unable to load modules');

  res.json({
    success: true,
    data: {
      modules: modules || [],
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/**
 * GET /api/lessons/:lessonId — full lesson with content, video, resources, practical, quiz
 * Access gated: requires ACTIVE enrollment or admin
 * Mobile optimized: returns signed URLs for video/resources, not entire files
 */
export const getLessonDetail = asyncHandler(async (req, res) => {
  const lessonId = req.params.lessonId;

  let lesson = null;
  let moduleId = null;
  let courseId = null;

  const { data: lessonBackend } = await supabaseAdmin.from('lessons').select('id, module_id, topic_id, title, description, lesson_type, content, video_url, resource_url, duration, is_published').eq('id', lessonId).maybeSingle();

  if (lessonBackend) {
    lesson = lessonBackend;
    moduleId = lessonBackend.module_id;
    const { data: mod } = await supabaseAdmin.from('course_modules').select('course_id').eq('id', moduleId).maybeSingle();
    courseId = lessonBackend.course_id || mod?.course_id;
  } else {
    const { data: lessonFrontend } = await supabaseAdmin.from('course_lessons').select('id, module_id, course_id, title, description, content, video_url, duration, published, is_published').eq('id', lessonId).maybeSingle();
    if (lessonFrontend) {
      lesson = lessonFrontend;
      moduleId = lessonFrontend.module_id;
      courseId = lessonFrontend.course_id;
    }
  }

  if (!lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');

  const profile = req.profile;
  if (!profile) throw ApiError.unauthorized('Authentication required');

  const isAdmin = profile.role === 'admin';
  if (!isAdmin) {
    const { data: enrollment } = await supabaseAdmin.from('enrollments').select('status').eq('course_id', courseId).eq('student_id', profile.id).maybeSingle();
    if (!enrollment || !['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
      throw ApiError.forbidden('You need active enrollment to access this lesson', 'COURSE_ACCESS_DENIED');
    }
  }

  // For mobile, lazy load heavy relations only if requested via ?include=
  const { include } = req.query;
  const includeSet = include ? new Set(include.split(',').map(s => s.trim())) : new Set(['video', 'resources', 'practicals', 'quizzes']);

  let aiContent = [], videos = [], resources = [], practicals = [], quizzes = [], quizQuestions = [], assignments = [], ragChunks = [], contents = [], topic = null, mySubmissions = [];

  if (includeSet.has('topic') || includeSet.has('all') || lesson.topic_id) {
    if (lesson.topic_id) {
      const { data, error } = await supabaseAdmin.from('course_topics').select('id, module_id, title, description, order_number').eq('id', lesson.topic_id).maybeSingle();
      if (!error) topic = data || null;
    }
  }

  if (includeSet.has('contents') || includeSet.has('all')) {
    const { data, error } = await supabaseAdmin.from('lesson_contents').select('id, block_type, title, body, url, storage_path, duration_seconds, order_number').eq('lesson_id', lessonId).eq('is_published', true).order('order_number').limit(50);
    if (!error) {
      contents = await Promise.all((data || []).map(async c => {
        if (c.storage_path && !/^https?:\/\//i.test(c.storage_path)) {
          try {
            const { data: signed } = await supabaseAdmin.storage.from('course-resources').createSignedUrl(c.storage_path, 3600);
            return { ...c, signed_url: signed?.signedUrl || null, expires_in: 3600 };
          } catch { return c; }
        }
        return c;
      }));
    }
  }

  if (includeSet.has('ai_content') || includeSet.has('all')) {
    const { data } = await supabaseAdmin.from('ai_generated_content').select('id, content_type, content, version, status').eq('lesson_id', lessonId).in('status', ['APPROVED', 'PUBLISHED']).order('version', { ascending: false }).limit(5);
    aiContent = data || [];
  }

  if (includeSet.has('video') || includeSet.has('all')) {
    const { data } = await supabaseAdmin.from('lesson_videos').select('id, video_url, storage_path, duration, thumbnail_url, status').eq('lesson_id', lessonId).eq('status', 'COMPLETED').order('created_at', { ascending: false }).limit(1);
    videos = data || [];
    // Generate signed URL for private video (efficient delivery, range requests supported)
    if (videos[0]?.storage_path) {
      const { data: signed } = await supabaseAdmin.storage.from('course-videos').createSignedUrl(videos[0].storage_path, 3600);
      if (signed) videos[0] = { ...videos[0], signed_url: signed.signedUrl, expires_in: 3600, range_supported: true, streaming: true };
    }
  }

  if (includeSet.has('resources') || includeSet.has('all')) {
    const { data } = await supabaseAdmin.from('course_resources').select('id, title, description, url, storage_path, source, license, resource_type, is_external').eq('lesson_id', lessonId).eq('is_approved', true).limit(20);
    resources = await Promise.all((data || []).map(async r => {
      if (!r.is_external && r.storage_path) {
        const { data: signed } = await supabaseAdmin.storage.from('course-resources').createSignedUrl(r.storage_path, 3600);
        return { ...r, signed_url: signed?.signedUrl || null, expires_in: 3600 };
      }
      return { ...r, signed_url: r.url };
    }));
  }

  if (includeSet.has('practicals') || includeSet.has('all')) {
    const { data } = await supabaseAdmin.from('lesson_practicals').select('id, title, objective, difficulty, estimated_time').eq('lesson_id', lessonId).in('status', ['APPROVED', 'PUBLISHED']);
    practicals = data || [];
  }

  if (includeSet.has('quizzes') || includeSet.has('all')) {
    const { data } = await supabaseAdmin.from('quizzes').select('id, title, passing_score, description').eq('lesson_id', lessonId).in('status', ['APPROVED', 'PUBLISHED']);
    quizzes = data || [];
    if (quizzes.length > 0) {
      const { data: questions } = await supabaseAdmin.from('quiz_questions').select('id, question, question_type, options, difficulty, topic, order_number').in('quiz_id', quizzes.map(q => q.id)).order('order_number');
      quizQuestions = questions || [];
    }
  }

  if (includeSet.has('assignments') || includeSet.has('all')) {
    const { data } = await supabaseAdmin.from('assignments').select('id, title, description, difficulty, estimated_time, max_score, pass_score, due_date').eq('lesson_id', lessonId).in('status', ['APPROVED', 'PUBLISHED']);
    assignments = data || [];
  }

  if ((includeSet.has('submissions') || includeSet.has('all')) && assignments.length > 0 && req.profile?.role === 'student') {
    const { data, error } = await supabaseAdmin.from('assignment_submissions').select('id, assignment_id, status, score, feedback, submitted_at').in('assignment_id', assignments.map(a => a.id)).eq('student_id', req.profile.id).order('submitted_at', { ascending: false });
    if (!error) mySubmissions = data || [];
  }

  if (includeSet.has('rag') || includeSet.has('all')) {
    const { data } = await supabaseAdmin.from('lesson_content').select('id, content, content_type, chunk_index').eq('lesson_id', lessonId).eq('is_approved', true).limit(5);
    ragChunks = data || [];
  }

  res.json({
    success: true,
    data: {
      lesson,
      course_id: courseId,
      module_id: moduleId,
      topic_id: lesson.topic_id || null,
      ...(topic ? { topic } : {}),
      ...(aiContent.length > 0 ? { ai_content: aiContent } : {}),
      ...(contents.length > 0 ? { contents } : {}),
      video: videos?.[0] || null,
      resources,
      practicals,
      quizzes,
      ...(quizQuestions.length > 0 ? { quiz_questions: quizQuestions } : {}),
      assignments,
      ...(mySubmissions.length > 0 ? { my_submissions: mySubmissions } : {}),
      ...(ragChunks.length > 0 ? { rag_chunks: ragChunks } : {}),
      teaching_standard: {
        has_objectives: !!lesson.description,
        has_examples: aiContent.some(c => c.content?.examples?.length > 0) || contents.some(c => c.block_type === 'EXAMPLE'),
        has_theory: contents.some(c => ['THEORY', 'TEXT'].includes(c.block_type)) || !!lesson.content,
        has_practical: practicals.length > 0,
        has_quiz: quizzes.length > 0,
        has_assignment: assignments.length > 0,
        has_resources: resources.length > 0,
        has_video: !!videos?.[0],
      },
      _meta: {
        mobile_optimized: true,
        hint: 'Use ?include=video,resources,practicals,quizzes,assignments,contents,topic,submissions,ai_content,rag to lazy load',
      },
    },
  });
});
