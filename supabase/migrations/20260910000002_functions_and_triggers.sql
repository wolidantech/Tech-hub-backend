-- =====================================================================
-- WOLI DAN TECH HUB
-- Migration 002: Functions & triggers (business logic, atomic
-- payment approval / rejection, course completion, certificates)
-- =====================================================================

-- -----------------------------------------------------------------
-- Security helper functions (SECURITY DEFINER so RLS policies can
-- call them without causing recursive policy evaluation)
-- -----------------------------------------------------------------
create or replace function public.current_profile_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select id from public.profiles where user_id = auth.uid()
$$;

create or replace function public.current_role()
returns public.user_role
language sql stable security definer
set search_path = public
as $$
  select role from public.profiles where user_id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role = 'admin'
  )
$$;

create or replace function public.is_instructor()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role = 'instructor'
  )
$$;

-- TRUE when the current user has an ACTIVE/COMPLETED enrollment for
-- the given course (i.e. their payment was approved by an admin).
create or replace function public.has_active_enrollment(p_course_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.enrollments e
    join public.profiles p on p.id = e.student_id
    where p.user_id = auth.uid()
      and e.course_id = p_course_id
      and e.status in ('ACTIVE', 'COMPLETED')
  )
$$;

create or replace function public.is_course_instructor(p_course_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.courses c
    join public.profiles p on p.id = c.instructor_id
    where c.id = p_course_id and p.user_id = auth.uid()
  )
$$;

-- -----------------------------------------------------------------
-- Generic updated_at maintenance
-- -----------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at   on public.profiles;
drop trigger if exists trg_courses_updated_at    on public.courses;
drop trigger if exists trg_modules_updated_at    on public.course_modules;
drop trigger if exists trg_lessons_updated_at    on public.lessons;
drop trigger if exists trg_payments_updated_at   on public.payments;
drop trigger if exists trg_progress_updated_at   on public.lesson_progress;

create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger trg_courses_updated_at before update on public.courses
  for each row execute function public.set_updated_at();
create trigger trg_modules_updated_at before update on public.course_modules
  for each row execute function public.set_updated_at();
create trigger trg_lessons_updated_at before update on public.lessons
  for each row execute function public.set_updated_at();
create trigger trg_payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();
create trigger trg_progress_updated_at before update on public.lesson_progress
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------
-- New auth user -> profile + WELCOME notification
-- Sign-up ALWAYS creates a student. admin/instructor roles can only
-- be granted later by an administrator (server side).
-- -----------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_full_name  text;
begin
  v_full_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(coalesce(new.email, 'user'), '@', 1)
  );

  insert into public.profiles (user_id, full_name, email, phone, role)
  values (
    new.id,
    v_full_name,
    coalesce(new.email, ''),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    'student'
  )
  on conflict (user_id) do nothing
  returning id into v_profile_id;

  if v_profile_id is not null then
    insert into public.notifications (user_id, title, message, type)
    values (
      v_profile_id,
      'Welcome to WOLI DAN TECH HUB',
      'Welcome aboard! LEARN • BUILD • GROW. Browse the course catalog, enroll, and start building your future today.',
      'WELCOME'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------
-- Prevent role escalation: only admins (or the service role /
-- migration context where auth.uid() is null) may change a role.
-- Users can never grant themselves admin/instructor.
-- -----------------------------------------------------------------
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if auth.uid() is not null and not public.is_admin() then
      raise exception 'FORBIDDEN: only administrators can change user roles';
    end if;
  end if;

  -- Users may not edit another user's profile through RLS, but guard
  -- the user_id column itself as well.
  if new.user_id is distinct from old.user_id then
    raise exception 'FORBIDDEN: profile ownership cannot be changed';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_role_guard on public.profiles;
create trigger trg_profiles_role_guard
  before update on public.profiles
  for each row execute function public.prevent_role_escalation();

-- -----------------------------------------------------------------
-- Notifications: authenticated users may only flip is_read.
-- -----------------------------------------------------------------
create or replace function public.notifications_guard()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.user_id is distinct from old.user_id
       or new.title   is distinct from old.title
       or new.message is distinct from old.message
       or new.type    is distinct from old.type then
      raise exception 'FORBIDDEN: notification content cannot be modified';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notifications_guard on public.notifications;
create trigger trg_notifications_guard
  before update on public.notifications
  for each row execute function public.notifications_guard();

-- -----------------------------------------------------------------
-- Notification when a payment is submitted
-- -----------------------------------------------------------------
create or replace function public.handle_payment_submitted()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_course_title text;
begin
  if tg_op = 'INSERT' and new.status = 'PENDING' then
    select title into v_course_title from public.courses where id = new.course_id;

    insert into public.notifications (user_id, title, message, type)
    values (
      new.student_id,
      'Payment received — awaiting verification',
      'We received your payment of NGN ' || to_char(new.amount, 'FM999,999,990.00')
        || ' for "' || coalesce(v_course_title, 'your course')
        || '" (ref: ' || new.transaction_reference
        || '). Our team will verify it shortly and activate your course access.',
      'PAYMENT_SUBMITTED'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payment_submitted on public.payments;
create trigger trg_payment_submitted
  after insert on public.payments
  for each row execute function public.handle_payment_submitted();

-- -----------------------------------------------------------------
-- Certificate numbering: WDTH-YYYY-000001 (sequential per year)
-- -----------------------------------------------------------------
create or replace function public.next_certificate_number()
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from now())::integer;
  v_next integer;
begin
  insert into public.certificate_counters (year, value)
  values (v_year, 1)
  on conflict (year)
  do update set value = public.certificate_counters.value + 1
  returning value into v_next;

  return 'WDTH-' || v_year::text || '-' || lpad(v_next::text, 6, '0');
end;
$$;

-- -----------------------------------------------------------------
-- approve_payment: ATOMIC approval pipeline (single transaction)
--   1. payment  -> APPROVED (reviewed_by / reviewed_at)
--   2. enrollment created (or re-activated) -> ACTIVE
--   3. notifications to the student
--   4. admin audit event
-- Callable ONLY by the service role (the backend API, which has
-- already verified the caller is an admin).
-- -----------------------------------------------------------------
create or replace function public.approve_payment(p_payment_id uuid, p_admin_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_payment      public.payments%rowtype;
  v_enrollment   uuid;
  v_course_title text;
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

  -- 3) Notify the student
  insert into public.notifications (user_id, title, message, type) values
    (v_payment.student_id,
     'Payment approved',
     'Your payment for "' || coalesce(v_course_title, 'your course')
       || '" has been approved. Enjoy the course!',
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
  );

  return jsonb_build_object(
    'payment_id',    p_payment_id,
    'status',        'APPROVED',
    'enrollment_id', v_enrollment
  );
end;
$$;

-- -----------------------------------------------------------------
-- reject_payment: ATOMIC rejection pipeline (single transaction)
-- -----------------------------------------------------------------
create or replace function public.reject_payment(p_payment_id uuid, p_admin_id uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_payment      public.payments%rowtype;
  v_course_title text;
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
  );

  return jsonb_build_object('payment_id', p_payment_id, 'status', 'REJECTED');
end;
$$;

-- -----------------------------------------------------------------
-- Course completion: fires when a lesson is marked completed.
-- When every published lesson of the course is completed:
--   enrollment -> COMPLETED, certificate issued, notifications sent.
-- Also emits a LESSON_COMPLETED milestone notification when a whole
-- module is finished.
-- -----------------------------------------------------------------
create or replace function public.handle_lesson_completion()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_total_lessons     integer;
  v_done_lessons      integer;
  v_module_id         uuid;
  v_module_title      text;
  v_module_total      integer;
  v_module_done       integer;
  v_course_title      text;
  v_enrollment_status public.enrollment_status;
  v_certificate       uuid;
begin
  -- Only react to a false -> true completion transition
  if not (new.completed and (tg_op = 'INSERT' or old.completed is distinct from true)) then
    return new;
  end if;

  select title into v_course_title from public.courses where id = new.course_id;

  -- ---- module milestone notification ------------------------------
  select m.id, m.title into v_module_id, v_module_title
    from public.lessons l
    join public.course_modules m on m.id = l.module_id
   where l.id = new.lesson_id;

  select count(*) into v_module_total
    from public.lessons
   where module_id = v_module_id and is_published;

  select count(*) into v_module_done
    from public.lesson_progress lp
    join public.lessons l on l.id = lp.lesson_id
   where lp.student_id = new.student_id
     and l.module_id   = v_module_id
     and l.is_published
     and lp.completed;

  if v_module_total > 0 and v_module_done >= v_module_total then
    insert into public.notifications (user_id, title, message, type)
    values (
      new.student_id,
      'Module completed',
      'Great work! You completed the module "' || coalesce(v_module_title, '') || '" in "' || coalesce(v_course_title, '') || '".',
      'LESSON_COMPLETED'
    );
  end if;

  -- ---- course completion check ------------------------------------
  select count(*) into v_total_lessons
    from public.lessons l
    join public.course_modules m on m.id = l.module_id
   where m.course_id = new.course_id and l.is_published;

  select count(*) into v_done_lessons
    from public.lesson_progress lp
    join public.lessons l        on l.id = lp.lesson_id
    join public.course_modules m on m.id = l.module_id
   where lp.student_id = new.student_id
     and m.course_id   = new.course_id
     and l.is_published
     and lp.completed;

  if v_total_lessons > 0 and v_done_lessons >= v_total_lessons then
    update public.enrollments
       set status       = 'COMPLETED',
           completed_at = coalesce(completed_at, now())
     where student_id = new.student_id
       and course_id  = new.course_id
       and status     = 'ACTIVE'
    returning status into v_enrollment_status;

    if found then
      insert into public.notifications (user_id, title, message, type)
      values (
        new.student_id,
        'Course completed',
        'Congratulations! You have completed ' || coalesce(v_course_title, 'the course') || '. Your certificate is now available.',
        'COURSE_COMPLETED'
      );

      insert into public.certificates (student_id, course_id, certificate_number)
      values (new.student_id, new.course_id, public.next_certificate_number())
      on conflict (student_id, course_id) do nothing
      returning id into v_certificate;

      if v_certificate is not null then
        insert into public.notifications (user_id, title, message, type)
        values (
          new.student_id,
          'Certificate issued',
          'Your certificate for "' || coalesce(v_course_title, 'the course') || '" is ready. View and download it from your Certificates page.',
          'CERTIFICATE_ISSUED'
        );
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_lesson_completion on public.lesson_progress;
create trigger trg_lesson_completion
  after insert or update on public.lesson_progress
  for each row execute function public.handle_lesson_completion();

-- -----------------------------------------------------------------
-- Public certificate verification (no authentication required).
-- Returns only non-sensitive information.
-- -----------------------------------------------------------------
create or replace function public.verify_certificate(p_identifier text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
           'valid',              c.status = 'ACTIVE',
           'status',             c.status,
           'student_name',       p.full_name,
           'course_name',        co.title,
           'date_completed',     e.completed_at,
           'certificate_number', c.certificate_number,
           'issued_at',          c.issued_at,
           'issued_by',          'WOLI DAN TECH HUB'
         )
    into v_result
    from public.certificates c
    join public.profiles p  on p.id  = c.student_id
    join public.courses  co on co.id = c.course_id
    left join public.enrollments e
           on e.student_id = c.student_id and e.course_id = c.course_id
   where c.certificate_number = upper(trim(p_identifier))
      or c.verification_code = lower(trim(p_identifier));

  return v_result; -- null when not found
end;
$$;

-- -----------------------------------------------------------------
-- Admin dashboard statistics (service_role only).
-- Revenue only counts APPROVED payments.
-- -----------------------------------------------------------------
create or replace function public.admin_statistics()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'total_students',      (select count(*) from public.profiles where role = 'student'),
    'total_instructors',   (select count(*) from public.profiles where role = 'instructor'),
    'total_courses',       (select count(*) from public.courses),
    'published_courses',   (select count(*) from public.courses where is_published),
    'total_enrollments',   (select count(*) from public.enrollments),
    'active_students',     (select count(distinct student_id) from public.enrollments where status = 'ACTIVE'),
    'active_enrollments',  (select count(*) from public.enrollments where status = 'ACTIVE'),
    'completed_courses',   (select count(*) from public.enrollments where status = 'COMPLETED'),
    'certificates_issued', (select count(*) from public.certificates),
    'pending_payments',    (select count(*) from public.payments where status = 'PENDING'),
    'approved_payments',   (select count(*) from public.payments where status = 'APPROVED'),
    'rejected_payments',   (select count(*) from public.payments where status = 'REJECTED'),
    'total_revenue',       coalesce((select sum(amount) from public.payments where status = 'APPROVED'), 0),
    'monthly_revenue',     coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'revenue', m.revenue, 'payments', m.payments) order by m.month)
      from (
        select to_char(date_trunc('month', reviewed_at), 'YYYY-MM') as month,
               sum(amount)   as revenue,
               count(*)      as payments
          from public.payments
         where status = 'APPROVED'
           and reviewed_at >= date_trunc('month', now()) - interval '5 months'
         group by 1
      ) m
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- -----------------------------------------------------------------
-- Atomic reordering helpers (single transaction, unique-order safe)
-- -----------------------------------------------------------------
create or replace function public.reorder_modules(p_course_id uuid, p_module_ids uuid[])
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_i  integer := 0;
begin
  -- Phase 1: park every module at a temporary negative position
  foreach v_id in array p_module_ids loop
    v_i := v_i + 1;
    update public.course_modules
       set order_number = -v_i
     where id = v_id and course_id = p_course_id;
  end loop;

  -- Phase 2: assign final positions
  v_i := 0;
  foreach v_id in array p_module_ids loop
    v_i := v_i + 1;
    update public.course_modules
       set order_number = v_i
     where id = v_id and course_id = p_course_id;
  end loop;
end;
$$;

create or replace function public.reorder_lessons(p_module_id uuid, p_lesson_ids uuid[])
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_i  integer := 0;
begin
  foreach v_id in array p_lesson_ids loop
    v_i := v_i + 1;
    update public.lessons
       set order_number = -v_i
     where id = v_id and module_id = p_module_id;
  end loop;

  v_i := 0;
  foreach v_id in array p_lesson_ids loop
    v_i := v_i + 1;
    update public.lessons
       set order_number = v_i
     where id = v_id and module_id = p_module_id;
  end loop;
end;
$$;

-- -----------------------------------------------------------------
-- Privileges: sensitive functions are executable ONLY by the
-- service role (i.e. the backend API). Public verification is
-- available to everyone.
-- -----------------------------------------------------------------
revoke execute on function public.approve_payment(uuid, uuid)          from public, anon, authenticated;
revoke execute on function public.reject_payment(uuid, uuid, text)     from public, anon, authenticated;
revoke execute on function public.admin_statistics()                   from public, anon, authenticated;
revoke execute on function public.reorder_modules(uuid, uuid[])        from public, anon, authenticated;
revoke execute on function public.reorder_lessons(uuid, uuid[])        from public, anon, authenticated;
revoke execute on function public.next_certificate_number()            from public, anon, authenticated;

grant execute on function public.approve_payment(uuid, uuid)       to service_role;
grant execute on function public.reject_payment(uuid, uuid, text)  to service_role;
grant execute on function public.admin_statistics()                to service_role;
grant execute on function public.reorder_modules(uuid, uuid[])     to service_role;
grant execute on function public.reorder_lessons(uuid, uuid[])     to service_role;
grant execute on function public.next_certificate_number()         to service_role;

grant execute on function public.verify_certificate(text) to anon, authenticated, service_role;
