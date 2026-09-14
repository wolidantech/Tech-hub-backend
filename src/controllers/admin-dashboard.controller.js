import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { parsePagination } from '../utils/helpers.js';
import { logAudit } from '../services/audit.service.js';

/** GET /api/admin/statistics — revenue counts APPROVED payments only */
export const getStatistics = asyncHandler(async (_req, res) => {
  const { data, error } = await supabaseAdmin.rpc('admin_statistics');
  if (error) {
    console.error('[admin-statistics]', error.message);
    throw ApiError.internal('Unable to compute statistics');
  }

  // Live additions: latest pending payments + recent enrollments
  const [{ data: recentPayments }, { data: recentEnrollments }] = await Promise.all([
    supabaseAdmin
      .from('payments')
      .select(
        `id, amount, transaction_reference, status, submitted_at,
         student:profiles!payments_student_id_fkey ( full_name, email ),
         course:courses!payments_course_id_fkey ( title )`
      )
      .eq('status', 'PENDING')
      .order('submitted_at', { ascending: false })
      .limit(5),
    supabaseAdmin
      .from('enrollments')
      .select(
        `id, status, enrolled_at,
         student:profiles!enrollments_student_id_fkey ( full_name ),
         course:courses!enrollments_course_id_fkey ( title )`
      )
      .order('enrolled_at', { ascending: false })
      .limit(5),
  ]);

  res.json({
    success: true,
    data: {
      statistics: data,
      recent_pending_payments: recentPayments || [],
      recent_enrollments: recentEnrollments || [],
    },
  });
});

/** GET /api/admin/audit-logs */
export const getAuditLogs = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);

  const { data, error, count } = await supabaseAdmin
    .from('audit_logs')
    .select(
      `id, action, target_type, target_id, description, created_at,
       admin:profiles!audit_logs_admin_id_fkey ( id, full_name, email )`,
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw ApiError.internal('Unable to load audit logs');

  res.json({
    success: true,
    data: {
      audit_logs: data,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/** GET /api/admin/settings */
export const getSettings = asyncHandler(async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('platform_settings')
    .select('key, value, is_public, updated_at')
    .order('key', { ascending: true });

  if (error) throw ApiError.internal('Unable to load settings');
  res.json({ success: true, data: { settings: data } });
});

/** PUT /api/admin/settings/:key — e.g. bank_details (audited) */
export const updateSetting = asyncHandler(async (req, res) => {
  const key = req.params.key;
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(key)) {
    throw ApiError.badRequest('Invalid setting key', 'INVALID_SETTING_KEY');
  }

  const { value, is_public } = req.validatedBody;

  const { data, error } = await supabaseAdmin
    .from('platform_settings')
    .upsert(
      {
        key,
        value,
        ...(is_public !== undefined ? { is_public } : {}),
        updated_at: new Date().toISOString(),
        updated_by: req.profile.id,
      },
      { onConflict: 'key' }
    )
    .select()
    .single();

  if (error) throw ApiError.internal('Unable to save setting');

  await logAudit({
    adminId: req.profile.id,
    action: 'SETTING_UPDATED',
    targetType: 'setting',
    targetId: null,
    description: `Setting "${key}" updated`,
  });

  res.json({ success: true, message: `Setting "${key}" saved`, data: { setting: data } });
});

/** GET /api/admin/diagnostics — admin-only backend health (replaces frontend anon diagnostics) */
export const getDiagnostics = asyncHandler(async (_req, res) => {
  const [{ count: totalCourses }, { count: publishedCourses }, { count: draftCourses }, { count: totalCategories }, { count: totalAdmins }, { count: totalStudents }, { count: pendingPayments }] =
    await Promise.all([
      supabaseAdmin.from('courses').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('courses').select('id', { count: 'exact', head: true }).eq('is_published', true),
      supabaseAdmin.from('courses').select('id', { count: 'exact', head: true }).eq('is_published', false),
      supabaseAdmin.from('course_categories').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin'),
      supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'),
      supabaseAdmin.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'PENDING'),
    ]);

  const catalogStatus = publishedCourses > 0 ? 'PASS' : totalCourses > 0 ? 'FAIL_DRAFTS_ONLY' : 'FAIL_EMPTY';
  const adminStatus = totalAdmins > 0 ? 'PASS' : 'FAIL_NO_ADMIN';

  // ---- curriculum health: why would a classroom be empty? ----
  const { data: courses } = await supabaseAdmin
    .from('courses')
    .select('id, title, slug, is_published')
    .order('created_at', { ascending: false })
    .limit(100);

  const { data: allModules } = await supabaseAdmin
    .from('course_modules')
    .select('id, course_id');
  const moduleCourseIds = new Set((allModules || []).map((m) => m.course_id));
  const { data: allLessons } = await supabaseAdmin
    .from('lessons')
    .select('id, module_id, is_published')
    .limit(5000);
  const lessonsByModule = new Map();
  for (const l of allLessons || []) {
    if (!lessonsByModule.has(l.module_id)) lessonsByModule.set(l.module_id, { total: 0, published: 0 });
    const entry = lessonsByModule.get(l.module_id);
    entry.total += 1;
    if (l.is_published) entry.published += 1;
  }

  const emptyCourses = (courses || [])
    .map((c) => {
      const modules = (allModules || []).filter((m) => m.course_id === c.id);
      const publishedLessons = modules.reduce(
        (n, m) => n + (lessonsByModule.get(m.id)?.published || 0),
        0
      );
      return {
        id: c.id,
        title: c.title,
        slug: c.slug,
        is_published: c.is_published,
        modules_count: modules.length,
        published_lessons_count: publishedLessons,
        classroom_empty: modules.length === 0 || publishedLessons === 0,
      };
    })
    .filter((c) => c.classroom_empty);

  const curriculumStatus =
    (courses || []).length === 0
      ? 'FAIL_EMPTY'
      : emptyCourses.length === 0
        ? 'PASS'
        : 'WARN_EMPTY_CLASSROOMS';

  res.json({
    success: true,
    data: {
      checked_at: new Date().toISOString(),
      catalog: {
        status: catalogStatus,
        total: totalCourses || 0,
        published: publishedCourses || 0,
        drafts: draftCourses || 0,
        categories: totalCategories || 0,
        message:
          catalogStatus === 'PASS'
            ? `Catalog OK — ${publishedCourses} published courses visible to students`
            : catalogStatus === 'FAIL_DRAFTS_ONLY'
              ? `Catalog hidden — ${draftCourses} courses exist but all are drafts (is_published=false). Run supabase/seed/publish_courses.sql`
              : 'Catalog empty — no courses in database. Run supabase/seed/seed_12_courses.sql then publish_courses.sql',
        fix: catalogStatus === 'PASS' ? null : 'Run supabase/seed/seed_12_courses.sql then supabase/seed/publish_courses.sql in Supabase SQL Editor, or npm run migrate',
      },
      admin: {
        status: adminStatus,
        total_admins: totalAdmins || 0,
        total_students: totalStudents || 0,
        pending_payments: pendingPayments || 0,
        message:
          adminStatus === 'PASS'
            ? `${totalAdmins} admin account(s) exist`
            : 'No admin account — signup creates student role only. Run supabase/seed/make_admin.sql with your email after registering',
        fix: adminStatus === 'PASS' ? null : 'Register on site first, then run supabase/seed/make_admin.sql with your email',
      },
      curriculum: {
        status: curriculumStatus,
        courses_checked: (courses || []).length,
        empty_classrooms: emptyCourses.length,
        courses_needing_curriculum: emptyCourses,
        message:
          curriculumStatus === 'PASS'
            ? 'Every course has published lessons — classrooms can open.'
            : curriculumStatus === 'FAIL_EMPTY'
              ? 'No courses in database — nothing to teach yet.'
              : `${emptyCourses.length} course(s) will show an EMPTY classroom (no modules or no published lessons). Build curriculum via /api/admin modules/lessons/topics or POST /api/admin/courses/:id/publish.`,
        fix:
          curriculumStatus === 'PASS'
            ? null
            : 'For each listed course: add modules → topics → lessons, publish them (POST /api/admin/courses/:slug/publish), then verify GET /api/classroom/:slug/outline shows curriculum_complete=true.',
      },
    },
  });
});

/** GET /api/admin/enrollments */
export const adminListEnrollments = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);
  const status = typeof req.query.status === 'string' ? req.query.status : null;

  let query = supabaseAdmin
    .from('enrollments')
    .select(
      `id, status, enrolled_at, completed_at,
       student:profiles!enrollments_student_id_fkey ( id, full_name, email ),
       course:courses!enrollments_course_id_fkey ( id, title, slug )`,
      { count: 'exact' }
    )
    .order('enrolled_at', { ascending: false })
    .range(from, to);

  if (status && ['PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED'].includes(status)) {
    query = query.eq('status', status);
  }

  const { data, error, count } = await query;
  if (error) throw ApiError.internal('Unable to load enrollments');

  res.json({
    success: true,
    data: {
      enrollments: data,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/** PATCH /api/admin/enrollments/:id — e.g. cancel access (audited) */
export const adminUpdateEnrollment = asyncHandler(async (req, res) => {
  const enrollmentId = req.validatedParams.id;
  const { status } = req.body || {};

  if (!['ACTIVE', 'CANCELLED', 'PENDING'].includes(status)) {
    throw ApiError.badRequest("Status must be one of 'ACTIVE', 'CANCELLED', 'PENDING'", 'VALIDATION_ERROR');
  }

  const { data: existing } = await supabaseAdmin
    .from('enrollments')
    .select('id, status')
    .eq('id', enrollmentId)
    .maybeSingle();
  if (!existing) throw ApiError.notFound('Enrollment not found', 'ENROLLMENT_NOT_FOUND');

  if (existing.status === 'COMPLETED' && status !== 'CANCELLED') {
    throw ApiError.badRequest('A completed enrollment can only be cancelled', 'INVALID_STATE');
  }

  const { data, error } = await supabaseAdmin
    .from('enrollments')
    .update({ status })
    .eq('id', enrollmentId)
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to update enrollment');

  await logAudit({
    adminId: req.profile.id,
    action: 'ENROLLMENT_UPDATED',
    targetType: 'enrollment',
    targetId: enrollmentId,
    description: `Enrollment status changed from ${existing.status} to ${status}`,
  });

  res.json({ success: true, message: 'Enrollment updated', data: { enrollment: data } });
});

/** GET /api/admin/certificates */
export const adminListCertificates = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);

  const { data, error, count } = await supabaseAdmin
    .from('certificates')
    .select(
      `id, certificate_number, verification_code, issued_at, status,
       student:profiles!certificates_student_id_fkey ( id, full_name, email ),
       course:courses!certificates_course_id_fkey ( id, title, slug )`,
      { count: 'exact' }
    )
    .order('issued_at', { ascending: false })
    .range(from, to);

  if (error) throw ApiError.internal('Unable to load certificates');

  res.json({
    success: true,
    data: {
      certificates: data,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/** PATCH /api/admin/certificates/:id — revoke / reactivate (audited) */
export const adminUpdateCertificate = asyncHandler(async (req, res) => {
  const { status } = req.validatedBody;

  const { data: existing } = await supabaseAdmin
    .from('certificates')
    .select('id, certificate_number, status')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (!existing) throw ApiError.notFound('Certificate not found', 'CERTIFICATE_NOT_FOUND');

  const { data, error } = await supabaseAdmin
    .from('certificates')
    .update({ status })
    .eq('id', existing.id)
    .select()
    .single();
  if (error) throw ApiError.internal('Unable to update certificate');

  await logAudit({
    adminId: req.profile.id,
    action: status === 'REVOKED' ? 'CERTIFICATE_REVOKED' : 'CERTIFICATE_REACTIVATED',
    targetType: 'certificate',
    targetId: existing.id,
    description: `Certificate ${existing.certificate_number} ${status.toLowerCase()}`,
  });

  res.json({ success: true, message: `Certificate ${status.toLowerCase()}`, data: { certificate: data } });
});
