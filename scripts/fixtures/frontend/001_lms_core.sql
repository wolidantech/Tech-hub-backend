-- ============================================================
-- WOLI DAN TECH HUB LMS — Supabase core schema + RLS
-- Run: supabase db push  (or paste into Supabase SQL editor)
-- ============================================================

-- ---------- Profiles (extends auth.users) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text,
  role text not null default 'student' check (role in ('student','admin','instructor')),
  avatar_url text,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;

-- ---------- Helpers ----------
-- NOTE: admin status comes ONLY from profiles.role (never from the JWT:
-- user_metadata is self-editable via auth.updateUser and must not confer privilege).
-- NOTE: language-sql bodies are validated at CREATE time, so is_admin() must
-- be defined AFTER the profiles table it reads.
create or replace function public.is_admin()
returns boolean language sql stable as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;
create policy "users read own profile" on public.profiles for select using (auth.uid() = id or public.is_admin());
create policy "users update own profile" on public.profiles for update using (auth.uid() = id);
create policy "admin full profiles" on public.profiles for all using (public.is_admin());

-- ---------- Categories ----------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  sort_order int default 0,
  created_at timestamptz default now()
);
alter table public.categories enable row level security;
create policy "categories public read" on public.categories for select using (true);
create policy "admin write categories" on public.categories for all using (public.is_admin());

-- ---------- Courses ----------
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  short_description text,
  description text,
  long_description text,
  category text not null default 'General',
  instructor text default 'Woli Dan',
  instructor_role text,
  duration text,
  lessons_count int default 0,
  level text default 'Beginner',
  price int not null default 5000 check (price >= 0),
  original_price int default 10000,
  rating numeric default 5.0,
  students_count int default 0,
  thumbnail_key text default 'default',
  thumbnail_url text,
  art_theme text,
  color text,
  what_you_will_learn jsonb default '[]',
  published boolean default false,
  featured boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_courses_slug on public.courses(slug);
create index if not exists idx_courses_published on public.courses(published);
alter table public.courses enable row level security;
create policy "published courses public" on public.courses for select using (published = true or public.is_admin());
create policy "admin write courses" on public.courses for insert with check (public.is_admin());
create policy "admin update courses" on public.courses for update using (public.is_admin());
create policy "admin delete courses" on public.courses for delete using (public.is_admin());

-- ---------- Enrollments (table created early: curriculum policies reference it) ----------
create table if not exists public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  status text default 'active' check (status in ('active','removed','completed')),
  method text,
  coupon_code text,
  enrolled_at timestamptz default now(),
  unique (user_id, course_id)
);
create index if not exists idx_enroll_user on public.enrollments(user_id);

-- ---------- Course content: modules & lessons ----------
create table if not exists public.course_modules (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  position int default 0,
  created_at timestamptz default now()
);
create index if not exists idx_modules_course on public.course_modules(course_id);

create table if not exists public.course_lessons (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.course_modules(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  type text default 'video' check (type in ('video','text')),
  duration text,
  position int default 0,
  created_at timestamptz default now()
);
create index if not exists idx_lessons_module on public.course_lessons(module_id);

create table if not exists public.course_content (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid unique not null references public.course_lessons(id) on delete cascade,
  body_markdown text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.course_videos (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.course_lessons(id) on delete cascade,
  provider text default 'youtube' check (provider in ('youtube','upload','ai_generated','external')),
  url text,
  storage_path text,
  duration_seconds int,
  subtitles_path text,
  status text default 'published' check (status in ('draft','processing','published')),
  created_at timestamptz default now()
);

alter table public.course_modules enable row level security;
alter table public.course_lessons enable row level security;
alter table public.course_content enable row level security;
alter table public.course_videos enable row level security;

-- Students enrolled in the course (or course published => curriculum titles only) can read;
-- full lesson bodies restricted to enrolled students + admin.
create policy "modules readable" on public.course_modules for select using (
  public.is_admin() or exists (
    select 1 from public.courses c where c.id = course_id and c.published = true
  ) or exists (
    select 1 from public.enrollments e where e.course_id = course_modules.course_id and e.user_id = auth.uid() and e.status = 'active'
  )
);
create policy "lessons readable" on public.course_lessons for select using (
  public.is_admin() or exists (
    select 1 from public.courses c where c.id = course_id and c.published = true
  ) or exists (
    select 1 from public.enrollments e where e.course_id = course_lessons.course_id and e.user_id = auth.uid() and e.status = 'active'
  )
);
create policy "content enrolled only" on public.course_content for select using (
  public.is_admin() or exists (
    select 1 from public.course_lessons l
    join public.enrollments e on e.course_id = l.course_id
    where l.id = lesson_id and e.user_id = auth.uid() and e.status = 'active'
  )
);
create policy "videos enrolled only" on public.course_videos for select using (
  public.is_admin() or exists (
    select 1 from public.course_lessons l
    join public.enrollments e on e.course_id = l.course_id
    where l.id = lesson_id and e.user_id = auth.uid() and e.status = 'active'
  )
);
create policy "admin write modules" on public.course_modules for all using (public.is_admin());
create policy "admin write lessons" on public.course_lessons for all using (public.is_admin());
create policy "admin write content" on public.course_content for all using (public.is_admin());
create policy "admin write videos" on public.course_videos for all using (public.is_admin());

-- ---------- Enrollments (table created above, ahead of curriculum policies) ----------
alter table public.enrollments enable row level security;
create policy "own enrollments" on public.enrollments for select using (auth.uid() = user_id or public.is_admin());
create policy "admin write enrollments" on public.enrollments for all using (public.is_admin());

-- ---------- Manual payments ----------
create table if not exists public.manual_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  student_name text, email text, phone text,
  amount int not null check (amount >= 0),
  original_amount int,
  coupon_code text, coupon_discount int default 0,
  transaction_date date, reference text,
  receipt_path text,
  status text default 'pending' check (status in ('pending','approved','rejected')),
  approved_by text, approved_at timestamptz,
  rejected_reason text, rejected_by text, rejected_at timestamptz,
  submitted_at timestamptz default now()
);
create index if not exists idx_mp_user on public.manual_payments(user_id);
alter table public.manual_payments enable row level security;
create policy "own payments" on public.manual_payments for select using (auth.uid() = user_id or public.is_admin());
create policy "students submit payments" on public.manual_payments for insert with check (auth.uid() = user_id);
create policy "admin update payments" on public.manual_payments for update using (public.is_admin());

-- ---------- Progress ----------
create table if not exists public.lesson_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  lesson_id uuid not null references public.course_lessons(id) on delete cascade,
  completed_at timestamptz default now(),
  primary key (user_id, lesson_id)
);
alter table public.lesson_progress enable row level security;
create policy "own progress" on public.lesson_progress for all using (auth.uid() = user_id or public.is_admin());

-- ---------- Quizzes ----------
create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  module_id uuid references public.course_modules(id) on delete set null,
  lesson_id uuid references public.course_lessons(id) on delete set null,
  title text not null, description text,
  passing_score int default 70,
  allow_retake boolean default true,
  is_final boolean default false,
  status text default 'published' check (status in ('draft','published','archived')),
  created_at timestamptz default now()
);
create table if not exists public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  type text default 'multiple_choice' check (type in ('multiple_choice','true_false','multiple_answer')),
  question text not null,
  options jsonb default '[]',
  correct_answer int,
  correct_answers jsonb default '[]',
  explanation text,
  created_at timestamptz default now()
);
-- NOTE: correct answers must be hidden from students at the API layer.
-- Serve questions through a SECURITY DEFINER function that strips answers.
create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  answers jsonb default '{}',
  score int, earned int, total int,
  passed boolean,
  attempt_no int default 1,
  created_at timestamptz default now()
);
create index if not exists idx_attempts_user_quiz on public.quiz_attempts(user_id, quiz_id);
alter table public.quizzes enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_attempts enable row level security;
create policy "quizzes enrolled read" on public.quizzes for select using (
  public.is_admin() or (status = 'published' and exists (
    select 1 from public.enrollments e where e.course_id = quizzes.course_id and e.user_id = auth.uid() and e.status = 'active'))
);
create policy "questions enrolled read" on public.quiz_questions for select using (
  public.is_admin() or exists (
    select 1 from public.quizzes q join public.enrollments e on e.course_id = q.course_id
    where q.id = quiz_id and q.status = 'published' and e.user_id = auth.uid() and e.status = 'active')
);
create policy "own attempts" on public.quiz_attempts for select using (auth.uid() = user_id or public.is_admin());
create policy "students attempt" on public.quiz_attempts for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.enrollments e join public.quizzes q on q.course_id = e.course_id
    where e.user_id = auth.uid() and e.status = 'active' and q.id = quiz_id and q.status = 'published')
);
create policy "admin write quizzes" on public.quizzes for all using (public.is_admin());
create policy "admin write questions" on public.quiz_questions for all using (public.is_admin());
create policy "admin write attempts" on public.quiz_attempts for all using (public.is_admin());

-- ---------- Assignments ----------
create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  module_id uuid references public.course_modules(id) on delete set null,
  lesson_id uuid references public.course_lessons(id) on delete set null,
  title text not null, description text, instructions text, required_output text,
  max_score int default 100,
  is_final_project boolean default false,
  status text default 'published' check (status in ('draft','published','archived')),
  created_at timestamptz default now()
);
create table if not exists public.assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text,
  file_name text, file_type text, file_size int,
  note text,
  status text default 'submitted' check (status in ('submitted','under_review','approved','needs_revision')),
  score int, feedback text,
  reviewed_by text, reviewed_at timestamptz,
  submitted_at timestamptz default now()
);
create index if not exists idx_sub_user on public.assignment_submissions(user_id);
alter table public.assignments enable row level security;
alter table public.assignment_submissions enable row level security;
create policy "assignments enrolled read" on public.assignments for select using (
  public.is_admin() or (status = 'published' and exists (
    select 1 from public.enrollments e where e.course_id = assignments.course_id and e.user_id = auth.uid() and e.status = 'active'))
);
create policy "own submissions" on public.assignment_submissions for select using (auth.uid() = user_id or public.is_admin());
create policy "students submit" on public.assignment_submissions for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.enrollments e join public.assignments a on a.course_id = e.course_id
    where e.user_id = auth.uid() and e.status = 'active' and a.id = assignment_id and a.status = 'published')
);
create policy "admin write assignments" on public.assignments for all using (public.is_admin());
create policy "admin review submissions" on public.assignment_submissions for update using (public.is_admin());

-- ---------- Coupons ----------
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  course_id uuid references public.courses(id) on delete cascade, -- null = ALL courses
  discount_type text not null check (discount_type in ('percentage','fixed','free')),
  discount_value int not null default 0,
  max_uses int, -- null = unlimited
  used_count int default 0,
  expires_at timestamptz,
  min_purchase int default 0,
  active boolean default true,
  restricted_email text,
  restricted_phone text,
  restricted_user_id uuid references public.profiles(id),
  created_by text,
  created_at timestamptz default now()
);
create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  coupon_code text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  discount int not null, amount_due int not null,
  used_at timestamptz default now()
);
create index if not exists idx_redem_coupon on public.coupon_redemptions(coupon_id);
alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;
-- Students must NOT list coupons; validation happens via SECURITY DEFINER RPC.
create policy "admin all coupons" on public.coupons for all using (public.is_admin());
create policy "admin read redemptions" on public.coupon_redemptions for select using (auth.uid() = user_id or public.is_admin());

-- Atomic server-side coupon validation + redemption (prevents race/overuse)
create or replace function public.redeem_coupon(p_code text, p_course_id uuid)
returns jsonb language plpgsql security definer as $$
declare
  c public.coupons%rowtype;
  course_price int;
  uses int;
  discount int;
  due int;
  me uuid := auth.uid();
  my_email text; my_phone text;
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
  if c.restricted_phone is not null and right(regexp_replace(c.restricted_phone, '\D', '', 'g'), 10) != right(regexp_replace(coalesce(my_phone,''), '\D', '', 'g'), 10) then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  select price into course_price from public.courses where id = p_course_id;
  if course_price is null then return jsonb_build_object('valid', false, 'reason', 'Course not found'); end if;
  if c.min_purchase > 0 and course_price < c.min_purchase then return jsonb_build_object('valid', false, 'reason', 'Minimum purchase not met'); end if;
  if c.discount_type = 'free' or (c.discount_type = 'percentage' and c.discount_value >= 100) then discount := course_price;
  elsif c.discount_type = 'percentage' then discount := round(course_price * c.discount_value / 100.0);
  else discount := least(c.discount_value, course_price); end if;
  due := greatest(0, course_price - discount);
  -- Resubmission-safe: an identical redemption returns the same math without a duplicate row.
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
  end if;
  return jsonb_build_object('valid', true, 'discount', discount, 'amountDue', due, 'isFree', due = 0);
end $$;

-- ---------- AI generation ----------
create table if not exists public.ai_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  input jsonb default '{}',
  status text default 'running' check (status in ('running','completed','failed')),
  provider text,
  error text,
  created_by text,
  created_at timestamptz default now()
);
create table if not exists public.ai_generated_content (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.ai_generation_jobs(id) on delete set null,
  kind text not null,
  title text,
  input jsonb default '{}',
  data jsonb default '{}',
  provider text,
  status text default 'draft' check (status in ('draft','in_review','approved','published','archived')),
  target_course_id uuid references public.courses(id) on delete set null,
  created_by text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.ai_generation_jobs enable row level security;
alter table public.ai_generated_content enable row level security;
create policy "admin ai jobs" on public.ai_generation_jobs for all using (public.is_admin());
create policy "admin ai content" on public.ai_generated_content for all using (public.is_admin());

-- ---------- Completion rules ----------
create table if not exists public.course_completion_rules (
  course_id uuid primary key references public.courses(id) on delete cascade,
  require_lessons_pct int default 100,
  require_quiz_avg int default 0,
  require_assignments_approved int default 0,
  require_final_project boolean default false,
  updated_at timestamptz default now()
);
alter table public.course_completion_rules enable row level security;
create policy "rules readable" on public.course_completion_rules for select using (true);
create policy "admin write rules" on public.course_completion_rules for all using (public.is_admin());

-- ---------- Certificates ----------
create table if not exists public.certificate_templates (
  id uuid primary key default gen_random_uuid(),
  name text default 'Default',
  config jsonb default '{}',
  created_at timestamptz default now()
);
create table if not exists public.certificate_issues (
  id uuid primary key default gen_random_uuid(),
  certificate_id text unique not null,
  verification_code text unique not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  student_name text,
  course_id uuid not null references public.courses(id) on delete cascade,
  course_name text,
  status text default 'valid' check (status in ('valid','revoked')),
  issued_by text,
  issue_date timestamptz default now(),
  revoked_at timestamptz
);
create index if not exists idx_cert_user on public.certificate_issues(user_id);
alter table public.certificate_templates enable row level security;
alter table public.certificate_issues enable row level security;
create policy "own certs" on public.certificate_issues for select using (auth.uid() = user_id or public.is_admin());
create policy "admin issue certs" on public.certificate_issues for all using (public.is_admin());
create policy "admin cert templates" on public.certificate_templates for all using (public.is_admin());
-- Public verification RPC (limited fields, masked name, explicit status)
create or replace function public.verify_certificate(p_code text)
returns jsonb language plpgsql security definer as $$
declare r record;
begin
  select certificate_id, verification_code, student_name, course_name, issue_date, status
  into r from public.certificate_issues
  where certificate_id = trim(p_code) or verification_code = trim(p_code);
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'status', r.status,
    'studentName', upper(substr(trim(coalesce(r.student_name, '?')), 1, 1)) || '***',
    'courseName', r.course_name, 'issueDate', r.issue_date,
    'certificateId', r.certificate_id,
    'issuedBy', 'WOLI DAN TECH HUB');
end $$;

-- ---------- Notifications ----------
create table if not exists public.student_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text default 'announcement',
  title text not null,
  message text not null,
  course_id uuid references public.courses(id) on delete set null,
  read boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_notif_user on public.student_notifications(user_id);
alter table public.student_notifications enable row level security;
create policy "own notifications" on public.student_notifications for select using (auth.uid() = user_id or public.is_admin());
create policy "own notif update" on public.student_notifications for update using (auth.uid() = user_id);
create policy "admin send notifications" on public.student_notifications for insert with check (public.is_admin());

-- ---------- Audit logs (append-only) ----------
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_email text, actor_name text,
  action text not null,
  entity_type text, entity_id text,
  details jsonb default '{}',
  created_at timestamptz default now()
);
create index if not exists idx_audit_action on public.audit_logs(action);
alter table public.audit_logs enable row level security;
create policy "admin read audit" on public.audit_logs for select using (public.is_admin());
create policy "admin write audit" on public.audit_logs for insert with check (public.is_admin());

-- ---------- Analytics events ----------
create table if not exists public.learning_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  course_id uuid references public.courses(id) on delete set null,
  kind text not null,
  ref_id text,
  created_at timestamptz default now()
);
create index if not exists idx_events_user on public.learning_events(user_id);
alter table public.learning_events enable row level security;
create policy "own events write" on public.learning_events for insert with check (auth.uid() = user_id);
create policy "own events read" on public.learning_events for select using (auth.uid() = user_id or public.is_admin());

-- ---------- Private storage buckets ----------
-- NOTE: storage.buckets uses the `public` flag (true = publicly readable).
insert into storage.buckets (id, name, public) values
  ('receipts', 'receipts', false),
  ('submissions', 'submissions', false),
  ('thumbnails', 'thumbnails', true),
  ('lesson-videos', 'lesson-videos', false)
on conflict (id) do update set public = excluded.public;

-- Receipts: owner + admin only (use signed URLs for viewing)
create policy "receipts owner read" on storage.objects for select using (bucket_id = 'receipts' and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin()));
create policy "receipts owner write" on storage.objects for insert with check (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "submissions owner read" on storage.objects for select using (bucket_id = 'submissions' and (auth.uid()::text = (storage.foldername(name))[1] or public.is_admin()));
create policy "submissions owner write" on storage.objects for insert with check (bucket_id = 'submissions' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "thumbnails public read" on storage.objects for select using (bucket_id = 'thumbnails');
create policy "thumbnails admin write" on storage.objects for insert with check (bucket_id = 'thumbnails' and public.is_admin());
create policy "videos enrolled read" on storage.objects for select using (bucket_id = 'lesson-videos' and public.is_admin());
