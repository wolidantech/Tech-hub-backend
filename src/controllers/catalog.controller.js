import { supabaseAdmin, supabaseAnon } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { parsePagination } from '../utils/helpers.js';
import { getCourseProgress } from '../services/learning.service.js';
import { getCourseOutline, getClassroom, resolveCourse } from '../services/curriculum.service.js';

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
 * Returns the curriculum OUTLINE (module/topic/lesson titles only —
 * never video URLs or lesson content) plus enrollment/progress info
 * when the caller is authenticated. Also reports curriculum_status so
 * an empty classroom is diagnosable instead of silent.
 */
export const getCourse = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.validatedParams;

  const course = await resolveCourse(idOrSlug, { requirePublished: true });
  const outline = await getCourseOutline(course.id, req.profile || null);

  res.json({
    success: true,
    data: {
      course: { ...course, modules: outline.modules },
      total_lessons: outline.total_lessons,
      counts: outline.counts,
      curriculum_complete: outline.curriculum_complete,
      curriculum_status: outline.curriculum_status,
      enrollment: outline.enrollment,
      progress: outline.progress,
      has_access: outline.has_access,
    },
  });
});

/**
 * GET /api/courses/:idOrSlug/lessons — FULL lesson content.
 * Strictly gated: admin, the course instructor, or a student whose
 * enrollment is ACTIVE/COMPLETED (i.e. payment APPROVED). Everyone
 * else receives 403 — changing the URL in the browser/frontend
 * cannot unlock lessons.
 *
 * Returns the complete classroom chain: modules → topics → lessons →
 * contents / videos / resources / practicals / assignments / quizzes
 * (answers stripped) → assessments → progress → certificate.
 */
export const getCourseLessons = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.validatedParams;

  const course = await resolveCourse(idOrSlug, { requirePublished: false });
  const classroom = await getClassroom(course.id, req.profile);

  res.json({
    success: true,
    data: {
      course: { id: classroom.course.id, title: classroom.course.title, slug: classroom.course.slug },
      enrollment: classroom.enrollment,
      modules: classroom.modules,
      progress: classroom.progress,
      continue_learning: classroom.continue_learning,
      certificate: classroom.certificate,
      completion_rules: classroom.completion_rules,
      assessments: classroom.assessments,
      curriculum_complete: classroom.curriculum_complete,
      curriculum_status: classroom.curriculum_status,
    },
  });
});
