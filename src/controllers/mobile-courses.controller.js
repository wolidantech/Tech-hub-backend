/**
 * WOLI DAN TECH HUB — Mobile-Optimized Course Delivery
 * Per spec 33: pagination, field selection, lazy loading, separate metadata from detailed content
 * Supports: Course → Modules → Lessons → Individual lesson
 * Avoids sending thousands of lessons/resources in one response
 */

import { supabaseAdmin, supabaseAnon } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { parseMobilePagination, buildCursorPagination, applyFieldSelection } from '../middleware/mobile.js';

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Allowed fields for course card (mobile minimal)
const COURSE_CARD_FIELDS = ['id', 'title', 'slug', 'description', 'thumbnail_url', 'price', 'duration', 'difficulty_level', 'instructor_id', 'is_published', 'created_at', 'category'];
const COURSE_DETAIL_FIELDS = [...COURSE_CARD_FIELDS, 'modules_count', 'lessons_count', 'enrollment_count', 'rating'];

// ------------------------------------------------------------------
// GET /api/mobile/courses — paginated, field selection, minimal payload
// ------------------------------------------------------------------
export const listCoursesMobile = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parseMobilePagination(req, 20, 50);
  const { category, category_id, search, difficulty, fields } = req.query;

  // Field selection
  const requestedFields = fields ? fields.split(',').map(f => f.trim()).filter(f => COURSE_CARD_FIELDS.includes(f)) : null;
  const selectFields = requestedFields && requestedFields.length > 0 ? requestedFields.join(', ') : 'id, title, slug, description, thumbnail_url, price, duration, difficulty_level, created_at';

  let query = supabaseAnon
    .from('courses')
    .select(selectFields + ', course_categories(id, name)', { count: 'exact' })
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (category_id) query = query.eq('category_id', category_id);
  if (category) query = query.ilike('course_categories.name', `%${category.replace(/[%_]/g, '')}%`);
  if (difficulty) query = query.eq('difficulty_level', difficulty);
  if (search) query = query.ilike('title', `%${search.replace(/[%_]/g, '')}%`);

  const { data, error, count } = await query;
  if (error) throw ApiError.internal('Unable to load courses');

  // For minimal mode, strip description to 100 chars
  let courses = data || [];
  if (req.minimal) {
    courses = courses.map(c => ({
      ...c,
      description: c.description ? c.description.slice(0, 100) + (c.description.length > 100 ? '...' : '') : null,
    }));
  }

  if (requestedFields) {
    courses = applyFieldSelection(courses, COURSE_CARD_FIELDS, fields);
  }

  const { pagination } = buildCursorPagination({ data: courses, limit, offset, total: count });

  res.json({
    success: true,
    data: {
      courses,
      pagination: {
        page,
        limit,
        total: count || 0,
        total_pages: Math.ceil((count || 0) / limit),
        ...pagination.pagination,
      },
    },
  });
});

// ------------------------------------------------------------------
// GET /api/mobile/courses/:idOrSlug — metadata only, no lessons
// ------------------------------------------------------------------
export const getCourseMetadata = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.params;
  const { fields } = req.query;

  let query = supabaseAnon.from('courses').select('id, title, slug, description, thumbnail_url, price, duration, difficulty_level, instructor_id, is_published, created_at, course_categories(id, name)').eq('is_published', true);
  query = isUuid(idOrSlug) ? query.eq('id', idOrSlug) : query.eq('slug', idOrSlug);

  const { data: course, error } = await query.maybeSingle();
  if (error) throw ApiError.internal('Unable to load course');
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  // Get counts without loading all lessons (avoid huge payload)
  const { count: modulesCount } = await supabaseAdmin.from('course_modules').select('id', { count: 'exact', head: true }).eq('course_id', course.id);
  let lessonsCount = 0;
  if (modulesCount > 0) {
    const { data: modules } = await supabaseAdmin.from('course_modules').select('id').eq('course_id', course.id);
    const moduleIds = (modules || []).map(m => m.id);
    if (moduleIds.length > 0) {
      const { count } = await supabaseAdmin.from('lessons').select('id', { count: 'exact', head: true }).in('module_id', moduleIds).eq('is_published', true);
      lessonsCount = count || 0;
    }
  }

  let result = {
    ...course,
    modules_count: modulesCount || 0,
    lessons_count: lessonsCount,
  };

  if (fields) {
    result = applyFieldSelection(result, COURSE_DETAIL_FIELDS, fields);
  }

  // Enrollment check if authenticated
  let enrollment = null;
  let hasAccess = false;
  if (req.profile) {
    const { data: enr } = await supabaseAdmin.from('enrollments').select('id, status').eq('course_id', course.id).eq('student_id', req.profile.id).maybeSingle();
    enrollment = enr;
    hasAccess = Boolean(enr && ['ACTIVE', 'COMPLETED'].includes(enr.status));
  }

  res.json({
    success: true,
    data: {
      course: result,
      enrollment,
      has_access: hasAccess,
    },
  });
});

// ------------------------------------------------------------------
// GET /api/mobile/courses/:idOrSlug/modules — paginated modules
// ------------------------------------------------------------------
export const listModulesMobile = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.params;
  const { page, limit, offset } = parseMobilePagination(req, 20, 50);

  let courseQuery = supabaseAnon.from('courses').select('id').eq('is_published', true);
  courseQuery = isUuid(idOrSlug) ? courseQuery.eq('id', idOrSlug) : courseQuery.eq('slug', idOrSlug);
  const { data: course } = await courseQuery.maybeSingle();
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const { data: modules, error, count } = await supabaseAdmin
    .from('course_modules')
    .select('id, title, description, order_number, created_at', { count: 'exact' })
    .eq('course_id', course.id)
    .order('order_number', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw ApiError.internal('Unable to load modules');

  // For each module, get lessons count (not full lessons) to avoid N+1, batch query
  const moduleIds = (modules || []).map(m => m.id);
  let lessonsCountMap = {};
  if (moduleIds.length > 0) {
    const { data: lessons } = await supabaseAdmin.from('lessons').select('module_id').in('module_id', moduleIds).eq('is_published', true);
    for (const l of lessons || []) {
      lessonsCountMap[l.module_id] = (lessonsCountMap[l.module_id] || 0) + 1;
    }
  }

  const enriched = (modules || []).map(m => ({
    ...m,
    lessons_count: lessonsCountMap[m.id] || 0,
  }));

  const { pagination } = buildCursorPagination({ data: enriched, limit, offset, total: count });

  res.json({
    success: true,
    data: {
      modules: enriched,
      pagination: {
        page,
        limit,
        total: count || 0,
        total_pages: Math.ceil((count || 0) / limit),
        ...pagination.pagination,
      },
    },
  });
});

// ------------------------------------------------------------------
// GET /api/mobile/courses/:idOrSlug/modules/:moduleId/lessons — paginated lessons metadata
// ------------------------------------------------------------------
export const listTopicsMobile = asyncHandler(async (req, res) => {
  const { idOrSlug, moduleId } = req.params;
  const { page, limit, offset } = parseMobilePagination(req, 20, 50);

  let courseQuery = supabaseAnon.from('courses').select('id').eq('is_published', true);
  courseQuery = isUuid(idOrSlug) ? courseQuery.eq('id', idOrSlug) : courseQuery.eq('slug', idOrSlug);
  const { data: course } = await courseQuery.maybeSingle();
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const { data: module } = await supabaseAdmin.from('course_modules').select('id, course_id').eq('id', moduleId).eq('course_id', course.id).maybeSingle();
  if (!module) throw ApiError.notFound('Module not found', 'MODULE_NOT_FOUND');

  const { data: topics, error, count } = await supabaseAdmin
    .from('course_topics')
    .select('id, module_id, title, description, order_number, is_published', { count: 'exact' })
    .eq('module_id', moduleId)
    .order('order_number', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    // Pre-migration-014 databases have no topics layer.
    const msg = String(error.message || '').toLowerCase();
    if (error.code === 'PGRST205' || error.code === '42P01' || msg.includes('does not exist') || msg.includes('schema cache')) {
      return res.json({
        success: true,
        data: {
          topics: [],
          pagination: { page, limit, total: 0, total_pages: 0 },
        },
      });
    }
    throw ApiError.internal('Unable to load topics');
  }

  const visible = (topics || []).filter((t) => t.is_published !== false);
  const { pagination } = buildCursorPagination({ data: visible, limit, offset, total: count });

  res.json({
    success: true,
    data: {
      topics: visible,
      pagination: {
        page,
        limit,
        total: count || 0,
        total_pages: Math.ceil((count || 0) / limit),
        ...pagination.pagination,
      },
    },
  });
});

export const listLessonsMobile = asyncHandler(async (req, res) => {
  const { idOrSlug, moduleId } = req.params;
  const { topic_id } = req.query;
  const { page, limit, offset } = parseMobilePagination(req, 20, 50);

  let courseQuery = supabaseAnon.from('courses').select('id').eq('is_published', true);
  courseQuery = isUuid(idOrSlug) ? courseQuery.eq('id', idOrSlug) : courseQuery.eq('slug', idOrSlug);
  const { data: course } = await courseQuery.maybeSingle();
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const { data: module } = await supabaseAdmin.from('course_modules').select('id, course_id').eq('id', moduleId).eq('course_id', course.id).maybeSingle();
  if (!module) throw ApiError.notFound('Module not found', 'MODULE_NOT_FOUND');

  let lessonsQuery = supabaseAdmin
    .from('lessons')
    .select('id, module_id, topic_id, title, description, lesson_type, duration, order_number, is_published, is_free_preview, created_at', { count: 'exact' })
    .eq('module_id', moduleId)
    .eq('is_published', true)
    .order('order_number', { ascending: true })
    .range(offset, offset + limit - 1);

  if (topic_id && isUuid(topic_id)) lessonsQuery = lessonsQuery.eq('topic_id', topic_id);

  let { data: lessons, error, count } = await lessonsQuery;

  if (error && (error.code === '42703' || String(error.message || '').toLowerCase().includes('topic_id'))) {
    // Pre-migration-014 databases lack topic_id / is_free_preview.
    const retry = await supabaseAdmin
      .from('lessons')
      .select('id, module_id, title, description, lesson_type, duration, order_number, is_published, created_at', { count: 'exact' })
      .eq('module_id', moduleId)
      .eq('is_published', true)
      .order('order_number', { ascending: true })
      .range(offset, offset + limit - 1);
    lessons = retry.data;
    error = retry.error;
    count = retry.count;
  }

  if (error) throw ApiError.internal('Unable to load lessons');

  const { pagination } = buildCursorPagination({ data: lessons || [], limit, offset, total: count });

  res.json({
    success: true,
    data: {
      lessons: lessons || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        total_pages: Math.ceil((count || 0) / limit),
        ...pagination.pagination,
      },
    },
  });
});

// ------------------------------------------------------------------
// GET /api/mobile/lessons/:lessonId — individual lesson metadata + progress
// ------------------------------------------------------------------
export const getLessonMobile = asyncHandler(async (req, res) => {
  const { lessonId } = req.params;

  let { data: lesson, error } = await supabaseAdmin
    .from('lessons')
    .select('id, module_id, topic_id, title, description, lesson_type, duration, order_number, is_published, is_free_preview')
    .eq('id', lessonId)
    .eq('is_published', true)
    .maybeSingle();

  if (error && (error.code === '42703' || String(error.message || '').toLowerCase().includes('topic_id'))) {
    // Pre-migration-014 databases lack topic_id / is_free_preview.
    const retry = await supabaseAdmin
      .from('lessons')
      .select('id, module_id, title, description, lesson_type, duration, order_number, is_published')
      .eq('id', lessonId)
      .eq('is_published', true)
      .maybeSingle();
    lesson = retry.data;
    error = retry.error;
  }

  if (error || !lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');

  // Get module and course for access check
  const { data: mod } = await supabaseAdmin.from('course_modules').select('course_id, title').eq('id', lesson.module_id).maybeSingle();
  if (!mod) throw ApiError.notFound('Module not found', 'MODULE_NOT_FOUND');

  // Access check
  if (req.profile) {
    const isAdmin = req.profile.role === 'admin';
    if (!isAdmin) {
      const { data: enrollment } = await supabaseAdmin.from('enrollments').select('status').eq('course_id', mod.course_id).eq('student_id', req.profile.id).maybeSingle();
      if (!enrollment || !['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
        throw ApiError.forbidden('You need active enrollment to access this lesson', 'COURSE_ACCESS_DENIED');
      }
    }
  } else {
    throw ApiError.unauthorized('Authentication required');
  }

  // Get progress if exists
  let progress = null;
  if (req.profile) {
    const { data: prog } = await supabaseAdmin.from('lesson_progress').select('completed, completed_at, last_position').eq('lesson_id', lessonId).eq('student_id', req.profile.id).maybeSingle();
    progress = prog;
  }

  res.json({
    success: true,
    data: {
      lesson,
      module: mod,
      course_id: mod.course_id,
      progress,
    },
  });
});

// ------------------------------------------------------------------
// GET /api/mobile/lessons/:lessonId/video — efficient video delivery signed URL
// ------------------------------------------------------------------
export const getLessonVideoMobile = asyncHandler(async (req, res) => {
  const { lessonId } = req.params;
  const { quality = 'auto' } = req.query;

  // Check lesson exists and access
  const { data: lesson } = await supabaseAdmin.from('lessons').select('id, module_id').eq('id', lessonId).maybeSingle();
  if (!lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');

  const { data: mod } = await supabaseAdmin.from('course_modules').select('course_id').eq('id', lesson.module_id).maybeSingle();
  if (!mod) throw ApiError.notFound('Module not found', 'MODULE_NOT_FOUND');

  if (req.profile) {
    const isAdmin = req.profile.role === 'admin';
    if (!isAdmin) {
      const { data: enrollment } = await supabaseAdmin.from('enrollments').select('status').eq('course_id', mod.course_id).eq('student_id', req.profile.id).maybeSingle();
      if (!enrollment || !['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
        throw ApiError.forbidden('Access denied', 'COURSE_ACCESS_DENIED');
      }
    }
  } else {
    throw ApiError.unauthorized('Authentication required');
  }

  // Try lesson_videos table first (AI generated)
  const { data: video } = await supabaseAdmin.from('lesson_videos').select('id, video_url, storage_path, duration, thumbnail_url, status').eq('lesson_id', lessonId).eq('status', 'COMPLETED').order('created_at', { ascending: false }).limit(1).maybeSingle();

  if (video) {
    let signedUrl = video.video_url;
    if (video.storage_path) {
      // Generate signed URL with range request support, CDN-compatible
      const expiresIn = 3600; // 1h for video
      const { data: signed, error } = await supabaseAdmin.storage.from('course-videos').createSignedUrl(video.storage_path, expiresIn);
      if (!error && signed) signedUrl = signed.signedUrl;
    }

    if (!signedUrl) throw ApiError.notFound('Video not available', 'VIDEO_NOT_FOUND');

    // Return metadata + signed URL, not entire video
    return res.json({
      success: true,
      data: {
        video: {
          id: video.id,
          duration: video.duration,
          thumbnail_url: video.thumbnail_url,
          url: signedUrl,
          expires_in: 3600,
          quality,
          streaming: true,
          range_supported: true,
        },
      },
    });
  }

  // Fallback to lessons.video_url (legacy)
  const { data: lessonWithVideo } = await supabaseAdmin.from('lessons').select('video_url').eq('id', lessonId).maybeSingle();
  if (lessonWithVideo?.video_url) {
    return res.json({
      success: true,
      data: {
        video: {
          url: lessonWithVideo.video_url,
          streaming: false,
          range_supported: false,
        },
      },
    });
  }

  throw ApiError.notFound('Video not found for this lesson', 'VIDEO_NOT_FOUND');
});

// ------------------------------------------------------------------
// GET /api/mobile/lessons/:lessonId/resources — paginated resources with signed URLs
// ------------------------------------------------------------------
export const getLessonResourcesMobile = asyncHandler(async (req, res) => {
  const { lessonId } = req.params;
  const { page, limit, offset } = parseMobilePagination(req, 20, 50);

  const { data: lesson } = await supabaseAdmin.from('lessons').select('module_id').eq('id', lessonId).maybeSingle();
  if (!lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');

  const { data: mod } = await supabaseAdmin.from('course_modules').select('course_id').eq('id', lesson.module_id).maybeSingle();
  if (!mod) throw ApiError.notFound('Module not found', 'MODULE_NOT_FOUND');

  // Access check
  if (req.profile) {
    const isAdmin = req.profile.role === 'admin';
    if (!isAdmin) {
      const { data: enrollment } = await supabaseAdmin.from('enrollments').select('status').eq('course_id', mod.course_id).eq('student_id', req.profile.id).maybeSingle();
      if (!enrollment || !['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
        throw ApiError.forbidden('Access denied', 'COURSE_ACCESS_DENIED');
      }
    }
  }

  const { data: resources, error, count } = await supabaseAdmin
    .from('course_resources')
    .select('id, title, description, url, storage_path, source, license, resource_type, is_external', { count: 'exact' })
    .eq('lesson_id', lessonId)
    .eq('is_approved', true)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw ApiError.internal('Unable to load resources');

  // Generate signed URLs for private resources
  const enriched = await Promise.all((resources || []).map(async (r) => {
    if (!r.is_external && r.storage_path) {
      const { data: signed } = await supabaseAdmin.storage.from('course-resources').createSignedUrl(r.storage_path, 3600);
      return { ...r, signed_url: signed?.signedUrl || null, expires_in: 3600 };
    }
    return { ...r, signed_url: r.url, expires_in: null };
  }));

  const { pagination } = buildCursorPagination({ data: enriched, limit, offset, total: count });

  res.json({
    success: true,
    data: {
      resources: enriched,
      pagination: {
        page,
        limit,
        total: count || 0,
        total_pages: Math.ceil((count || 0) / limit),
        ...pagination.pagination,
      },
    },
  });
});
