import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler, mapDatabaseError } from '../utils/errors.js';
import { parsePagination } from '../utils/helpers.js';
import { logAudit } from '../services/audit.service.js';

/**
 * POST /api/coupons/validate
 * Body: { code, course_id }
 * Returns validation result with discount calculation — does NOT redeem
 */
export const validateCoupon = asyncHandler(async (req, res) => {
  const { code, course_id } = req.validatedBody;

  const { data, error } = await supabaseAdmin.rpc('validate_coupon', {
    p_code: code,
    p_course_id: course_id,
    p_student_id: req.profile.id,
  });

  if (error) {
    console.error('[validate-coupon]', error.message);
    // RPC returns jsonb with valid=false for business errors, but throws for not found etc.
    // Map known errors to 400
    if (error.message?.includes('COUPON_INVALID') || error.message?.includes('Invalid')) {
      throw ApiError.badRequest(error.message.replace('COUPON_INVALID: ', ''), 'INVALID_COUPON');
    }
    throw ApiError.internal('Unable to validate coupon');
  }

  // data is jsonb like {valid, reason, discount_amount, amount_due, etc}
  if (!data?.valid) {
    throw ApiError.badRequest(data.reason || 'Invalid coupon', 'INVALID_COUPON', { validation: data });
  }

  res.json({
    success: true,
    message: `Coupon ${code} is valid`,
    data: { validation: data },
  });
});

/**
 * POST /api/coupons/apply
 * Body: { code, course_id }
 * For 100% coupons only — creates free enrollment instantly
 * For partial coupons, client should proceed to payment with discounted amount
 */
export const applyCouponFree = asyncHandler(async (req, res) => {
  const { code, course_id } = req.validatedBody;

  const { data, error } = await supabaseAdmin.rpc('apply_coupon_free', {
    p_code: code,
    p_course_id: course_id,
    p_student_id: req.profile.id,
  });

  if (error) {
    console.error('[apply-coupon-free]', error.message);
    if (error.message?.includes('COUPON_INVALID')) {
      throw ApiError.badRequest(error.message.replace('COUPON_INVALID: ', ''), 'INVALID_COUPON');
    }
    if (error.message?.includes('COUPON_NOT_FREE')) {
      // Not free — need partial payment flow
      // Re-validate to get amount_due
      const { data: validation } = await supabaseAdmin.rpc('validate_coupon', {
        p_code: code,
        p_course_id: course_id,
        p_student_id: req.profile.id,
      });
      throw ApiError.badRequest(
        error.message.replace('COUPON_NOT_FREE: ', ''),
        'COUPON_REQUIRES_PAYMENT',
        { validation }
      );
    }
    if (error.message?.includes('ALREADY_ENROLLED')) {
      throw ApiError.conflict('You are already enrolled in this course', 'ALREADY_ENROLLED');
    }
    throw mapDatabaseError(error, 'Unable to apply coupon') || ApiError.internal('Unable to apply coupon');
  }

  res.status(201).json({
    success: true,
    message: 'Coupon applied successfully — you now have full access to the course!',
    data: {
      enrollment_id: data.enrollment_id,
      redemption_id: data.redemption_id,
      coupon_id: data.coupon_id,
      discount_amount: data.discount_amount,
      amount_paid: 0,
      is_free: true,
    },
  });
});

/**
 * POST /api/coupons/checkout
 * For partial coupons — validates coupon and returns amount due, does NOT enroll yet
 * Client then proceeds to POST /api/payments with coupon code
 */
export const checkoutWithCoupon = asyncHandler(async (req, res) => {
  const { code, course_id } = req.validatedBody;

  const { data, error } = await supabaseAdmin.rpc('validate_coupon', {
    p_code: code,
    p_course_id: course_id,
    p_student_id: req.profile.id,
  });

  if (error) throw ApiError.internal('Unable to validate coupon');
  if (!data?.valid) throw ApiError.badRequest(data.reason, 'INVALID_COUPON', { validation: data });

  // Get bank details for partial payment
  const { data: bankDetails } = await supabaseAdmin
    .from('platform_settings')
    .select('value')
    .eq('key', 'bank_details')
    .eq('is_public', true)
    .maybeSingle();

  res.json({
    success: true,
    data: {
      validation: data,
      course_id,
      original_amount: data.original_amount,
      discount_amount: data.discount_amount,
      amount_due: data.amount_due,
      is_free: data.is_free,
      bank_details: data.is_free ? null : bankDetails?.value || null,
      next_step: data.is_free
        ? 'POST /api/coupons/apply with same code for free enrollment'
        : 'POST /api/payments with course_id, transaction_reference, transaction_date, receipt, and coupon_code',
    },
  });
});

// ---------------- Admin coupon management ----------------

export const adminListCoupons = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);
  const { is_active, search } = req.query;

  let query = supabaseAdmin
    .from('coupons')
    .select('id, code, description, discount_type, discount_value, max_uses, used_count, is_active, valid_from, valid_until, created_at, created_by', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (is_active !== undefined) {
    query = query.eq('is_active', is_active === 'true');
  }
  if (search) {
    query = query.ilike('code', `%${search.replace(/[%_]/g, '')}%`);
  }

  const { data, error, count } = await query;
  if (error) throw ApiError.internal('Unable to load coupons');

  res.json({
    success: true,
    data: {
      coupons: data,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

export const adminCreateCoupon = asyncHandler(async (req, res) => {
  const body = req.validatedBody;

  const { data, error } = await supabaseAdmin
    .from('coupons')
    .insert({
      code: body.code.toUpperCase().trim(),
      description: body.description,
      discount_type: body.discount_type,
      discount_value: body.discount_value,
      max_uses: body.max_uses,
      min_amount: body.min_amount || 0,
      applicable_course_ids: body.applicable_course_ids || null,
      is_active: body.is_active ?? true,
      valid_from: body.valid_from || new Date().toISOString(),
      valid_until: body.valid_until || null,
      created_by: req.profile.id,
    })
    .select()
    .single();

  if (error) throw mapDatabaseError(error, 'Unable to create coupon') || ApiError.internal('Unable to create coupon');

  await logAudit({
    adminId: req.profile.id,
    action: 'COUPON_CREATED',
    targetType: 'coupon',
    targetId: data.id,
    description: `Coupon ${data.code} created: ${data.discount_value}${data.discount_type === 'PERCENTAGE' ? '%' : ' NGN'} off`,
  });

  res.status(201).json({ success: true, message: 'Coupon created', data: { coupon: data } });
});

export const adminGetCoupon = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('coupons')
    .select('*')
    .eq('id', req.validatedParams.id)
    .maybeSingle();

  if (error) throw ApiError.internal('Unable to load coupon');
  if (!data) throw ApiError.notFound('Coupon not found', 'COUPON_NOT_FOUND');

  // Get usage stats
  const { count: redemptionCount } = await supabaseAdmin
    .from('coupon_redemptions')
    .select('id', { count: 'exact', head: true })
    .eq('coupon_id', data.id);

  res.json({ success: true, data: { coupon: data, redemptions_count: redemptionCount || 0 } });
});

export const adminUpdateCoupon = asyncHandler(async (req, res) => {
  const body = req.validatedBody;
  const couponId = req.validatedParams.id;

  const updates = {};
  if (body.code !== undefined) updates.code = body.code.toUpperCase().trim();
  if (body.description !== undefined) updates.description = body.description;
  if (body.discount_type !== undefined) updates.discount_type = body.discount_type;
  if (body.discount_value !== undefined) updates.discount_value = body.discount_value;
  if (body.max_uses !== undefined) updates.max_uses = body.max_uses;
  if (body.min_amount !== undefined) updates.min_amount = body.min_amount;
  if (body.applicable_course_ids !== undefined) updates.applicable_course_ids = body.applicable_course_ids;
  if (body.is_active !== undefined) updates.is_active = body.is_active;
  if (body.valid_from !== undefined) updates.valid_from = body.valid_from;
  if (body.valid_until !== undefined) updates.valid_until = body.valid_until;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('coupons')
    .update(updates)
    .eq('id', couponId)
    .select()
    .single();

  if (error) throw mapDatabaseError(error, 'Unable to update coupon') || ApiError.internal('Unable to update coupon');

  await logAudit({
    adminId: req.profile.id,
    action: 'COUPON_UPDATED',
    targetType: 'coupon',
    targetId: couponId,
    description: `Coupon ${data.code} updated`,
  });

  res.json({ success: true, message: 'Coupon updated', data: { coupon: data } });
});

export const adminDeleteCoupon = asyncHandler(async (req, res) => {
  const couponId = req.validatedParams.id;

  // Check if has redemptions
  const { count } = await supabaseAdmin
    .from('coupon_redemptions')
    .select('id', { count: 'exact', head: true })
    .eq('coupon_id', couponId);

  if (count > 0) {
    // Soft delete: deactivate instead
    const { data, error } = await supabaseAdmin
      .from('coupons')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', couponId)
      .select()
      .single();
    if (error) throw ApiError.internal('Unable to deactivate coupon');

    await logAudit({
      adminId: req.profile.id,
      action: 'COUPON_DEACTIVATED',
      targetType: 'coupon',
      targetId: couponId,
      description: `Coupon ${data.code} deactivated (has ${count} redemptions, not deleted)`,
    });

    return res.json({ success: true, message: 'Coupon has redemptions, deactivated instead of deleted', data: { coupon: data } });
  }

  const { error } = await supabaseAdmin.from('coupons').delete().eq('id', couponId);
  if (error) throw ApiError.internal('Unable to delete coupon');

  await logAudit({
    adminId: req.profile.id,
    action: 'COUPON_DELETED',
    targetType: 'coupon',
    targetId: couponId,
    description: `Coupon ${couponId} deleted`,
  });

  res.json({ success: true, message: 'Coupon deleted' });
});

export const adminListRedemptions = asyncHandler(async (req, res) => {
  const { from, to, page, limit } = parsePagination(req.query);
  const { coupon_id, student_id, course_id } = req.query;

  let query = supabaseAdmin
    .from('coupon_redemptions')
    .select(
      `id, discount_amount, amount_paid, original_amount, redeemed_at,
       coupon:coupons!coupon_redemptions_coupon_id_fkey ( id, code, discount_type, discount_value ),
       student:profiles!coupon_redemptions_student_id_fkey ( id, full_name, email ),
       course:courses!coupon_redemptions_course_id_fkey ( id, title, slug )`,
      { count: 'exact' }
    )
    .order('redeemed_at', { ascending: false })
    .range(from, to);

  if (coupon_id) query = query.eq('coupon_id', coupon_id);
  if (student_id) query = query.eq('student_id', student_id);
  if (course_id) query = query.eq('course_id', course_id);

  const { data, error, count } = await query;
  if (error) throw ApiError.internal('Unable to load redemptions');

  res.json({
    success: true,
    data: {
      redemptions: data,
      pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});
