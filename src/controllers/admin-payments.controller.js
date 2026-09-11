import { supabaseAdmin } from '../config/supabase.js';
import { BUCKETS } from '../config/env.js';
import { ApiError, asyncHandler, mapDatabaseError } from '../utils/errors.js';
import { parsePagination } from '../utils/helpers.js';
import { createSignedUrl } from '../services/storage.service.js';

const ADMIN_PAYMENT_SELECT = `
  id, course_id, amount, payment_method, transaction_reference, transaction_date,
  status, rejection_reason, submitted_at, reviewed_at,
  student:profiles!payments_student_id_fkey ( id, full_name, email, phone, profile_photo_url ),
  course:courses!payments_course_id_fkey ( id, title, slug, price, thumbnail_url ),
  reviewer:profiles!payments_reviewed_by_fkey ( id, full_name, email ),
  payment_receipts ( id, file_path, file_name, file_type, uploaded_at )
`;

/** GET /api/admin/payments — review queue (default: PENDING) */
export const adminListPayments = asyncHandler(async (req, res) => {
  const { status = 'PENDING', search, course_id } = req.validatedQuery;
  const { from, to, page, limit } = parsePagination(req.validatedQuery);

  let query = supabaseAdmin
    .from('payments')
    .select(ADMIN_PAYMENT_SELECT, { count: 'exact' })
    .order('submitted_at', { ascending: status === 'PENDING' }) // oldest pending first
    .range(from, to);

  if (status) query = query.eq('status', status);
  if (course_id) query = query.eq('course_id', course_id);
  if (search) query = query.ilike('transaction_reference', `%${search.replace(/[%_]/g, '')}%`);

  const { data, error, count } = await query;
  if (error) {
    console.error('[admin-payments]', error.message);
    throw ApiError.internal('Unable to load payments');
  }

  res.json({
    success: true,
    data: {
      payments: data,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/** GET /api/admin/payments/:id — full detail incl. signed receipt URL */
export const adminGetPayment = asyncHandler(async (req, res) => {
  const { data: payment, error } = await supabaseAdmin
    .from('payments')
    .select(ADMIN_PAYMENT_SELECT)
    .eq('id', req.validatedParams.id)
    .maybeSingle();

  if (error) throw ApiError.internal('Unable to load payment');
  if (!payment) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');

  const receipt = (payment.payment_receipts || [])[0] || null;
  let receiptUrl = null;
  if (receipt) {
    receiptUrl = await createSignedUrl(BUCKETS.receipts, receipt.file_path, 3600);
  }

  // Student's payment history with this course for context
  const { data: history } = await supabaseAdmin
    .from('payments')
    .select('id, amount, transaction_reference, status, submitted_at, rejection_reason')
    .eq('student_id', payment.student.id)
    .eq('course_id', payment.course_id)
    .order('submitted_at', { ascending: false });

  res.json({
    success: true,
    data: {
      payment: { ...payment, receipt_url: receiptUrl },
      history: history || [],
    },
  });
});

/**
 * POST /api/admin/payments/:id/approve
 * Atomic DB transaction (approve_payment): payment -> APPROVED,
 * enrollment created/activated, notification + audit recorded.
 */
export const approvePayment = asyncHandler(async (req, res) => {
  const paymentId = req.validatedParams.id;

  const { data, error } = await supabaseAdmin.rpc('approve_payment', {
    p_payment_id: paymentId,
    p_admin_id: req.profile.id,
  });

  if (error) {
    console.error('[approve-payment]', error.message);
    throw mapDatabaseError(error, 'Unable to approve payment') || ApiError.internal('Unable to approve payment');
  }

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select(ADMIN_PAYMENT_SELECT)
    .eq('id', paymentId)
    .single();

  res.json({
    success: true,
    message: 'Payment approved. The student now has access to the course.',
    data: { payment, result: data },
  });
});

/** POST /api/admin/payments/:id/reject */
export const rejectPayment = asyncHandler(async (req, res) => {
  const paymentId = req.validatedParams.id;
  const { rejection_reason } = req.validatedBody;

  const { data, error } = await supabaseAdmin.rpc('reject_payment', {
    p_payment_id: paymentId,
    p_admin_id: req.profile.id,
    p_reason: rejection_reason,
  });

  if (error) {
    console.error('[reject-payment]', error.message);
    throw mapDatabaseError(error, 'Unable to reject payment') || ApiError.internal('Unable to reject payment');
  }

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select(ADMIN_PAYMENT_SELECT)
    .eq('id', paymentId)
    .single();

  res.json({
    success: true,
    message: 'Payment rejected. The student has been notified and may submit a new payment.',
    data: { payment, result: data },
  });
});
