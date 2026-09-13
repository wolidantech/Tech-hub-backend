import { supabaseAdmin, supabaseAnon } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { parsePagination } from '../utils/helpers.js';
import { getCourseProgress } from '../services/learning.service.js';

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// NOTE: instructor profiles are RLS-protected. The public catalog
// queries courses with the ANON client (so only published courses are
// visible) and the controller merges SAFE instructor fields fetched
// with the service role. No private profile data is ever exposed.
const COURSE_CARD_SELECT = `
  id, title, slug, description, thumbnail_url, price, duration,
  difficulty_level, instructor_id, is_published, created_at,
  course_categories ( id, name )
`;

/** Batch-attaches public instructor info (id, name, photo) to courses. */
async function withInstructors(courses) {
  const list = Array.isArray(courses) ? courses : [courses];
  const ids = [...new Set(list.map((c) => c?.instructor_id).filter(Boolean))];
  if (ids.length === 0) return courses;

  const { data: instructors } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, profile_photo_url')
    .in('id', ids);

  const byId = Object.fromEntries((instructors || []).map((i) => [i.id, i]));
  const attach = (c) => (c ? { ...c, instructor: byId[c.instructor_id] || null } : c);
  return Array.isArray(courses) ? courses.map(attach) : attach(courses);
}

/** GET /api/catalog-status — public, student-safe (no admin instructions) */
export const getCatalogStatus = asyncHandler(async (_req, res) => {
  const { count: publishedCount, error } = await supabaseAnon
    .from('courses')
    .select('id', { count: 'exact', head: true })
    .eq('is_published', true);

  if (error) {
    // Don't leak error details to students
    return res.json({
      success: true,
      data: {
        has_published_courses: false,
        total_published: 0,
        message: 'Catalog temporarily unavailable',
      },
    });
  }

  res.json({
    success: true,
    data: {
      has_published_courses: (publishedCount || 0) > 0,
      total_published: publishedCount || 0,
      message:
        (publishedCount || 0) > 0
          ? `${publishedCount} courses available`
          : 'No courses published yet — check back soon',
    },
  });
});

/** GET /api/course-categories — public */
export const listCategories = asyncHandler(async (_req, res) => {
  const { data, error } = await supabaseAnon
    .from('course_categories')
    .select('id, name, description, created_at')
    .order('name', { ascending: true });

  if (error) throw ApiError.internal('Unable to load categories');
  res.json({ success: true, data: { categories: data } });
});

/** GET /api/courses — public catalog of published courses */
export const listCourses = asyncHandler(async (req, res) => {
  const { category, category_id, search, difficulty } = req.validatedQuery;
  const { from, to, page, limit } = parsePagination(req.validatedQuery);

  // Filtering on an embedded resource requires an !inner join.
  const select = category
    ? COURSE_CARD_SELECT.replace('course_categories (', 'course_categories!inner (')
    : COURSE_CARD_SELECT;

  let query = supabaseAnon
    .from('courses')
    .select(select, { count: 'exact' })
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (category_id) query = query.eq('category_id', category_id);
  if (category) query = query.ilike('course_categories.name', `%${category.replace(/[%_]/g, '')}%`);
  if (difficulty) query = query.eq('difficulty_level', difficulty);
  if (search) query = query.ilike('title', `%${search.replace(/[%_]/g, '')}%`);

  const { data, error, count } = await query;
  if (error) throw ApiError.internal('Unable to load courses');

  res.json({
    success: true,
    data: {
      courses: await withInstructors(data || []),
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/**
 * GET /api/courses/:idOrSlug — public course detail.
 * Returns the curriculum OUTLINE (module/lesson titles only — never
 * video URLs or lesson content) plus enrollment/progress info when
 * the caller is authenticated.
 */
export const getCourse = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.validatedParams;

  let query = supabaseAnon.from('courses').select(COURSE_CARD_SELECT).eq('is_published', true);
  query = isUuid(idOrSlug) ? query.eq('id', idOrSlug) : query.eq('slug', idOrSlug);

  const { data: course, error } = await query.maybeSingle();
  if (error) throw ApiError.internal('Unable to load course');
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  // Curriculum outline — safe columns only (service role, but we
  // deliberately exclude video_url / content / resource_url).
  const { data: modules, error: modulesError } = await supabaseAdmin
    .from('course_modules')
    .select('id, title, description, order_number')
    .eq('course_id', course.id)
    .order('order_number', { ascending: true });

  if (modulesError) throw ApiError.internal('Unable to load course outline');

  const moduleIds = (modules || []).map((m) => m.id);
  let lessons = [];
  if (moduleIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('lessons')
      .select('id, module_id, title, description, lesson_type, duration, order_number')
      .in('module_id', moduleIds)
      .eq('is_published', true)
      .order('order_number', { ascending: true });
    lessons = data || [];
  }

  const outline = (modules || []).map((m) => ({
    ...m,
    lessons: lessons.filter((l) => l.module_id === m.id),
  }));

  // Optional per-user context (enrollment + progress)
  let enrollment = null;
  let progress = null;
  if (req.profile) {
    const { data: enr } = await supabaseAdmin
      .from('enrollments')
      .select('id, status, enrolled_at, completed_at')
      .eq('course_id', course.id)
      .eq('student_id', req.profile.id)
      .maybeSingle();
    enrollment = enr;
    if (enr && ['ACTIVE', 'COMPLETED'].includes(enr.status)) {
      progress = await getCourseProgress(course.id, req.profile.id);
    }
  }

  res.json({
    success: true,
    data: {
      course: { ...(await withInstructors(course)), modules: outline },
      total_lessons: lessons.length,
      enrollment,
      progress,
      has_access: Boolean(enrollment && ['ACTIVE', 'COMPLETED'].includes(enrollment.status)),
    },
  });
});

/**
 * GET /api/courses/:idOrSlug/lessons — FULL lesson content.
 * Strictly gated: admin, the course instructor, or a student whose
 * enrollment is ACTIVE/COMPLETED (i.e. payment APPROVED). Everyone
 * else receives 403 — changing the URL in the browser/frontend
 * cannot unlock lessons.
 */
export const getCourseLessons = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.validatedParams;

  let query = supabaseAdmin.from('courses').select('id, title, instructor_id');
  query = isUuid(idOrSlug) ? query.eq('id', idOrSlug) : query.eq('slug', idOrSlug);
  const { data: course } = await query.maybeSingle();
  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const profile = req.profile;
  const isAdmin = profile.role === 'admin';
  const isInstructor = course.instructor_id === profile.id;

  if (!isAdmin && !isInstructor) {
    const { data: enrollment } = await supabaseAdmin
      .from('enrollments')
      .select('id, status')
      .eq('course_id', course.id)
      .eq('student_id', profile.id)
      .maybeSingle();

    if (!enrollment || !['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
      throw ApiError.forbidden(
        'You do not have access to this course. Complete a verified payment to unlock it.',
        'COURSE_ACCESS_DENIED'
      );
    }
  }

  const { data: modules, error: mErr } = await supabaseAdmin
    .from('course_modules')
    .select('id, title, description, order_number')
    .eq('course_id', course.id)
    .order('order_number', { ascending: true });
  if (mErr) throw ApiError.internal('Unable to load lessons');

  const moduleIds = (modules || []).map((m) => m.id);
  let lessons = [];
  if (moduleIds.length > 0) {
    const { data, error: lErr } = await supabaseAdmin
      .from('lessons')
      .select('id, module_id, title, description, lesson_type, video_url, content, resource_url, duration, order_number, is_published')
      .in('module_id', moduleIds)
      .order('order_number', { ascending: true });
    if (lErr) throw ApiError.internal('Unable to load lessons');
    lessons = isAdmin || isInstructor ? data || [] : (data || []).filter((l) => l.is_published);
  }

  res.json({
    success: true,
    data: {
      course,
      modules: (modules || []).map((m) => ({
        ...m,
        lessons: lessons.filter((l) => l.module_id === m.id),
      })),
    },
  });
});
