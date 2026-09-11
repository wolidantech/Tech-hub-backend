import { supabaseAdmin } from '../config/supabase.js';
import { BUCKETS } from '../config/env.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { parsePagination, uniqueSlug, sanitizeFileName, extensionForMime } from '../utils/helpers.js';
import { uploadObject, getPublicUrl, removeObject } from '../services/storage.service.js';
import { logAudit } from '../services/audit.service.js';

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function loadCourse(idOrSlug) {
  let query = supabaseAdmin.from('courses').select('*');
  query = isUuid(idOrSlug) ? query.eq('id', idOrSlug) : query.eq('slug', idOrSlug);
  const { data } = await query.maybeSingle();
  if (!data) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');
  return data;
}

/** GET /api/admin/courses — ALL courses (including unpublished) */
export const adminListCourses = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  let query = supabaseAdmin
    .from('courses')
    .select(
      `id, title, slug, description, thumbnail_url, price, duration, difficulty_level,
       is_published, created_at, updated_at,
       course_categories ( id, name ),
       instructor:profiles!courses_instructor_id_fkey ( id, full_name )`,
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (search) query = query.ilike('title', `%${search.replace(/[%_]/g, '')}%`);

  const { data, error, count } = await query;
  if (error) throw ApiError.internal('Unable to load courses');

  // Enrollment + payment counts per course
  const courses = await Promise.all(
    (data || []).map(async (course) => {
      const [{ count: enrollments }, { data: payments }] = await Promise.all([
        supabaseAdmin
          .from('enrollments')
          .select('id', { count: 'exact', head: true })
          .eq('course_id', course.id),
        supabaseAdmin
          .from('payments')
          .select('amount, status')
          .eq('course_id', course.id)
          .eq('status', 'APPROVED'),
      ]);
      return {
        ...course,
        enrollments_count: enrollments || 0,
        revenue: (payments || []).reduce((sum, p) => sum + Number(p.amount), 0),
      };
    })
  );

  res.json({
    success: true,
    data: {
      courses,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/** GET /api/admin/courses/:idOrSlug — full course incl. modules+lessons */
export const adminGetCourse = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);

  const { data: modules } = await supabaseAdmin
    .from('course_modules')
    .select('id, title, description, order_number, created_at, updated_at')
    .eq('course_id', course.id)
    .order('order_number', { ascending: true });

  const moduleIds = (modules || []).map((m) => m.id);
  let lessons = [];
  if (moduleIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('lessons')
      .select('*')
      .in('module_id', moduleIds)
      .order('order_number', { ascending: true });
    lessons = data || [];
  }

  res.json({
    success: true,
    data: {
      course: {
        ...course,
        modules: (modules || []).map((m) => ({
          ...m,
          lessons: lessons.filter((l) => l.module_id === m.id),
        })),
      },
    },
  });
});

/** POST /api/admin/courses */
export const createCourse = asyncHandler(async (req, res) => {
  const body = req.validatedBody;
  const slug = body.slug || uniqueSlug(body.title);

  const { data: slugClash } = await supabaseAdmin
    .from('courses')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (slugClash) throw ApiError.conflict('A course with this slug already exists', 'SLUG_TAKEN');

  const { data, error } = await supabaseAdmin
    .from('courses')
    .insert({ ...body, slug })
    .select()
    .single();

  if (error) throw ApiError.internal('Unable to create course');

  await logAudit({
    adminId: req.profile.id,
    action: 'COURSE_CREATED',
    targetType: 'course',
    targetId: data.id,
    description: `Created course "${data.title}" (NGN ${data.price})`,
  });

  res.status(201).json({ success: true, message: 'Course created', data: { course: data } });
});

/** PATCH /api/admin/courses/:idOrSlug — includes price changes */
export const updateCourse = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const body = req.validatedBody;

  const { data, error } = await supabaseAdmin
    .from('courses')
    .update(body)
    .eq('id', course.id)
    .select()
    .single();

  if (error) {
    if (String(error.message).includes('courses_slug_key')) {
      throw ApiError.conflict('A course with this slug already exists', 'SLUG_TAKEN');
    }
    throw ApiError.internal('Unable to update course');
  }

  if (body.price !== undefined && Number(body.price) !== Number(course.price)) {
    await logAudit({
      adminId: req.profile.id,
      action: 'COURSE_PRICE_CHANGED',
      targetType: 'course',
      targetId: course.id,
      description: `Price of "${course.title}" changed from NGN ${course.price} to NGN ${data.price}`,
    });
  }
  if (body.is_published === false && course.is_published === true) {
    await logAudit({
      adminId: req.profile.id,
      action: 'COURSE_UNPUBLISHED',
      targetType: 'course',
      targetId: course.id,
      description: `Course "${course.title}" unpublished`,
    });
  }

  res.json({ success: true, message: 'Course updated', data: { course: data } });
});

/** DELETE /api/admin/courses/:idOrSlug */
export const deleteCourse = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);

  // Protect financial/learning records: unpublish instead of deleting
  // when the course has enrollments or payments.
  const { count: refs } = await supabaseAdmin
    .from('payments')
    .select('id', { count: 'exact', head: true })
    .eq('course_id', course.id);
  const { count: enrollments } = await supabaseAdmin
    .from('enrollments')
    .select('id', { count: 'exact', head: true })
    .eq('course_id', course.id);

  if ((refs || 0) > 0 || (enrollments || 0) > 0) {
    const { data } = await supabaseAdmin
      .from('courses')
      .update({ is_published: false })
      .eq('id', course.id)
      .select()
      .single();
    await logAudit({
      adminId: req.profile.id,
      action: 'COURSE_UNPUBLISHED',
      targetType: 'course',
      targetId: course.id,
      description: `Course "${course.title}" has payments/enrollments; unpublished instead of deleted`,
    });
    return res.json({
      success: true,
      message: 'This course has payments or enrollments, so it was unpublished instead of deleted.',
      data: { course: data, deleted: false },
    });
  }

  const { error } = await supabaseAdmin.from('courses').delete().eq('id', course.id);
  if (error) throw ApiError.internal('Unable to delete course');

  await logAudit({
    adminId: req.profile.id,
    action: 'COURSE_DELETED',
    targetType: 'course',
    targetId: course.id,
    description: `Deleted course "${course.title}"`,
  });

  res.json({ success: true, message: 'Course deleted', data: { deleted: true } });
});

/** POST /api/admin/courses/:idOrSlug/thumbnail (multipart: "file") */
export const uploadCourseThumbnail = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  if (!req.file) throw ApiError.badRequest('An image file is required', 'FILE_REQUIRED');

  const ext = extensionForMime(req.file.mimetype) || '.jpg';
  const path = `${course.id}/thumbnail${ext}`;
  await uploadObject(BUCKETS.courseThumbnails, path, req.file.buffer, req.file.mimetype, { upsert: true });
  const url = `${getPublicUrl(BUCKETS.courseThumbnails, path)}?v=${Date.now()}`;

  const { data, error } = await supabaseAdmin
    .from('courses')
    .update({ thumbnail_url: url })
    .eq('id', course.id)
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to save thumbnail');

  res.json({ success: true, message: 'Thumbnail uploaded', data: { course: data } });
});

// ============================ categories ============================

export const createCategory = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('course_categories')
    .insert(req.validatedBody)
    .select()
    .single();
  if (error) {
    if (String(error.message).includes('duplicate key')) {
      throw ApiError.conflict('A category with this name already exists', 'CATEGORY_EXISTS');
    }
    throw ApiError.internal('Unable to create category');
  }
  res.status(201).json({ success: true, message: 'Category created', data: { category: data } });
});

export const updateCategory = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('course_categories')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to update category');
  if (!data) throw ApiError.notFound('Category not found', 'CATEGORY_NOT_FOUND');
  res.json({ success: true, message: 'Category updated', data: { category: data } });
});

export const deleteCategory = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('course_categories')
    .delete()
    .eq('id', req.validatedParams.id)
    .select('id')
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to delete category');
  if (!data) throw ApiError.notFound('Category not found', 'CATEGORY_NOT_FOUND');
  res.json({ success: true, message: 'Category deleted' });
});

// ============================= modules ==============================

export const createModule = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const body = req.validatedBody;

  let orderNumber = body.order_number;
  if (!orderNumber) {
    const { data: last } = await supabaseAdmin
      .from('course_modules')
      .select('order_number')
      .eq('course_id', course.id)
      .order('order_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    orderNumber = (last?.order_number || 0) + 1;
  }

  const { data, error } = await supabaseAdmin
    .from('course_modules')
    .insert({ course_id: course.id, title: body.title, description: body.description, order_number: orderNumber })
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to create module. Check the order number is unique.');

  res.status(201).json({ success: true, message: 'Module created', data: { module: data } });
});

export const updateModule = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('course_modules')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to update module');
  if (!data) throw ApiError.notFound('Module not found', 'MODULE_NOT_FOUND');
  res.json({ success: true, message: 'Module updated', data: { module: data } });
});

export const deleteModule = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('course_modules')
    .delete()
    .eq('id', req.validatedParams.id)
    .select('id')
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to delete module');
  if (!data) throw ApiError.notFound('Module not found', 'MODULE_NOT_FOUND');
  res.json({ success: true, message: 'Module deleted (its lessons were removed too)' });
});

/** POST /api/admin/courses/:idOrSlug/modules/reorder  {ids: [...]} */
export const reorderModules = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.idOrSlug);
  const { error } = await supabaseAdmin.rpc('reorder_modules', {
    p_course_id: course.id,
    p_module_ids: req.validatedBody.ids,
  });
  if (error) throw ApiError.internal('Unable to reorder modules');
  res.json({ success: true, message: 'Modules reordered' });
});

// ============================= lessons ==============================

export const createLesson = asyncHandler(async (req, res) => {
  const moduleId = req.validatedParams.id;
  const body = req.validatedBody;

  const { data: module } = await supabaseAdmin
    .from('course_modules')
    .select('id')
    .eq('id', moduleId)
    .maybeSingle();
  if (!module) throw ApiError.notFound('Module not found', 'MODULE_NOT_FOUND');

  let orderNumber = body.order_number;
  if (!orderNumber) {
    const { data: last } = await supabaseAdmin
      .from('lessons')
      .select('order_number')
      .eq('module_id', moduleId)
      .order('order_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    orderNumber = (last?.order_number || 0) + 1;
  }

  const { data, error } = await supabaseAdmin
    .from('lessons')
    .insert({ ...body, module_id: moduleId, order_number: orderNumber })
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to create lesson. Check the order number is unique.');

  res.status(201).json({ success: true, message: 'Lesson created', data: { lesson: data } });
});

export const updateLesson = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('lessons')
    .update(req.validatedBody)
    .eq('id', req.validatedParams.id)
    .select()
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to update lesson');
  if (!data) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');
  res.json({ success: true, message: 'Lesson updated', data: { lesson: data } });
});

export const deleteLesson = asyncHandler(async (req, res) => {
  const { data: lesson } = await supabaseAdmin
    .from('lessons')
    .select('id, resource_url')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (!lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');

  const { error } = await supabaseAdmin.from('lessons').delete().eq('id', lesson.id);
  if (error) throw ApiError.internal('Unable to delete lesson');

  if (lesson.resource_url && !/^https?:\/\//i.test(lesson.resource_url)) {
    await removeObject(BUCKETS.lessonResources, lesson.resource_url);
  }

  res.json({ success: true, message: 'Lesson deleted' });
});

/** POST /api/admin/modules/:id/lessons/reorder {ids: [...]} */
export const reorderLessons = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.rpc('reorder_lessons', {
    p_module_id: req.validatedParams.id,
    p_lesson_ids: req.validatedBody.ids,
  });
  if (error) throw ApiError.internal('Unable to reorder lessons');
  res.json({ success: true, message: 'Lessons reordered' });
});

/** POST /api/admin/lessons/:id/resource (multipart: "file") */
export const uploadLessonResource = asyncHandler(async (req, res) => {
  const { data: lesson } = await supabaseAdmin
    .from('lessons')
    .select('id, course_modules!inner(course_id)')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (!lesson) throw ApiError.notFound('Lesson not found', 'LESSON_NOT_FOUND');
  if (!req.file) throw ApiError.badRequest('A resource file is required', 'FILE_REQUIRED');

  const ext = extensionForMime(req.file.mimetype) || '';
  const fileName = sanitizeFileName(req.file.originalname);
  const path = `${lesson.course_modules.course_id}/${lesson.id}/${Date.now()}-${fileName}${ext}`;

  await uploadObject(BUCKETS.lessonResources, path, req.file.buffer, req.file.mimetype, { upsert: true });

  const { data, error } = await supabaseAdmin
    .from('lessons')
    .update({ resource_url: path })
    .eq('id', lesson.id)
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to attach resource');

  res.json({
    success: true,
    message: 'Resource uploaded. Students receive a secure link when accessing the lesson.',
    data: { lesson: data },
  });
});
