-- =====================================================================
-- DANQEL DIGITAL INSTITUTE — additive frontend-schema brand update
--
-- Apply only after frontend migrations 001-011. This changes institutional
-- display text and notification copy; it does not change payment/auth routes,
-- IDs, certificate numbers/codes, dates, validity, revocation, or audit actors.
-- Bank beneficiary, support contact, WhatsApp number, and dantech_enabled are
-- deliberately left unchanged.
-- =====================================================================

-- Update public institution identity and tagline while preserving operational settings.
update public.site_settings
set site_name = 'DANQEL DIGITAL INSTITUTE',
    tagline = 'Technology • Science • Digital Learning',
    meta_description = replace(meta_description, 'WOLI DAN TECH HUB', 'DANQEL DIGITAL INSTITUTE'),
    updated_at = now()
where id = 1;

-- Preserve certificate identifiers and state; only the issuer label changes.
update public.certificate_issues
set issued_by = 'DANQEL DIGITAL INSTITUTE'
where issued_by = 'WOLI DAN TECH HUB';

-- Existing notifications remain in place with their IDs, read state, and dates.
update public.student_notifications
set title = replace(title, 'WOLI DAN TECH HUB', 'DANQEL DIGITAL INSTITUTE'),
    message = replace(
      replace(
        replace(message, 'WOLI DAN TECH HUB', 'DANQEL DIGITAL INSTITUTE'),
        'LEARN • BUILD • GROW', 'Technology • Science • Digital Learning'
      ),
      'Learn • Build • Grow', 'Technology • Science • Digital Learning'
    )
where type in ('payment_approved', 'payment_rejected', 'coupon_approved', 'course_completed')
  and (title like '%WOLI DAN TECH HUB%'
       or message like '%WOLI DAN TECH HUB%'
       or message like '%LEARN • BUILD • GROW%'
       or message like '%Learn • Build • Grow%');

-- Keep the verification RPC response shape from migration 010 (including the
-- full holder name and status); only the public issuer changes.
create or replace function public.verify_certificate(p_code text)
returns jsonb language plpgsql security definer
set search_path = public
as $$
declare r record;
begin
  select certificate_id, verification_code, student_name, course_name, issue_date, status
  into r from public.certificate_issues
  where certificate_id = trim(p_code) or verification_code = trim(p_code);
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'status', r.status,
    'studentName', coalesce(nullif(btrim(coalesce(r.student_name, '')), ''), 'Student'),
    'courseName', r.course_name, 'issueDate', r.issue_date,
    'certificateId', r.certificate_id,
    'verificationCode', r.verification_code,
    'issuedBy', 'DANQEL DIGITAL INSTITUTE');
end $$;
grant execute on function public.verify_certificate(text) to anon, authenticated, service_role;
comment on function public.verify_certificate(text) is
  'Public verification by certificate ID or verification code. Returns the existing holder/status contract with the current institutional issuer.';

-- Payment approval/rejection retain their existing atomic payment, enrollment,
-- bundle fan-out, and audit-log behavior; only notification copy is rebranded.
create or replace function public.approve_payment(p_payment_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  pay record; cids uuid[]; cid uuid;
  admin_email text;
  target_name text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select email into admin_email from public.profiles where id = auth.uid();

  select * into pay from public.manual_payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if pay.status = 'approved' then raise exception 'Already approved'; end if;

  update public.manual_payments
  set status = 'approved', approved_by = admin_email, approved_at = now()
  where id = p_payment_id;

  if pay.bundle_id is not null and coalesce(array_length(pay.bundle_course_ids, 1), 0) > 0 then
    cids := pay.bundle_course_ids;
  else
    cids := array[pay.course_id];
  end if;

  foreach cid slice 0 in array cids loop
    if cid is null then continue; end if;
    insert into public.enrollments (user_id, course_id, status, method, coupon_code, payment_id, approved_by)
    values (pay.user_id, cid, 'active', 'manual', pay.coupon_code, p_payment_id, admin_email)
    on conflict (user_id, course_id) do update
      set status = 'active', payment_id = excluded.payment_id, approved_by = excluded.approved_by;
  end loop;

  select coalesce(
    (select title from public.courses where id = pay.course_id),
    (select 'Bundle: ' || title from public.bundles where id = pay.bundle_id),
    'your course'
  ) into target_name;

  insert into public.student_notifications (user_id, type, title, message, course_id)
  values (pay.user_id, 'payment_approved', 'Payment Approved! 🎉',
    'Your payment for ' || target_name || ' has been approved. Your course access is now ACTIVE. DANQEL DIGITAL INSTITUTE - Technology • Science • Digital Learning',
    pay.course_id);

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (admin_email, admin_email, 'payment.approve', 'manual_payment', p_payment_id::text,
    jsonb_build_object('amount', pay.amount, 'userId', pay.user_id));

  return jsonb_build_object('ok', true, 'paymentId', p_payment_id, 'courses', cids);
end $$;

create or replace function public.reject_payment(p_payment_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  pay record; admin_email text; target_name text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Rejection reason is required'; end if;
  select email into admin_email from public.profiles where id = auth.uid();

  select * into pay from public.manual_payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if pay.status = 'approved' then raise exception 'Cannot reject an approved payment'; end if;

  update public.manual_payments
  set status = 'rejected', rejected_reason = p_reason, rejected_by = admin_email, rejected_at = now()
  where id = p_payment_id;

  select coalesce(
    (select title from public.courses where id = pay.course_id),
    (select 'Bundle: ' || title from public.bundles where id = pay.bundle_id),
    'your course'
  ) into target_name;

  insert into public.student_notifications (user_id, type, title, message, course_id)
  values (pay.user_id, 'payment_rejected', 'Payment Could Not Be Verified',
    'Your payment for ' || target_name || ' could not be verified. Reason: ' || p_reason || '. Please contact DANQEL DIGITAL INSTITUTE if you believe this was an error.',
    pay.course_id);

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (admin_email, admin_email, 'payment.reject', 'manual_payment', p_payment_id::text,
    jsonb_build_object('reason', p_reason, 'userId', pay.user_id));

  return jsonb_build_object('ok', true, 'paymentId', p_payment_id);
end $$;

-- Future automatic certificates retain the established completion gates,
-- certificate ID/code generation, XP award, notification, and race handling.
create or replace function public.maybe_issue_certificate()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid; cid uuid;
  need_lessons int := 100; need_quiz int := 0; need_asg int := 0; need_final boolean := false;
  total_lessons int; done_lessons int; pct int;
  qavg numeric; approved_asg int; finals uuid[]; final_ok boolean;
  r record;
begin
  if TG_TABLE_NAME = 'lesson_progress' then uid := new.user_id; cid := new.course_id;
  elsif TG_TABLE_NAME = 'quiz_attempts' then uid := new.user_id; cid := new.course_id;
  elsif TG_TABLE_NAME = 'assignment_submissions' then
    if TG_OP = 'UPDATE' and (old.status = new.status or new.status != 'approved') then return new; end if;
    if TG_OP = 'INSERT' and new.status != 'approved' then return new; end if;
    uid := new.user_id; cid := new.course_id;
  else return new; end if;

  if exists (select 1 from public.certificate_issues
             where user_id = uid and course_id = cid and status = 'valid') then
    return new;
  end if;

  select * into r from public.course_completion_rules where course_id = cid;
  if found then
    need_lessons := coalesce(r.require_lessons_pct, 100);
    need_quiz := coalesce(r.require_quiz_avg, 0);
    need_asg := coalesce(r.require_assignments_approved, 0);
    need_final := coalesce(r.require_final_project, false);
  end if;

  select count(*) into total_lessons from public.course_lessons where course_id = cid;
  select count(*) into done_lessons from public.lesson_progress where user_id = uid and course_id = cid;
  pct := case when total_lessons > 0 then round(done_lessons * 100.0 / total_lessons)::int else 100 end;
  if pct < need_lessons then return new; end if;

  if need_quiz > 0 then
    select coalesce(round(avg(best)), 0) into qavg
    from (select max(score) as best from public.quiz_attempts
          where user_id = uid and course_id = cid group by quiz_id) t;
    if qavg < need_quiz then return new; end if;
  end if;

  if need_asg > 0 then
    select count(distinct assignment_id) into approved_asg
    from public.assignment_submissions
    where user_id = uid and course_id = cid and status = 'approved';
    if approved_asg < need_asg then return new; end if;
  end if;

  if need_final then
    select coalesce(array_agg(id), '{}') into finals
    from public.assignments where course_id = cid and is_final_project = true;
    if coalesce(array_length(finals, 1), 0) = 0 then return new; end if;
    select exists (
      select 1 from public.assignment_submissions
      where user_id = uid and assignment_id = any(finals) and status = 'approved'
    ) into final_ok;
    if not final_ok then return new; end if;
  end if;

  insert into public.certificate_issues
    (certificate_id, verification_code, user_id, student_name, course_id, course_name, status, issued_by)
  select public.gen_cert_id(), public.gen_verify_code(), uid, p.full_name, cid, c.title, 'valid', 'DANQEL DIGITAL INSTITUTE'
  from public.profiles p, public.courses c where p.id = uid and c.id = cid;

  insert into public.xp_events (user_id, rule, xp, ref_table, ref_id)
  values (uid, 'course_complete', 100, 'courses', cid);

  insert into public.student_notifications (user_id, type, title, message, course_id)
  values (uid, 'course_completed', 'Course Completed! 🎓',
    'Congratulations! You completed the course. Your certificate is ready in My Certificates.',
    cid);

  return new;
exception when unique_violation then
  return new;
end $$;

-- Manual issue remains admin-only and idempotent. Store the institution as
-- issuer while retaining the acting admin in the append-only audit record.
create or replace function public.issue_certificate_manual(p_user_id uuid, p_course_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare existing record; admin_email text; new_id uuid; new_cert_id text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select email into admin_email from public.profiles where id = auth.uid();
  select * into existing from public.certificate_issues
  where user_id = p_user_id and course_id = p_course_id and status = 'valid';
  if found then
    return jsonb_build_object('id', existing.id, 'certificateId', existing.certificate_id, 'existing', true);
  end if;
  insert into public.certificate_issues
    (certificate_id, verification_code, user_id, student_name, course_id, course_name, status, issued_by)
  select public.gen_cert_id(), public.gen_verify_code(), p_user_id, p.full_name, p_course_id, c.title, 'valid', 'DANQEL DIGITAL INSTITUTE'
  from public.profiles p, public.courses c where p.id = p_user_id and c.id = p_course_id
  returning id, certificate_id into new_id, new_cert_id;

  insert into public.student_notifications (user_id, type, title, message, course_id)
  values (p_user_id, 'course_completed', 'Congratulations! 🎓',
    'Congratulations! 🎓 Your DANQEL DIGITAL INSTITUTE certificate is now available.', p_course_id);

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (admin_email, admin_email, 'certificate.issue_manual', 'certificate', new_id::text,
    jsonb_build_object('userId', p_user_id, 'courseId', p_course_id));

  return jsonb_build_object('id', new_id, 'certificateId', new_cert_id, 'existing', false);
end $$;

-- Coupon validation, redemption accounting and enrollment behavior stay the
-- same; the student-facing success message carries the current institution.
create or replace function public.redeem_coupon(p_code text, p_course_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.coupons%rowtype;
  course_price int;
  uses int;
  discount int;
  due int;
  me uuid := auth.uid();
  my_email text; my_phone text;
  course_title text;
begin
  select * into c from public.coupons where code = upper(trim(p_code)) for update;
  if not found then return jsonb_build_object('valid', false, 'reason', 'Invalid coupon code'); end if;
  if not c.active then return jsonb_build_object('valid', false, 'reason', 'This coupon is inactive'); end if;
  if c.expires_at is not null and c.expires_at < now() then return jsonb_build_object('valid', false, 'reason', 'This coupon has expired'); end if;
  if c.course_id is not null and c.course_id != p_course_id then return jsonb_build_object('valid', false, 'reason', 'This coupon is not valid for this course'); end if;
  select count(*) into uses from public.coupon_redemptions where coupon_id = c.id;
  if c.max_uses is not null and uses >= c.max_uses then return jsonb_build_object('valid', false, 'reason', 'This coupon has reached its usage limit'); end if;
  select email, phone into my_email, my_phone from public.profiles where id = me;
  if c.restricted_user_id is not null and c.restricted_user_id != me then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  if c.restricted_email is not null and lower(c.restricted_email) != lower(coalesce(my_email,'')) then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  if c.restricted_phone is not null and right(regexp_replace(c.restricted_phone, '[^0-9]', '', 'g'), 10) != right(regexp_replace(coalesce(my_phone,''), '[^0-9]', '', 'g'), 10) then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  select price, title into course_price, course_title from public.courses where id = p_course_id;
  if course_price is null then return jsonb_build_object('valid', false, 'reason', 'Course not found'); end if;
  if c.min_purchase > 0 and course_price < c.min_purchase then return jsonb_build_object('valid', false, 'reason', 'Minimum purchase not met'); end if;
  if c.discount_type = 'free' or (c.discount_type = 'percentage' and c.discount_value >= 100) then discount := course_price;
  elsif c.discount_type = 'percentage' then discount := round(course_price * c.discount_value / 100.0);
  else discount := least(c.discount_value, course_price); end if;
  due := greatest(0, course_price - discount);
  if exists (select 1 from public.coupon_redemptions r
             where r.coupon_id = c.id and r.user_id = me and r.course_id = p_course_id) then
    return jsonb_build_object('valid', true, 'discount', discount, 'amountDue', due, 'isFree', due = 0, 'duplicate', true);
  end if;
  insert into public.coupon_redemptions (coupon_id, coupon_code, user_id, course_id, discount, amount_due)
  values (c.id, c.code, me, p_course_id, discount, due);
  update public.coupons set used_count = used_count + 1 where id = c.id;
  if due = 0 then
    insert into public.enrollments (user_id, course_id, method, coupon_code)
    values (me, p_course_id, 'coupon', c.code)
    on conflict (user_id, course_id) do update set status = 'active', method = 'coupon', coupon_code = c.code;
    insert into public.student_notifications (user_id, type, title, message, course_id)
    values (me, 'coupon_approved', 'Enrollment Activated! 🎉',
      'Your coupon ' || c.code || ' was approved. You now have FULL access to ' || course_title || '. DANQEL DIGITAL INSTITUTE - Technology • Science • Digital Learning',
      p_course_id);
  end if;
  return jsonb_build_object('valid', true, 'discount', discount, 'amountDue', due, 'isFree', due = 0);
end $$;
