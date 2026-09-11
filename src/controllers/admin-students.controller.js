import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { parsePagination } from '../utils/helpers.js';
import { getCourseProgress } from '../services/learning.service.js';
import { logAudit } from '../services/audit.service.js';

/** GET /api/admin/students — list + search (passwords never exposed) */
export const listStudents = asyncHandler(async (req, res) => {
  const { search } = req.validatedQuery;
  const { from, to, page, limit } = parsePagination(req.validatedQuery);

  let query = supabaseAdmin
    .from('profiles')
    .select('id, user_id, full_name, email, phone, profile_photo_url, role, created_at', { count: 'exact' })
    .eq('role', 'student')
    .order('created_at', { ascending: false })
    .range(from, to);

  if (search) {
    const safe = search.replace(/[%_]/g, '');
    query = query.or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`);
  }

  const { data, error, count } = await query;
  if (error) throw ApiError.internal('Unable to load students');

  const students = await Promise.all(
    (data || []).map(async (student) => {
      const [{ count: enrollments }, { data: approved }] = await Promise.all([
        supabaseAdmin
          .from('enrollments')
          .select('id', { count: 'exact', head: true })
          .eq('student_id', student.id),
        supabaseAdmin
          .from('payments')
          .select('amount')
          .eq('student_id', student.id)
          .eq('status', 'APPROVED'),
      ]);
      return {
        ...student,
        enrollments_count: enrollments || 0,
        total_paid: (approved || []).reduce((sum, p) => sum + Number(p.amount), 0),
      };
    })
  );

  res.json({
    success: true,
    data: {
      students,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/** GET /api/admin/students/:id — profile + courses + payments + progress + certificates */
export const getStudentDetail = asyncHandler(async (req, res) => {
  const studentId = req.validatedParams.id;

  const { data: student } = await supabaseAdmin
    .from('profiles')
    .select('id, user_id, full_name, email, phone, profile_photo_url, role, created_at, updated_at')
    .eq('id', studentId)
    .maybeSingle();

  if (!student) throw ApiError.notFound('Student not found', 'STUDENT_NOT_FOUND');

  const { data: enrollments } = await supabaseAdmin
    .from('enrollments')
    .select(
      `id, status, enrolled_at, completed_at,
       courses ( id, title, slug, thumbnail_url )`
    )
    .eq('student_id', studentId)
    .order('enrolled_at', { ascending: false });

  const enrollmentsWithProgress = await Promise.all(
    (enrollments || []).map(async (enr) => ({
      ...enr,
      progress: await getCourseProgress(enr.courses.id, studentId),
    }))
  );

  const [{ data: payments }, { data: certificates }] = await Promise.all([
    supabaseAdmin
      .from('payments')
      .select(
        `id, amount, transaction_reference, transaction_date, status, rejection_reason,
         submitted_at, reviewed_at, courses ( id, title, slug )`
      )
      .eq('student_id', studentId)
      .order('submitted_at', { ascending: false }),
    supabaseAdmin
      .from('certificates')
      .select('id, certificate_number, issued_at, status, courses ( id, title, slug )')
      .eq('student_id', studentId),
  ]);

  const approved = (payments || []).filter((p) => p.status === 'APPROVED');

  res.json({
    success: true,
    data: {
      student,
      enrollments: enrollmentsWithProgress,
      payments: payments || [],
      certificates: certificates || [],
      summary: {
        total_paid: approved.reduce((sum, p) => sum + Number(p.amount), 0),
        approved_payments: approved.length,
        pending_payments: (payments || []).filter((p) => p.status === 'PENDING').length,
        rejected_payments: (payments || []).filter((p) => p.status === 'REJECTED').length,
        completed_courses: (enrollments || []).filter((e) => e.status === 'COMPLETED').length,
      },
    },
  });
});

/** PATCH /api/admin/students/:id — admin profile update (audited) */
export const adminUpdateStudent = asyncHandler(async (req, res) => {
  const studentId = req.validatedParams.id;
  const body = req.validatedBody;

  const { data: before } = await supabaseAdmin
    .from('profiles')
    .select('full_name, role')
    .eq('id', studentId)
    .maybeSingle();
  if (!before) throw ApiError.notFound('Student not found', 'STUDENT_NOT_FOUND');

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update(body)
    .eq('id', studentId)
    .select('id, user_id, full_name, email, phone, role')
    .maybeSingle();
  if (error) throw ApiError.internal('Unable to update student');

  await logAudit({
    adminId: req.profile.id,
    action: 'STUDENT_ACCOUNT_UPDATED',
    targetType: 'user',
    targetId: studentId,
    description: `Updated profile of "${data.full_name}" (${Object.keys(body).join(', ')})`,
  });

  res.json({ success: true, message: 'Student updated', data: { student: data } });
});

/** GET /api/admin/instructors */
export const listInstructors = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, user_id, full_name, email, phone, profile_photo_url, role, created_at')
    .eq('role', 'instructor')
    .order('created_at', { ascending: false });

  if (error) throw ApiError.internal('Unable to load instructors');
  res.json({ success: true, data: { instructors: data } });
});

/** POST /api/admin/instructors — create an instructor account */
export const createInstructor = asyncHandler(async (req, res) => {
  const { full_name, email, phone, password } = req.validatedBody;

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, phone: phone || null },
    app_metadata: { role: 'instructor' },
  });
  if (error) {
    if (/already (been )?registered/i.test(error.message)) {
      throw ApiError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
    }
    throw ApiError.badRequest(error.message, 'REGISTRATION_FAILED');
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert(
      { user_id: data.user.id, full_name, email, phone: phone || null, role: 'instructor' },
      { onConflict: 'user_id' }
    )
    .select()
    .single();
  if (profileError) throw ApiError.internal('Instructor created but profile setup failed');

  await logAudit({
    adminId: req.profile.id,
    action: 'INSTRUCTOR_CREATED',
    targetType: 'user',
    targetId: profile.id,
    description: `Created instructor account "${full_name}" <${email}>`,
  });

  res.status(201).json({ success: true, message: 'Instructor account created', data: { instructor: profile } });
});

/** POST /api/admin/users/:id/role {role} — change any user's role */
export const setUserRole = asyncHandler(async (req, res) => {
  const target = await supabaseAdmin
    .from('profiles')
    .select('id, user_id, full_name, email, role')
    .eq('id', req.validatedParams.id)
    .maybeSingle();
  if (!target.data) throw ApiError.notFound('User not found', 'USER_NOT_FOUND');

  const { role } = req.validatedBody;

  // Prevent an admin from demoting their own account
  if (target.data.id === req.profile.id && role !== 'admin') {
    throw ApiError.badRequest('You cannot change your own admin role', 'SELF_ROLE_CHANGE');
  }

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ role })
    .eq('id', target.data.id)
    .select('id, user_id, full_name, email, role')
    .single();
  if (error) throw ApiError.internal('Unable to change role');

  await supabaseAdmin.auth.admin.updateUserById(target.data.user_id, {
    app_metadata: { role },
  });

  await logAudit({
    adminId: req.profile.id,
    action: 'USER_ROLE_CHANGED',
    targetType: 'user',
    targetId: target.data.id,
    description: `Role of "${target.data.full_name}" changed from ${target.data.role} to ${role}`,
  });

  res.json({ success: true, message: `User role updated to ${role}`, data: { user: data } });
});
