import { supabaseAdmin } from '../config/supabase.js';
import { BUCKETS } from '../config/env.js';
import { ApiError, asyncHandler, mapDatabaseError } from '../utils/errors.js';
import { parsePagination, sanitizeFileName, extensionForMime } from '../utils/helpers.js';
import { uploadObject, createSignedUrl, removeObject } from '../services/storage.service.js';
import { getCourseProgress, getContinueLearning } from '../services/learning.service.js';

/** Minimal magic-byte check so spoofed MIME types don't slip through. */
function verifyFileSignature(mimetype, buffer) {
  if (!buffer || buffer.length < 4) return false;
  switch (mimetype) {
    case 'image/jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/png':
      return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    case 'application/pdf':
      return buffer.slice(0, 4).toString('latin1') === '%PDF';
    default:
      return false;
  }
}

async function getBankDetails() {
  const { data } = await supabaseAdmin
    .from('platform_settings')
    .select('value')
    .eq('key', 'bank_details')
    .eq('is_public', true)
    .maybeSingle();
  return data?.value || null;
}

/**
 * POST /api/enrollments  ("enroll-course")
 * For manual bank-transfer courses this starts the payment flow:
 * verifies eligibility and returns current bank details + the exact
 * amount from the database (never the client).
 */
export const enrollCourse = asyncHandler(async (req, res) => {
  const { course_id } = req.validatedBody;

  const { data: course } = await supabaseAdmin
    .from('courses')
    .select('id, title, slug, price, is_published')
    .eq('id', course_id)
    .maybeSingle();

  if (!course || !course.is_published) {
    throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');
  }

  const { data: enrollment } = await supabaseAdmin
    .from('enrollments')
    .select('id, status')
    .eq('course_id', course_id)
    .eq('student_id', req.profile.id)
    .maybeSingle();

  if (enrollment && ['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
    throw ApiError.conflict('You are already enrolled in this course', 'ALREADY_ENROLLED', {
      enrollment,
    });
  }

  const { data: pending } = await supabaseAdmin
    .from('payments')
    .select('id, status, submitted_at')
    .eq('course_id', course_id)
    .eq('student_id', req.profile.id)
    .eq('status', 'PENDING')
    .maybeSingle();

  if (pending) {
    throw ApiError.conflict(
      'You already have a payment for this course awaiting verification',
      'PAYMENT_ALREADY_PENDING',
      { payment: pending }
    );
  }

  const bankDetails = await getBankDetails();
  if (!bankDetails) throw ApiError.internal('Payment details are currently unavailable');

  res.json({
    success: true,
    message: 'Proceed to payment using the bank details below, then submit your payment receipt for verification.',
    data: {
      course: { id: course.id, title: course.title, slug: course.slug, price: course.price },
      amount_to_pay: course.price,
      bank_details: bankDetails,
      next_step: 'POST /api/payments with course_id, transaction_reference, transaction_date and the receipt file.',
    },
  });
});

/**
 * POST /api/payments  (multipart form: receipt file + fields)
 * Creates a PENDING payment and securely stores the receipt.
 * NEVER activates the enrollment — an admin must approve first.
 */
export const submitPayment = asyncHandler(async (req, res) => {
  const { course_id, transaction_reference, transaction_date, amount } = req.validatedBody;

  if (!req.file) {
    throw ApiError.badRequest('A payment receipt file is required (JPG, PNG or PDF)', 'RECEIPT_REQUIRED');
  }
  if (!verifyFileSignature(req.file.mimetype, req.file.buffer)) {
    throw ApiError.badRequest('Invalid receipt: file content does not match its type', 'INVALID_RECEIPT');
  }

  const { data: course } = await supabaseAdmin
    .from('courses')
    .select('id, title, price, is_published')
    .eq('id', course_id)
    .maybeSingle();

  if (!course || !course.is_published) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  // Amount is authoritative from the database — the client value is
  // only cross-checked for honesty.
  if (amount !== undefined && Number(amount) !== Number(course.price)) {
    throw ApiError.badRequest(
      `The amount for this course is NGN ${course.price}. Please pay the exact amount.`,
      'AMOUNT_MISMATCH'
    );
  }

  const { data: enrollment } = await supabaseAdmin
    .from('enrollments')
    .select('id, status')
    .eq('course_id', course_id)
    .eq('student_id', req.profile.id)
    .maybeSingle();
  if (enrollment && ['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
    throw ApiError.conflict('You are already enrolled in this course', 'ALREADY_ENROLLED');
  }

  const { data: existingRef } = await supabaseAdmin
    .from('payments')
    .select('id')
    .eq('transaction_reference', transaction_reference)
    .maybeSingle();
  if (existingRef) {
    throw ApiError.conflict(
      'This transaction reference has already been submitted',
      'DUPLICATE_TRANSACTION_REFERENCE'
    );
  }

  // Create the payment (student_id taken from the authenticated
  // profile — never from the request body).
  const { data: payment, error: insertError } = await supabaseAdmin
    .from('payments')
    .insert({
      student_id: req.profile.id,
      course_id,
      amount: course.price,
      payment_method: 'MANUAL_BANK_TRANSFER',
      transaction_reference,
      transaction_date: transaction_date.toISOString().slice(0, 10),
      status: 'PENDING',
    })
    .select()
    .single();

  if (insertError) {
    throw mapDatabaseError(insertError, 'Unable to submit payment') || ApiError.internal('Unable to submit payment');
  }

  // Upload receipt to the PRIVATE bucket — path is namespaced by the
  // real user id so storage policies isolate each student's files.
  const ext = extensionForMime(req.file.mimetype) || '';
  const fileName = sanitizeFileName(req.file.originalname);
  const path = `${req.user.id}/${payment.id}/${Date.now()}-${fileName}${ext && !fileName.endsWith(ext) ? ext : ''}`;

  try {
    await uploadObject(BUCKETS.receipts, path, req.file.buffer, req.file.mimetype, { upsert: false });

    const { error: receiptError } = await supabaseAdmin.from('payment_receipts').insert({
      payment_id: payment.id,
      student_id: req.profile.id,
      file_path: path,
      file_name: fileName,
      file_type: req.file.mimetype,
    });
    if (receiptError) throw receiptError;
  } catch (err) {
    // Compensating action: do not leave a payment without a receipt.
    await removeObject(BUCKETS.receipts, path);
    await supabaseAdmin.from('payments').delete().eq('id', payment.id);
    console.error('[payments] receipt store failed', err?.message);
    throw ApiError.internal('Unable to store receipt. Please submit your payment again.');
  }

  res.status(201).json({
    success: true,
    message: 'Payment submitted successfully and is awaiting admin verification.',
    data: {
      payment: {
        id: payment.id,
        course_id: payment.course_id,
        amount: payment.amount,
        transaction_reference: payment.transaction_reference,
        transaction_date: payment.transaction_date,
        status: payment.status,
        submitted_at: payment.submitted_at,
      },
    },
  });
});

/** GET /api/payments/me — own payments + personal summary */
export const getMyPayments = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);

  const { data, error, count } = await supabaseAdmin
    .from('payments')
    .select(
      `id, course_id, amount, payment_method, transaction_reference, transaction_date,
       status, rejection_reason, submitted_at, reviewed_at,
       courses ( id, title, slug, thumbnail_url ),
       payment_receipts ( id, file_name, file_type, uploaded_at )`,
      { count: 'exact' }
    )
    .eq('student_id', req.profile.id)
    .order('submitted_at', { ascending: false })
    .range(from, to);

  if (error) throw ApiError.internal('Unable to load your payments');

  const { data: all } = await supabaseAdmin
    .from('payments')
    .select('amount, status')
    .eq('student_id', req.profile.id);

  const summary = {
    total_paid: 0, // APPROVED only
    pending_payments: 0,
    approved_payments: 0,
    rejected_payments: 0,
  };
  for (const p of all || []) {
    if (p.status === 'APPROVED') {
      summary.approved_payments += 1;
      summary.total_paid += Number(p.amount);
    } else if (p.status === 'PENDING') {
      summary.pending_payments += 1;
    } else if (p.status === 'REJECTED') {
      summary.rejected_payments += 1;
    }
  }

  res.json({
    success: true,
    data: {
      payments: data,
      summary,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

/**
 * GET /api/payments/:id/receipt-url — short-lived signed URL so the
 * owner (or an admin) can view a PRIVATE receipt file.
 */
export const getReceiptUrl = asyncHandler(async (req, res) => {
  const paymentId = req.validatedParams.id;

  const { data: receipt } = await supabaseAdmin
    .from('payment_receipts')
    .select('id, file_path, file_name, file_type, payments!inner(id, student_id)')
    .eq('payment_id', paymentId)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!receipt) throw ApiError.notFound('Receipt not found', 'RECEIPT_NOT_FOUND');

  const isOwner = receipt.payments.student_id === req.profile.id;
  if (!isOwner && req.profile.role !== 'admin') {
    throw ApiError.forbidden('You cannot view this receipt', 'FORBIDDEN');
  }

  const url = await createSignedUrl(BUCKETS.receipts, receipt.file_path, 600);
  res.json({
    success: true,
    data: { url, expires_in_seconds: 600, file_name: receipt.file_name, file_type: receipt.file_type },
  });
});

/** GET /api/enrollments/me — "My Courses" with progress + continue */
export const getMyCourses = asyncHandler(async (req, res) => {
  const { data: enrollments, error } = await supabaseAdmin
    .from('enrollments')
    .select(
      `id, status, enrolled_at, completed_at,
       courses ( id, title, slug, description, thumbnail_url, price, duration, difficulty_level,
                 course_categories ( id, name ) )`
    )
    .eq('student_id', req.profile.id)
    .order('enrolled_at', { ascending: false });

  if (error) throw ApiError.internal('Unable to load your courses');

  const courses = await Promise.all(
    (enrollments || []).map(async (enrollment) => {
      const course = enrollment.courses;
      const [progress, continueLearning] = await Promise.all([
        getCourseProgress(course.id, req.profile.id),
        enrollment.status === 'ACTIVE' || enrollment.status === 'COMPLETED'
          ? getContinueLearning(course.id, req.profile.id)
          : Promise.resolve(null),
      ]);
      return { ...enrollment, course, progress, continue_learning: continueLearning, courses: undefined };
    })
  );

  res.json({ success: true, data: { enrollments: courses } });
});
