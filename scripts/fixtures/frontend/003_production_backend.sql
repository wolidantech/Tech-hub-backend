-- ============================================================
-- WOLI DAN TECH HUB LMS — 003 production backend
-- Run after 001 + 002. Additive only; destroys no data.
-- Adds: auth profile trigger, quiz RPCs (server scoring), payment
-- approval RPCs, certificate auto-issue triggers, XP ledger,
-- portfolio/leaderboard/showcase RPCs, admin stats RPCs,
-- announcements, extra buckets, RLS hardening, realtime.
-- ============================================================

-- ============================================================
-- 1. AUTO-CREATE PROFILE ON SIGNUP
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, phone, role)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    new.email,
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    'student'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 2. SCHEMA FIXES / ADDITIONS
-- ============================================================

-- 2a. short_answer question type (002 added accepted_answers but the
--     001 CHECK constraint would reject the type itself)
alter table public.quiz_questions drop constraint if exists quiz_questions_type_check;
alter table public.quiz_questions
  add constraint quiz_questions_type_check
  check (type in ('multiple_choice','true_false','multiple_answer','short_answer'));

-- 2b. lesson resources (downloadable files live in `resources` bucket)
alter table public.course_lessons add column if not exists resources jsonb default '[]';

-- 2c. enrollments: link to approving payment + approver
alter table public.enrollments add column if not exists payment_id uuid;
alter table public.enrollments add column if not exists approved_by text;

-- 2d. bundle payments carry bundle_id instead of a course_id
alter table public.manual_payments alter column course_id drop not null;

-- 2e. denormalized student name on submissions (for showcase/lists)
alter table public.assignment_submissions add column if not exists student_name text;

-- 2f. announcements (admin broadcasts; students read)
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text not null,
  course_id uuid references public.courses(id) on delete set null,
  created_by text,
  created_at timestamptz default now()
);
alter table public.announcements enable row level security;
drop policy if exists "announcements auth read" on public.announcements;
create policy "announcements auth read" on public.announcements
  for select using (auth.uid() is not null);
drop policy if exists "admin write announcements" on public.announcements;
create policy "admin write announcements" on public.announcements
  for all using (public.is_admin());

-- 2g. generic updated_at toucher
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_touch_courses on public.courses;
create trigger trg_touch_courses before update on public.courses
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_touch_ai_content on public.ai_generated_content;
create trigger trg_touch_ai_content before update on public.ai_generated_content
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_touch_settings on public.site_settings;
create trigger trg_touch_settings before update on public.site_settings
  for each row execute function public.touch_updated_at();

-- 2h. enrollment counter trigger (keeps courses.students_count exact)
create or replace function public.bump_students_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.courses set students_count = students_count + 1 where id = new.course_id;
  return new;
end $$;
drop trigger if exists trg_enrollment_count on public.enrollments;
create trigger trg_enrollment_count after insert on public.enrollments
  for each row execute function public.bump_students_count();

-- 2i. protect privileged profile columns from self-escalation
create or replace function public.protect_profile_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- No JWT (service_role / SQL editor): allowed. RLS still gates WHO can
  -- update; this trigger only stops self-escalation through the app.
  if auth.uid() is null then return new; end if;
  if public.is_admin() then return new; end if;
  if new.role is distinct from old.role then
    raise exception 'You cannot change your own role';
  end if;
  if new.banned is distinct from old.banned then
    raise exception 'You cannot change ban status';
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_profiles on public.profiles;
create trigger trg_protect_profiles before update on public.profiles
  for each row execute function public.protect_profile_columns();

-- ============================================================
-- 3. STORAGE: EXTRA BUCKETS + ENROLLED-READ POLICIES
-- Path conventions:
--   avatars/{userId}/...
--   resources/{courseId}/...      (lesson resources)
--   lesson-videos/{courseId}/...  (uploaded lesson videos)
--   submissions/{userId}/...      (assignment files)
--   receipts/{userId}/...         (payment receipts)
--   certificates/{userId}/...     (certificate PDFs)
-- ============================================================
insert into storage.buckets (id, name, public) values
  ('avatars', 'avatars', true),
  ('resources', 'resources', false),
  ('certificates', 'certificates', false)
on conflict (id) do update set public = excluded.public;

-- avatars: public read, owner write
drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'avatars');
drop policy if exists "avatars owner write" on storage.objects;
create policy "avatars owner write" on storage.objects
  for insert with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
drop policy if exists "avatars owner update" on storage.objects;
create policy "avatars owner update" on storage.objects
  for update using (bucket_id = 'avatars' and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin()));
drop policy if exists "avatars admin delete" on storage.objects;
create policy "avatars admin delete" on storage.objects
  for delete using (bucket_id = 'avatars' and public.is_admin());

-- resources: enrolled students of that course + admin
drop policy if exists "resources enrolled read" on storage.objects;
create policy "resources enrolled read" on storage.objects
  for select using (
    bucket_id = 'resources' and (
      public.is_admin() or exists (
        select 1 from public.enrollments e
        where e.user_id = auth.uid()
          and e.status = 'active'
          and e.course_id = ((storage.foldername(name))[1])::uuid
      )
    )
  );
drop policy if exists "resources admin write" on storage.objects;
create policy "resources admin write" on storage.objects
  for insert with check (bucket_id = 'resources' and public.is_admin());
drop policy if exists "resources admin delete" on storage.objects;
create policy "resources admin delete" on storage.objects
  for delete using (bucket_id = 'resources' and public.is_admin());

-- lesson-videos: enrolled students of that course + admin
drop policy if exists "videos enrolled read" on storage.objects;
create policy "videos enrolled read" on storage.objects
  for select using (
    bucket_id = 'lesson-videos' and (
      public.is_admin() or exists (
        select 1 from public.enrollments e
        where e.user_id = auth.uid()
          and e.status = 'active'
          and e.course_id = ((storage.foldername(name))[1])::uuid
      )
    )
  );
drop policy if exists "videos admin write" on storage.objects;
create policy "videos admin write" on storage.objects
  for insert with check (bucket_id = 'lesson-videos' and public.is_admin());
drop policy if exists "videos admin delete" on storage.objects;
create policy "videos admin delete" on storage.objects
  for delete using (bucket_id = 'lesson-videos' and public.is_admin());

-- submissions: owner + admin, plus any authenticated user for files owned
-- by students with a PUBLIC portfolio (drives the project showcase)
drop policy if exists "submissions showcase read" on storage.objects;
create policy "submissions showcase read" on storage.objects
  for select using (
    bucket_id = 'submissions' and auth.uid() is not null and exists (
      select 1 from public.profiles p
      where p.id::text = (storage.foldername(name))[1]
        and p.portfolio_public = true
    )
  );
drop policy if exists "submissions admin delete" on storage.objects;
create policy "submissions admin delete" on storage.objects
  for delete using (bucket_id = 'submissions' and public.is_admin());
drop policy if exists "receipts admin all" on storage.objects;
create policy "receipts admin all" on storage.objects
  for all using (bucket_id = 'receipts' and public.is_admin());

-- certificates: owner + admin read; admin write
drop policy if exists "certificates owner read" on storage.objects;
create policy "certificates owner read" on storage.objects
  for select using (bucket_id = 'certificates' and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin()));
drop policy if exists "certificates admin write" on storage.objects;
create policy "certificates admin write" on storage.objects
  for insert with check (bucket_id = 'certificates' and public.is_admin());

-- ============================================================
-- 4. RLS HARDENING ON TABLES
-- ============================================================

-- 4a. students may only SUBMIT payments as pending (never self-approve)
drop policy if exists "students submit payments" on public.manual_payments;
create policy "students submit payments" on public.manual_payments
  for insert with check (auth.uid() = user_id and status = 'pending');

-- 4b. quiz answers must never be directly readable by students.
-- Students use get_quiz_questions()/get_quiz_review()/submit_quiz_attempt().
drop policy if exists "questions enrolled read" on public.quiz_questions;

-- 4c. quiz attempts are written ONLY via submit_quiz_attempt() RPC
-- (prevents fabricated scores). Admins keep full access.
drop policy if exists "students attempt" on public.quiz_attempts;

-- ============================================================
-- 5. COUPON VALIDATION WITHOUT REDEMPTION (checkout preview)
-- ============================================================
create or replace function public.validate_coupon(p_code text, p_course_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.coupons%rowtype;
  course_price int;
  uses int;
  discount int;
  due int;
  me uuid := auth.uid();
  my_email text; my_phone text;
begin
  if me is null then return jsonb_build_object('valid', false, 'reason', 'Please log in to use a coupon'); end if;
  select * into c from public.coupons where code = upper(trim(p_code));
  if not found then return jsonb_build_object('valid', false, 'reason', 'Invalid coupon code'); end if;
  if not c.active then return jsonb_build_object('valid', false, 'reason', 'This coupon is inactive'); end if;
  if c.expires_at is not null and c.expires_at < now() then return jsonb_build_object('valid', false, 'reason', 'This coupon has expired'); end if;
  if c.course_id is not null and c.course_id != p_course_id then return jsonb_build_object('valid', false, 'reason', 'This coupon is not valid for this course'); end if;
  select count(*) into uses from public.coupon_redemptions where coupon_id = c.id;
  if c.max_uses is not null and uses >= c.max_uses then return jsonb_build_object('valid', false, 'reason', 'This coupon has reached its usage limit'); end if;
  select email, phone into my_email, my_phone from public.profiles where id = me;
  if c.restricted_user_id is not null and c.restricted_user_id != me then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  if c.restricted_email is not null and lower(c.restricted_email) != lower(coalesce(my_email,'')) then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  if c.restricted_phone is not null and right(regexp_replace(c.restricted_phone, '\D', '', 'g'), 10) != right(regexp_replace(coalesce(my_phone,''), '\D', '', 'g'), 10) then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  select price into course_price from public.courses where id = p_course_id;
  if course_price is null then return jsonb_build_object('valid', false, 'reason', 'Course not found'); end if;
  if c.min_purchase > 0 and course_price < c.min_purchase then return jsonb_build_object('valid', false, 'reason', 'Minimum purchase not met'); end if;
  if c.discount_type = 'free' or (c.discount_type = 'percentage' and c.discount_value >= 100) then discount := course_price;
  elsif c.discount_type = 'percentage' then discount := round(course_price * c.discount_value / 100.0);
  else discount := least(c.discount_value, course_price); end if;
  due := greatest(0, course_price - discount);
  return jsonb_build_object('valid', true, 'discount', discount, 'amountDue', due,
    'isFree', due = 0, 'code', c.code, 'courseId', p_course_id);
end $$;

-- ============================================================
-- 6. QUIZ RPCs (server-side questions + scoring)
-- ============================================================

-- 6a. questions WITHOUT answers (for taking the quiz)
create or replace function public.get_quiz_questions(p_quiz_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); q record;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  select * into q from public.quizzes where id = p_quiz_id;
  if not found then raise exception 'Quiz not found'; end if;
  if q.status != 'published' and not public.is_admin() then raise exception 'Quiz is not available'; end if;
  if not public.is_admin() and not exists (
    select 1 from public.enrollments e
    where e.user_id = me and e.course_id = q.course_id and e.status = 'active'
  ) then raise exception 'Course access has not yet been approved'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', qq.id, 'type', qq.type, 'question', qq.question, 'options', qq.options
    ) order by qq.created_at, qq.id)
    from public.quiz_questions qq where qq.quiz_id = p_quiz_id
  ), '[]'::jsonb);
end $$;

-- 6b. questions WITH answers (review after attempting, or admin)
create or replace function public.get_quiz_review(p_quiz_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if not public.is_admin() and not exists (
    select 1 from public.quiz_attempts a where a.quiz_id = p_quiz_id and a.user_id = me
  ) then raise exception 'Attempt the quiz first to see the answers'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', qq.id, 'type', qq.type, 'question', qq.question, 'options', qq.options,
      'correctAnswer', qq.correct_answer, 'correctAnswers', qq.correct_answers,
      'acceptedAnswers', qq.accepted_answers, 'explanation', qq.explanation
    ) order by qq.created_at, qq.id)
    from public.quiz_questions qq where qq.quiz_id = p_quiz_id
  ), '[]'::jsonb);
end $$;

-- 6c. server-side attempt scoring + attempt-limit enforcement
create or replace function public.submit_quiz_attempt(p_quiz_id uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  q record; qq record;
  prior int; total int := 0; earned int := 0;
  given jsonb; ok boolean;
  details jsonb := '[]'::jsonb;
  att_id uuid; att_no int; scr int; passed boolean;
  gtext text; acc text;
  ga int[]; ca int[];
  gscalar text;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  select * into q from public.quizzes where id = p_quiz_id;
  if not found then raise exception 'Quiz not found'; end if;
  if q.status != 'published' then raise exception 'Quiz is not available'; end if;
  if not exists (
    select 1 from public.enrollments e
    where e.user_id = me and e.course_id = q.course_id and e.status = 'active'
  ) then raise exception 'Course access has not yet been approved'; end if;

  select count(*) into prior from public.quiz_attempts a where a.quiz_id = p_quiz_id and a.user_id = me;
  if prior > 0 and not coalesce(q.allow_retake, true) then raise exception 'Retakes are not allowed for this quiz'; end if;
  if q.attempt_limit is not null and prior >= q.attempt_limit then
    raise exception 'Attempt limit reached (%)', q.attempt_limit;
  end if;

  for qq in select * from public.quiz_questions where quiz_id = p_quiz_id order by created_at, id loop
    total := total + 1;
    given := p_answers -> qq.id::text;
    ok := false;
    if qq.type = 'multiple_answer' then
      select coalesce(array_agg(v::int order by v::int), '{}') into ga
      from jsonb_array_elements_text(coalesce(given, '[]'::jsonb)) v
      where v ~ '^-?\d+$';
      select coalesce(array_agg(v::int order by v::int), '{}') into ca
      from jsonb_array_elements_text(coalesce(qq.correct_answers, '[]'::jsonb)) v
      where v ~ '^-?\d+$';
      ok := (ga = ca) and (coalesce(array_length(ga, 1), 0) > 0);
    elsif qq.type = 'short_answer' then
      gtext := lower(trim(coalesce(given #>> '{}', '')));
      if gtext <> '' then
        foreach acc slice 0 in array coalesce(qq.accepted_answers, '{}') loop
          acc := lower(trim(acc));
          if acc <> '' and (gtext = acc or position(acc in gtext) > 0) then ok := true; exit; end if;
        end loop;
      end if;
    else
      gscalar := given #>> '{}';
      if gscalar ~ '^-?\d+$' and gscalar::int = coalesce(qq.correct_answer, -1) then ok := true; end if;
    end if;
    if ok then earned := earned + 1; end if;
    details := details || jsonb_build_object('questionId', qq.id, 'correct', ok, 'given', given);
  end loop;

  scr := case when total > 0 then round(earned * 100.0 / total)::int else 0 end;
  passed := scr >= coalesce(q.passing_score, 70);
  att_no := prior + 1;

  insert into public.quiz_attempts (quiz_id, course_id, user_id, answers, score, earned, total, passed, attempt_no)
  values (p_quiz_id, q.course_id, me, coalesce(p_answers, '{}'::jsonb), scr, earned, total, passed, att_no)
  returning id into att_id;

  -- XP: first passed attempt per quiz earns 20 XP (mirrors client rules)
  if passed and prior = 0 then
    insert into public.xp_events (user_id, rule, xp, ref_table, ref_id)
    values (me, 'quiz_passed', 20, 'quiz_attempts', att_id);
  elsif passed and not exists (
    select 1 from public.quiz_attempts a
    where a.quiz_id = p_quiz_id and a.user_id = me and a.passed = true and a.id != att_id
  ) then
    insert into public.xp_events (user_id, rule, xp, ref_table, ref_id)
    values (me, 'quiz_passed', 20, 'quiz_attempts', att_id);
  end if;

  insert into public.learning_events (user_id, course_id, kind, ref_id)
  values (me, q.course_id, 'quiz_attempt', att_id::text);

  return jsonb_build_object(
    'id', att_id, 'quizId', p_quiz_id, 'courseId', q.course_id,
    'score', scr, 'earned', earned, 'total', total, 'passed', passed,
    'attemptNo', att_no, 'details', details, 'answers', coalesce(p_answers, '{}'::jsonb)
  );
end $$;

-- ============================================================
-- 7. PAYMENT APPROVAL RPCs (atomic: payment + enrollments +
--    notifications + audit + bundle fan-out)
-- ============================================================
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
    'Your payment for ' || target_name || ' has been approved. Your course access is now ACTIVE. WOLI DAN TECH HUB - Learn • Build • Grow',
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
    'Your payment for ' || target_name || ' could not be verified. Reason: ' || p_reason || '. Please contact WOLI DAN TECH HUB if you believe this was an error.',
    pay.course_id);

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (admin_email, admin_email, 'payment.reject', 'manual_payment', p_payment_id::text,
    jsonb_build_object('reason', p_reason, 'userId', pay.user_id));

  return jsonb_build_object('ok', true, 'paymentId', p_payment_id);
end $$;

-- ============================================================
-- 8. CERTIFICATE AUTO-ISSUE (triggered by learning activity)
-- ============================================================
create or replace function public.gen_cert_id()
returns text language sql as $$
  select 'WDTH-' || extract(year from now())::text || '-' ||
    upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
$$;

create or replace function public.gen_verify_code()
returns text language sql as $$
  select 'WDTH-' || upper(substr(md5(random()::text || clock_timestamp()::text || 'a'), 1, 4)) ||
    '-' || upper(substr(md5(random()::text || clock_timestamp()::text || 'b'), 1, 4));
$$;

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
    -- only approval transitions can complete a course
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

  -- All requirements met → issue certificate + completion XP + notify
  insert into public.certificate_issues
    (certificate_id, verification_code, user_id, student_name, course_id, course_name, status, issued_by)
  select public.gen_cert_id(), public.gen_verify_code(), uid, p.full_name, cid, c.title, 'valid', 'WOLI DAN TECH HUB'
  from public.profiles p, public.courses c where p.id = uid and c.id = cid;

  insert into public.xp_events (user_id, rule, xp, ref_table, ref_id)
  values (uid, 'course_complete', 100, 'courses', cid);

  insert into public.student_notifications (user_id, type, title, message, course_id)
  values (uid, 'course_completed', 'Course Completed! 🎓',
    'Congratulations! You completed the course. Your certificate is ready in My Certificates.',
    cid);

  return new;
exception when unique_violation then
  -- concurrent completion race: certificate already issued
  return new;
end $$;

drop trigger if exists trg_cert_on_progress on public.lesson_progress;
create trigger trg_cert_on_progress after insert on public.lesson_progress
  for each row execute function public.maybe_issue_certificate();
drop trigger if exists trg_cert_on_attempt on public.quiz_attempts;
create trigger trg_cert_on_attempt after insert on public.quiz_attempts
  for each row execute function public.maybe_issue_certificate();
drop trigger if exists trg_cert_on_submission on public.assignment_submissions;
create trigger trg_cert_on_submission after insert or update on public.assignment_submissions
  for each row execute function public.maybe_issue_certificate();

-- Manual issue (admin) — idempotent
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
  select public.gen_cert_id(), public.gen_verify_code(), p_user_id, p.full_name, p_course_id, c.title, 'valid', admin_email
  from public.profiles p, public.courses c where p.id = p_user_id and c.id = p_course_id
  returning id, certificate_id into new_id, new_cert_id;

  insert into public.student_notifications (user_id, type, title, message, course_id)
  values (p_user_id, 'course_completed', 'Congratulations! 🎓',
    'Congratulations! 🎓 Your WOLI DAN TECH HUB certificate is now available.', p_course_id);

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (admin_email, admin_email, 'certificate.issue_manual', 'certificate', new_id::text,
    jsonb_build_object('userId', p_user_id, 'courseId', p_course_id));

  return jsonb_build_object('id', new_id, 'certificateId', new_cert_id, 'existing', false);
end $$;

create or replace function public.revoke_certificate(p_cert_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare admin_email text; n int;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select email into admin_email from public.profiles where id = auth.uid();
  update public.certificate_issues
  set status = 'revoked', revoked_at = now()
  where (id::text = p_cert_id or certificate_id = p_cert_id) and status != 'revoked';
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
    values (admin_email, admin_email, 'certificate.revoke', 'certificate', p_cert_id, '{}');
  end if;
  return jsonb_build_object('ok', true, 'revoked', n);
end $$;

-- ============================================================
-- 9. XP LEDGER TRIGGERS (rules mirror the client XP table:
--    lesson 10 • quiz pass 20 • assignment approved 30 •
--    course complete 100 • review 5)
-- ============================================================
create or replace function public.award_lesson_xp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.xp_events (user_id, rule, xp, ref_table, ref_id)
  values (new.user_id, 'lesson_complete', 10, 'lesson_progress', new.lesson_id);
  return new;
end $$;
drop trigger if exists trg_xp_lesson on public.lesson_progress;
create trigger trg_xp_lesson after insert on public.lesson_progress
  for each row execute function public.award_lesson_xp();

create or replace function public.award_submission_xp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and (TG_OP = 'INSERT' or old.status is distinct from 'approved') then
    insert into public.xp_events (user_id, rule, xp, ref_table, ref_id)
    values (new.user_id, 'assignment_approved', 30, 'assignment_submissions', new.id);
  end if;
  return new;
end $$;
drop trigger if exists trg_xp_submission on public.assignment_submissions;
create trigger trg_xp_submission after insert or update on public.assignment_submissions
  for each row execute function public.award_submission_xp();

create or replace function public.award_review_xp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.xp_events (user_id, rule, xp, ref_table, ref_id)
  values (new.user_id, 'review', 5, 'reviews', new.id);
  return new;
end $$;
drop trigger if exists trg_xp_review on public.reviews;
create trigger trg_xp_review after insert on public.reviews
  for each row execute function public.award_review_xp();

-- ============================================================
-- 10. PUBLIC RPCs: portfolio, leaderboard, showcase
-- ============================================================

-- Public student portfolio (only when portfolio_public = true)
create or replace function public.get_public_portfolio(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select * into p from public.profiles where id = p_user_id and role = 'student';
  if not found then return jsonb_build_object('found', false); end if;
  if coalesce(p.portfolio_public, true) = false then return jsonb_build_object('found', true, 'private', true); end if;
  return jsonb_build_object(
    'found', true, 'private', false,
    'profile', jsonb_build_object(
      'id', p.id, 'fullName', p.full_name, 'avatar', p.avatar_url, 'bio', p.bio,
      'skills', coalesce(p.skills, '{}'), 'showCertificates', coalesce(p.show_certificates, true),
      'showProjects', coalesce(p.show_projects, true), 'memberSince', p.created_at
    ),
    'stats', jsonb_build_object(
      'courses', (select count(distinct lp.course_id) from public.lesson_progress lp
                  join public.course_lessons cl on cl.id = lp.lesson_id
                  where lp.user_id = p.id),
      'certificates', (select count(*) from public.certificate_issues c
                       where c.user_id = p.id and c.status = 'valid'),
      'projects', (select count(*) from public.assignment_submissions s
                   where s.user_id = p.id and s.status = 'approved'),
      'xp', (select coalesce(sum(xp), 0) from public.xp_events x where x.user_id = p.id)
    ),
    'certificates', case when coalesce(p.show_certificates, true) then coalesce((
      select jsonb_agg(jsonb_build_object(
        'certificateId', certificate_id, 'courseName', course_name, 'issueDate', issue_date
      ) order by issue_date desc)
      from public.certificate_issues where user_id = p.id and status = 'valid'
    ), '[]'::jsonb) else '[]'::jsonb end,
    'projects', case when coalesce(p.show_projects, true) then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'fileName', s.file_name, 'fileType', s.file_type,
        'storagePath', s.storage_path, 'kind', s.kind, 'linkUrl', s.link_url,
        'score', s.score, 'feedback', s.feedback,
        'assignmentTitle', a.title, 'courseName', c.title
      ) order by s.submitted_at desc)
      from public.assignment_submissions s
      join public.assignments a on a.id = s.assignment_id
      join public.courses c on c.id = s.course_id
      where s.user_id = p.id and s.status = 'approved'
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end $$;

-- Leaderboard (any authenticated user; names + XP only)
create or replace function public.get_leaderboard(p_limit int default 20)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'userId', p.id, 'name', p.full_name, 'xp', coalesce(s.total, 0),
      'level', floor(coalesce(s.total, 0) / 200) + 1
    ) order by coalesce(s.total, 0) desc)
    from public.profiles p
    left join (select user_id, sum(xp) as total from public.xp_events group by user_id) s on s.user_id = p.id
    where p.role = 'student' and coalesce(p.banned, false) = false
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  ), '[]'::jsonb);
end $$;

-- Project showcase (public; images resolved via signed URLs client-side)
create or replace function public.get_showcase(p_limit int default 12)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'fileName', s.file_name, 'fileType', s.file_type,
      'storagePath', s.storage_path, 'score', s.score,
      'ownerName', p.full_name, 'ownerId', p.id,
      'assignmentTitle', a.title, 'courseName', c.title
    ) order by s.submitted_at desc)
    from public.assignment_submissions s
    join public.assignments a on a.id = s.assignment_id
    join public.courses c on c.id = s.course_id
    join public.profiles p on p.id = s.user_id
    where s.status = 'approved' and s.kind = 'file'
      and s.file_type like 'image/%'
      and coalesce(p.portfolio_public, true) = true
    limit greatest(1, least(coalesce(p_limit, 12), 50))
  ), '[]'::jsonb);
end $$;

-- ============================================================
-- 11. ADMIN RPCs: stats + student detail
-- ============================================================
create or replace function public.get_admin_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  students int; new7 int; active7 int;
  enrolls int; pay_ok int; pay_pend int; pay_rej int; revenue bigint;
  certs int; attempts int; passed_att int; subs int; subs_ok int; subs_pend int;
  reds int; completions int;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select count(*) into students from public.profiles where role = 'student';
  select count(*) into new7 from public.profiles where role = 'student' and created_at >= now() - interval '7 days';
  select count(distinct user_id) into active7 from public.learning_events where created_at >= now() - interval '7 days';
  select count(*) into enrolls from public.enrollments;
  select count(*) filter (where status = 'approved'), coalesce(sum(amount) filter (where status = 'approved'), 0),
         count(*) filter (where status = 'pending'), count(*) filter (where status = 'rejected')
    into pay_ok, revenue, pay_pend, pay_rej from public.manual_payments;
  select count(*) into certs from public.certificate_issues where status = 'valid';
  select count(*), count(*) filter (where passed) into attempts, passed_att from public.quiz_attempts;
  select count(*), count(*) filter (where status = 'approved'),
         count(*) filter (where status in ('submitted','under_review'))
    into subs, subs_ok, subs_pend from public.assignment_submissions;
  select count(*) into reds from public.coupon_redemptions;
  select count(*) into completions from (
    select lp.user_id, lp.course_id
    from public.lesson_progress lp
    group by lp.user_id, lp.course_id
    having count(*) >= (select count(*) from public.course_lessons cl where cl.course_id = lp.course_id)
       and (select count(*) from public.course_lessons cl where cl.course_id = lp.course_id) > 0
  ) t;
  return jsonb_build_object(
    'totalStudents', students, 'newStudents7d', new7, 'activeStudents7d', active7,
    'totalEnrollments', enrolls,
    'approvedPayments', pay_ok, 'pendingPayments', pay_pend, 'rejectedPayments', pay_rej,
    'revenue', revenue, 'certificatesIssued', certs,
    'quizAttempts', attempts,
    'quizPassRate', case when attempts > 0 then round(passed_att * 100.0 / attempts) else 0 end,
    'submissions', subs, 'approvedSubmissions', subs_ok, 'pendingReviews', subs_pend,
    'couponRedemptions', reds, 'completedCourses', completions
  );
end $$;

create or replace function public.get_student_detail(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select * into p from public.profiles where id = p_user_id;
  if not found then raise exception 'Student not found'; end if;
  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', p.id, 'fullName', p.full_name, 'email', p.email, 'phone', p.phone,
      'role', p.role, 'avatar', p.avatar_url, 'bio', p.bio, 'skills', coalesce(p.skills, '{}'),
      'interests', coalesce(p.interests, '{}'), 'skillLevel', p.skill_level,
      'careerGoals', coalesce(p.career_goals, '{}'), 'onboarded', p.onboarded,
      'banned', p.banned, 'lastLoginAt', p.last_login_at, 'createdAt', p.created_at,
      'portfolioPublic', p.portfolio_public
    ),
    'enrollments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'courseId', e.course_id, 'courseTitle', c.title, 'courseSlug', c.slug,
        'status', e.status, 'method', e.method, 'enrolledAt', e.enrolled_at,
        'totalLessons', (select count(*) from public.course_lessons where course_id = e.course_id),
        'doneLessons', (select count(*) from public.lesson_progress where user_id = p_user_id and course_id = e.course_id),
        'quizAvg', (select case when count(*) > 0 then round(avg(best)) else null end
                    from (select max(score) as best from public.quiz_attempts
                          where user_id = p_user_id and course_id = e.course_id group by quiz_id) t)
      ) order by e.enrolled_at desc)
      from public.enrollments e join public.courses c on c.id = e.course_id
      where e.user_id = p_user_id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'courseId', m.course_id,
        'courseName', coalesce((select title from public.courses where id = m.course_id),
                               (select 'Bundle: ' || title from public.bundles where id = m.bundle_id)),
        'amount', m.amount, 'reference', m.reference, 'status', m.status,
        'receiptPath', m.receipt_path, 'submittedAt', m.submitted_at,
        'couponCode', m.coupon_code
      ) order by m.submitted_at desc)
      from public.manual_payments m where m.user_id = p_user_id
    ), '[]'::jsonb),
    'certificates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'certificateId', certificate_id, 'courseName', course_name,
        'status', status, 'issueDate', issue_date
      ) order by issue_date desc)
      from public.certificate_issues where user_id = p_user_id
    ), '[]'::jsonb),
    'submissions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'assignmentId', s.assignment_id, 'assignmentTitle', a.title,
        'kind', s.kind, 'fileName', s.file_name, 'status', s.status,
        'score', s.score, 'submittedAt', s.submitted_at
      ) order by s.submitted_at desc)
      from public.assignment_submissions s join public.assignments a on a.id = s.assignment_id
      where s.user_id = p_user_id
    ), '[]'::jsonb)
  );
end $$;

-- ============================================================
-- 12. INDEXES
-- ============================================================
create index if not exists idx_mp_status on public.manual_payments(status);
create index if not exists idx_mp_course on public.manual_payments(course_id);
create index if not exists idx_lp_course on public.lesson_progress(course_id);
create index if not exists idx_attempts_course on public.quiz_attempts(course_id);
create index if not exists idx_sub_assignment on public.assignment_submissions(assignment_id);
create index if not exists idx_sub_status on public.assignment_submissions(status);
create index if not exists idx_notif_user_read on public.student_notifications(user_id, read);
create index if not exists idx_events_course_kind on public.learning_events(course_id, kind);
create index if not exists idx_reviews_course on public.reviews(course_id);
create index if not exists idx_posts_course on public.discussion_posts(course_id);
create index if not exists idx_comments_post on public.discussion_comments(post_id);
create index if not exists idx_xp_user on public.xp_events(user_id);
create index if not exists idx_live_course on public.live_classes(course_id);

-- ============================================================
-- 14. REVIEW RATING SYNC (courses.rating = avg of published reviews)
-- ============================================================
create or replace function public.sync_course_rating()
returns trigger language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if TG_OP = 'DELETE' then cid := old.course_id; else cid := new.course_id; end if;
  update public.courses set rating = coalesce((
    select round(avg(rating), 1) from public.reviews
    where course_id = cid and status = 'published'
  ), 5.0) where id = cid;
  if TG_OP = 'DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists trg_sync_rating on public.reviews;
create trigger trg_sync_rating after insert or update or delete on public.reviews
  for each row execute function public.sync_course_rating();

-- ============================================================
-- 15. REALTIME (guarded: only on real Supabase, skipped in
--     bare Postgres / verification harnesses)
-- ============================================================
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not found — skipping (run the ALTER PUBLICATION block on Supabase)';
    return;
  end if;
  foreach t slice 0 in array array[
    'public.manual_payments', 'public.student_notifications',
    'public.assignment_submissions', 'public.announcements',
    'public.enrollments', 'public.certificate_issues',
    'public.discussion_posts', 'public.discussion_comments'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table %s', t);
    exception when duplicate_object then
      raise notice 'table % already in publication — skipping', t;
    end;
  end loop;
end $$;
