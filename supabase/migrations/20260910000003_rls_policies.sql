-- =====================================================================
-- WOLI DAN TECH HUB
-- Migration 003: Row Level Security (RLS) policies
--
-- Rules:
--  * students see/touch ONLY their own data
--  * students can never approve/reject payments or change prices
--  * only admins manage courses, payments, students, certificates
--  * lesson content requires an ACTIVE/COMPLETED enrollment
--  * the service role bypasses RLS for trusted server operations
-- =====================================================================

-- Base table privileges (RLS still enforces row-level rules)
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select                        on all tables in schema public to anon;
grant all                           on all tables in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select on tables to anon;
alter default privileges in schema public
  grant all on tables to service_role;

-- Enable RLS everywhere
alter table public.profiles            enable row level security;
alter table public.course_categories   enable row level security;
alter table public.courses             enable row level security;
alter table public.course_modules      enable row level security;
alter table public.lessons             enable row level security;
alter table public.payments            enable row level security;
alter table public.enrollments         enable row level security;
alter table public.payment_receipts    enable row level security;
alter table public.lesson_progress     enable row level security;
alter table public.certificates        enable row level security;
alter table public.certificate_counters enable row level security;
alter table public.notifications       enable row level security;
alter table public.audit_logs          enable row level security;
alter table public.platform_settings   enable row level security;

-- Helper to (re)create policies idempotently
create or replace function public._drop_policy(p_table text, p_policy text)
returns void language plpgsql set search_path = public as $$
begin
  execute format('drop policy if exists %I on %s', p_policy, p_table);
end $$;

-- =================================================================
-- profiles
-- =================================================================
select public._drop_policy('public.profiles', 'profiles_select_own');
select public._drop_policy('public.profiles', 'profiles_update_own');
select public._drop_policy('public.profiles', 'profiles_admin_all');

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Students update only their own profile; role changes are blocked
-- for non-admins by the trg_profiles_role_guard trigger.
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- =================================================================
-- course_categories  (public catalog data)
-- =================================================================
select public._drop_policy('public.course_categories', 'categories_public_read');
select public._drop_policy('public.course_categories', 'categories_admin_write');

create policy categories_public_read on public.course_categories
  for select to anon, authenticated
  using (true);

create policy categories_admin_write on public.course_categories
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- =================================================================
-- courses
-- =================================================================
select public._drop_policy('public.courses', 'courses_public_read');
select public._drop_policy('public.courses', 'courses_admin_write');

create policy courses_public_read on public.courses
  for select to anon, authenticated
  using (
    is_published
    or public.is_admin()
    or public.is_course_instructor(id)
  );

create policy courses_admin_write on public.courses
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- =================================================================
-- course_modules  (curriculum outline visible for published courses;
-- enrolled students, instructors and admins always see them)
-- =================================================================
select public._drop_policy('public.course_modules', 'modules_read');
select public._drop_policy('public.course_modules', 'modules_admin_write');

create policy modules_read on public.course_modules
  for select to anon, authenticated
  using (
    exists (select 1 from public.courses c
            where c.id = course_modules.course_id and c.is_published)
    or public.is_admin()
    or public.is_course_instructor(course_id)
    or public.has_active_enrollment(course_id)
  );

create policy modules_admin_write on public.course_modules
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- =================================================================
-- lessons  — CONTENT IS GATED.
-- Full lesson data (video_url, content, resource_url) is readable
-- only by: enrolled students (ACTIVE/COMPLETED), the course
-- instructor, or an admin. Public curriculum outlines are served by
-- the backend API (service role) which returns only safe columns.
-- =================================================================
select public._drop_policy('public.lessons', 'lessons_read_gated');
select public._drop_policy('public.lessons', 'lessons_admin_write');

create policy lessons_read_gated on public.lessons
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.course_modules m
      where m.id = lessons.module_id
        and (
          public.is_course_instructor(m.course_id)
          or public.has_active_enrollment(m.course_id)
        )
    )
  );

create policy lessons_admin_write on public.lessons
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- =================================================================
-- payments
-- =================================================================
select public._drop_policy('public.payments', 'payments_select_own');
select public._drop_policy('public.payments', 'payments_insert_own_pending');
select public._drop_policy('public.payments', 'payments_admin_all');

create policy payments_select_own on public.payments
  for select to authenticated
  using (student_id = public.current_profile_id() or public.is_admin());

-- Students may only submit PENDING manual-bank-transfer payments
-- for themselves. They can NEVER update the status afterwards
-- (no UPDATE policy for students).
create policy payments_insert_own_pending on public.payments
  for insert to authenticated
  with check (
    student_id = public.current_profile_id()
    and status = 'PENDING'
    and payment_method = 'MANUAL_BANK_TRANSFER'
    and reviewed_at is null
    and reviewed_by is null
  );

create policy payments_admin_all on public.payments
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- =================================================================
-- enrollments  (created/activated only by approve_payment via the
-- service role — students cannot enroll themselves or change status)
-- =================================================================
select public._drop_policy('public.enrollments', 'enrollments_select_own');

create policy enrollments_select_own on public.enrollments
  for select to authenticated
  using (
    student_id = public.current_profile_id()
    or public.is_admin()
    or public.is_course_instructor(course_id)
  );

-- (intentionally no INSERT/UPDATE/DELETE policies for authenticated
-- users — enrollment mutations are service-role only)

-- =================================================================
-- payment_receipts
-- =================================================================
select public._drop_policy('public.payment_receipts', 'receipts_select_own');
select public._drop_policy('public.payment_receipts', 'receipts_insert_own');

create policy receipts_select_own on public.payment_receipts
  for select to authenticated
  using (student_id = public.current_profile_id() or public.is_admin());

create policy receipts_insert_own on public.payment_receipts
  for insert to authenticated
  with check (
    student_id = public.current_profile_id()
    and exists (
      select 1 from public.payments p
      where p.id = payment_receipts.payment_id
        and p.student_id = public.current_profile_id()
        and p.status = 'PENDING'
    )
  );

-- =================================================================
-- lesson_progress
-- =================================================================
select public._drop_policy('public.lesson_progress', 'progress_select_own');
select public._drop_policy('public.lesson_progress', 'progress_insert_own');
select public._drop_policy('public.lesson_progress', 'progress_update_own');

create policy progress_select_own on public.lesson_progress
  for select to authenticated
  using (
    student_id = public.current_profile_id()
    or public.is_admin()
    or public.is_course_instructor(course_id)
  );

-- Students can only create progress for themselves AND only for
-- courses with an ACTIVE/COMPLETED enrollment.
create policy progress_insert_own on public.lesson_progress
  for insert to authenticated
  with check (
    student_id = public.current_profile_id()
    and public.has_active_enrollment(course_id)
  );

create policy progress_update_own on public.lesson_progress
  for update to authenticated
  using (student_id = public.current_profile_id())
  with check (
    student_id = public.current_profile_id()
    and public.has_active_enrollment(course_id)
  );

-- =================================================================
-- certificates
-- =================================================================
select public._drop_policy('public.certificates', 'certificates_select_own');
select public._drop_policy('public.certificates', 'certificates_admin_update');

create policy certificates_select_own on public.certificates
  for select to authenticated
  using (student_id = public.current_profile_id() or public.is_admin());

-- Admins may revoke/reactivate; issuance happens via triggers.
create policy certificates_admin_update on public.certificates
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- certificate_counters: no policies -> service role only.

-- =================================================================
-- notifications
-- =================================================================
select public._drop_policy('public.notifications', 'notifications_select_own');
select public._drop_policy('public.notifications', 'notifications_update_own');

create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = public.current_profile_id() or public.is_admin());

-- Users may only mark their own notifications read/unread
-- (content changes blocked by trg_notifications_guard).
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = public.current_profile_id())
  with check (user_id = public.current_profile_id());

-- =================================================================
-- audit_logs  (read-only for admins; written by the system)
-- =================================================================
select public._drop_policy('public.audit_logs', 'audit_admin_read');

create policy audit_admin_read on public.audit_logs
  for select to authenticated
  using (public.is_admin());

-- =================================================================
-- platform_settings
-- =================================================================
select public._drop_policy('public.platform_settings', 'settings_public_read');
select public._drop_policy('public.platform_settings', 'settings_admin_write');

create policy settings_public_read on public.platform_settings
  for select to anon, authenticated
  using (is_public = true or public.is_admin());

create policy settings_admin_write on public.platform_settings
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop function if exists public._drop_policy(text, text);
