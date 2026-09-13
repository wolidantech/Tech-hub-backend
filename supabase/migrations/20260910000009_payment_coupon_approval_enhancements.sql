-- =====================================================================
-- WOLI DAN TECH HUB
-- Migration 009: Enhance approve_payment / reject_payment to handle coupons
-- - Increment coupon used_count on approval
-- - Link redemption to enrollment
-- - Ensure race condition protection still holds
-- =====================================================================

-- Update approve_payment to handle coupon logic
create or replace function public.approve_payment(p_payment_id uuid, p_admin_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_payment      public.payments%rowtype;
  v_enrollment   uuid;
  v_course_title text;
  v_coupon_code  text;
begin
  -- Validate the admin principal
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'FORBIDDEN: only administrators can approve payments';
  end if;

  -- Lock the payment row for the duration of the transaction
  select * into v_payment from public.payments where id = p_payment_id for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND';
  end if;

  if v_payment.status <> 'PENDING' then
    raise exception 'PAYMENT_ALREADY_REVIEWED: this payment has status %', v_payment.status;
  end if;

  select title into v_course_title from public.courses where id = v_payment.course_id;
  if v_payment.coupon_id is not null then
    select code into v_coupon_code from public.coupons where id = v_payment.coupon_id;
  end if;

  -- 1) Approve the payment
  update public.payments
     set status       = 'APPROVED',
         reviewed_by  = p_admin_id,
         reviewed_at  = now(),
         rejection_reason = null
   where id = p_payment_id;

  -- 2) Create / re-activate the enrollment (idempotent)
  insert into public.enrollments (student_id, course_id, payment_id, status, enrolled_at)
  values (v_payment.student_id, v_payment.course_id, p_payment_id, 'ACTIVE', now())
  on conflict (student_id, course_id) do update
     set status     = 'ACTIVE',
         payment_id = p_payment_id
   where public.enrollments.status in ('PENDING', 'CANCELLED')
  returning id into v_enrollment;

  if v_enrollment is null then
    select id into v_enrollment
      from public.enrollments
     where student_id = v_payment.student_id and course_id = v_payment.course_id;
  end if;

  -- 2b) Handle coupon: increment used_count and link redemption to enrollment
  if v_payment.coupon_id is not null then
    -- Lock coupon row
    perform * from public.coupons where id = v_payment.coupon_id for update;
    update public.coupons set used_count = used_count + 1, updated_at = now() where id = v_payment.coupon_id;

    -- Update redemption with enrollment_id
    update public.coupon_redemptions
       set enrollment_id = v_enrollment
     where payment_id = p_payment_id and coupon_id = v_payment.coupon_id;
  end if;

  -- 3) Notify the student
  insert into public.notifications (user_id, title, message, type) values
    (v_payment.student_id,
     'Payment approved',
     'Your payment for "' || coalesce(v_course_title, 'your course')
       || '" has been approved' || case when v_coupon_code is not null then ' (coupon ' || v_coupon_code || ' applied)' else '' end || '. Enjoy the course!',
     'PAYMENT_APPROVED'),
    (v_payment.student_id,
     'You are enrolled',
     'You now have full access to "' || coalesce(v_course_title, 'your course')
       || '". Open My Courses and start learning.',
     'COURSE_ENROLLED');

  -- 4) Audit event
  insert into public.audit_logs (admin_id, action, target_type, target_id, description)
  values (
    p_admin_id,
    'PAYMENT_APPROVED',
    'payment',
    p_payment_id,
    'Approved payment of NGN ' || to_char(v_payment.amount, 'FM999,999,990.00')
      || ' (ref: ' || v_payment.transaction_reference || ') for course "'
      || coalesce(v_course_title, v_payment.course_id::text) || '"'
      || case when v_coupon_code is not null then ' with coupon ' || v_coupon_code || ' (discount NGN ' || to_char(coalesce(v_payment.discount_amount,0), 'FM999,999,990.00') || ')' else '' end
  );

  return jsonb_build_object(
    'payment_id',    p_payment_id,
    'status',        'APPROVED',
    'enrollment_id', v_enrollment,
    'coupon_code',   v_coupon_code
  );
end;
$$;

-- Update reject_payment to handle coupon cleanup (do not increment used_count)
create or replace function public.reject_payment(p_payment_id uuid, p_admin_id uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_payment      public.payments%rowtype;
  v_course_title text;
  v_coupon_code  text;
begin
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'FORBIDDEN: only administrators can reject payments';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'REJECTION_REASON_REQUIRED';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND';
  end if;

  if v_payment.status <> 'PENDING' then
    raise exception 'PAYMENT_ALREADY_REVIEWED: this payment has status %', v_payment.status;
  end if;

  select title into v_course_title from public.courses where id = v_payment.course_id;
  if v_payment.coupon_id is not null then
    select code into v_coupon_code from public.coupons where id = v_payment.coupon_id;
  end if;

  update public.payments
     set status           = 'REJECTED',
         rejection_reason = trim(p_reason),
         reviewed_by      = p_admin_id,
         reviewed_at      = now()
   where id = p_payment_id;

  -- Enrollment is explicitly NOT activated.
  update public.enrollments
     set status = 'PENDING'
   where student_id = v_payment.student_id
     and course_id  = v_payment.course_id
     and status     = 'PENDING';

  -- For coupon payments, we keep redemption record but do NOT increment used_count
  -- (used_count only increments on approval, so rejected coupon can be reused)

  insert into public.notifications (user_id, title, message, type)
  values (
    v_payment.student_id,
    'Payment could not be verified',
    'Your payment for "' || coalesce(v_course_title, 'your course')
      || '" was rejected. Reason: ' || trim(p_reason)
      || '. You may submit a new payment with a valid receipt.',
    'PAYMENT_REJECTED'
  );

  insert into public.audit_logs (admin_id, action, target_type, target_id, description)
  values (
    p_admin_id,
    'PAYMENT_REJECTED',
    'payment',
    p_payment_id,
    'Rejected payment of NGN ' || to_char(v_payment.amount, 'FM999,999,990.00')
      || ' (ref: ' || v_payment.transaction_reference || '). Reason: ' || trim(p_reason)
      || case when v_coupon_code is not null then ' [coupon ' || v_coupon_code || ']' else '' end
  );

  return jsonb_build_object('payment_id', p_payment_id, 'status', 'REJECTED', 'coupon_code', v_coupon_code);
end;
$$;

-- Ensure privileges
revoke execute on function public.approve_payment(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.reject_payment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_payment(uuid, uuid) to service_role;
grant execute on function public.reject_payment(uuid, uuid, text) to service_role;
