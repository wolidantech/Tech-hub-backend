-- ============================================================
-- WOLI DAN TECH HUB LMS — Phase 2 schema (community, paths, bundles,
-- reviews, live classes, AI, gamification, settings)
-- Run after 001_lms_core.sql
-- ============================================================

-- ---------- Profiles: onboarding / portfolio / ban ----------
alter table public.profiles add column if not exists bio text default '';
alter table public.profiles add column if not exists skills text[] default '{}';
alter table public.profiles add column if not exists interests text[] default '{}';
alter table public.profiles add column if not exists skill_level text;
alter table public.profiles add column if not exists career_goals text[] default '{}';
alter table public.profiles add column if not exists onboarded boolean default false;
alter table public.profiles add column if not exists banned boolean default false;
alter table public.profiles add column if not exists last_login_at timestamptz;
alter table public.profiles add column if not exists portfolio_public boolean default true;
alter table public.profiles add column if not exists show_certificates boolean default true;
alter table public.profiles add column if not exists show_projects boolean default true;

-- ---------- Courses: requirements / audience / archive ----------
alter table public.courses add column if not exists requirements text[] default '{}';
alter table public.courses add column if not exists audience text[] default '{}';
alter table public.courses add column if not exists archived boolean default false;

-- ---------- Lessons: sub-lessons ----------
alter table public.course_lessons add column if not exists sub_lessons jsonb default '[]';

-- ---------- Quizzes: attempt limit / short answer ----------
alter table public.quizzes add column if not exists attempt_limit int; -- null = unlimited
alter table public.quiz_questions add column if not exists accepted_answers text[] default '{}';

-- ---------- Assignments: deadline / submission type ----------
alter table public.assignments add column if not exists deadline timestamptz;
alter table public.assignments add column if not exists submission_type text default 'any'
  check (submission_type in ('file','text','link','any'));

alter table public.assignment_submissions add column if not exists kind text default 'file'
  check (kind in ('file','text','link'));
alter table public.assignment_submissions add column if not exists text_content text default '';
alter table public.assignment_submissions add column if not exists link_url text default '';
alter table public.assignment_submissions add column if not exists late boolean default false;

-- ---------- Learning paths ----------
create table if not exists public.learning_paths (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text default '',
  icon text default '🎯',
  level_range text default 'Beginner → Advanced',
  course_ids uuid[] default '{}',
  is_published boolean default true,
  created_at timestamptz default now()
);
alter table public.learning_paths enable row level security;
create policy "public read paths" on public.learning_paths for select using (is_published or public.is_admin());
create policy "admin full paths" on public.learning_paths for all using (public.is_admin());

-- ---------- Bundles ----------
create table if not exists public.bundles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text default '',
  course_ids uuid[] not null default '{}',
  price numeric not null default 0,
  original_price numeric not null default 0,
  badge text default '',
  is_published boolean default true,
  created_at timestamptz default now()
);
alter table public.bundles enable row level security;
create policy "public read bundles" on public.bundles for select using (is_published or public.is_admin());
create policy "admin full bundles" on public.bundles for all using (public.is_admin());

-- Manual payments: bundle support
alter table public.manual_payments add column if not exists bundle_id uuid references public.bundles(id);
alter table public.manual_payments add column if not exists bundle_course_ids uuid[] default '{}';

-- Enroll all bundle courses when a bundle payment is approved.
-- Call AFTER updating the payment row to approved:
create or replace function public.enroll_bundle_courses(
  p_payment_id uuid, p_user_id uuid, p_course_ids uuid[], p_approved_by text
) returns void language plpgsql security definer as $$
declare c uuid;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  foreach c in array p_course_ids loop
    insert into public.enrollments (user_id, course_id, status, payment_id, approved_by)
    values (p_user_id, c, 'active', p_payment_id, p_approved_by)
    on conflict (user_id, course_id) do update set status = 'active', payment_id = excluded.payment_id;
  end loop;
end $$;

-- ---------- Reviews ----------
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  student_name text not null,
  rating int not null check (rating between 1 and 5),
  body text default '',
  status text default 'published' check (status in ('published','hidden')),
  created_at timestamptz default now(),
  unique (course_id, user_id)
);
alter table public.reviews enable row level security;
create policy "public read reviews" on public.reviews for select using (status = 'published' or public.is_admin());
create policy "enrolled students review" on public.reviews for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.enrollments e
    where e.user_id = auth.uid() and e.course_id = reviews.course_id and e.status <> 'removed'
  )
);
create policy "admin full reviews" on public.reviews for all using (public.is_admin());

-- ---------- Community discussions ----------
create table if not exists public.discussion_posts (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  lesson_id uuid references public.course_lessons(id) on delete set null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  author_name text not null,
  title text not null,
  body text default '',
  pinned boolean default false,
  created_at timestamptz default now()
);
alter table public.discussion_posts enable row level security;
create policy "enrolled read posts" on public.discussion_posts for select using (
  public.is_admin() or exists (
    select 1 from public.enrollments e
    where e.user_id = auth.uid() and e.course_id = discussion_posts.course_id and e.status <> 'removed'
  )
);
create policy "enrolled create posts" on public.discussion_posts for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.enrollments e
    where e.user_id = auth.uid() and e.course_id = discussion_posts.course_id and e.status <> 'removed'
  )
);
create policy "admin full posts" on public.discussion_posts for all using (public.is_admin());

create table if not exists public.discussion_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.discussion_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  author_name text not null,
  body text not null,
  is_admin boolean default false,
  created_at timestamptz default now()
);
alter table public.discussion_comments enable row level security;
create policy "enrolled read comments" on public.discussion_comments for select using (
  public.is_admin() or exists (
    select 1 from public.discussion_posts p
    join public.enrollments e on e.course_id = p.course_id
    where p.id = discussion_comments.post_id and e.user_id = auth.uid() and e.status <> 'removed'
  )
);
create policy "enrolled create comments" on public.discussion_comments for insert with check (auth.uid() = user_id);
create policy "admin full comments" on public.discussion_comments for all using (public.is_admin());

-- ---------- Live classes ----------
create table if not exists public.live_classes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text default '',
  course_id uuid references public.courses(id) on delete set null, -- null = general
  scheduled_at timestamptz not null,
  duration_minutes int default 60,
  platform text default 'Zoom',
  meeting_link text not null,
  recording_url text default '',
  created_at timestamptz default now()
);
alter table public.live_classes enable row level security;
create policy "students read live" on public.live_classes for select using (
  public.is_admin() or course_id is null or exists (
    select 1 from public.enrollments e
    where e.user_id = auth.uid() and e.course_id = live_classes.course_id and e.status <> 'removed'
  )
);
create policy "admin full live" on public.live_classes for all using (public.is_admin());

-- ---------- DanTECH AI conversations ----------
create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text default 'New chat',
  messages jsonb default '[]',
  course_id uuid references public.courses(id) on delete set null,
  lesson_id uuid references public.course_lessons(id) on delete set null,
  updated_at timestamptz default now()
);
alter table public.ai_conversations enable row level security;
create policy "users own convos" on public.ai_conversations for all using (auth.uid() = user_id or public.is_admin());

-- ---------- Gamification: XP ledger ----------
create table if not exists public.xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  rule text not null,           -- e.g. lesson_complete, quiz_passed
  xp int not null,
  ref_table text,
  ref_id uuid,
  created_at timestamptz default now()
);
create index if not exists xp_events_user_idx on public.xp_events (user_id, created_at desc);
alter table public.xp_events enable row level security;
create policy "users read own xp" on public.xp_events for select using (auth.uid() = user_id or public.is_admin());
-- (writes happen server-side via service role only)

-- ---------- Site settings (single row) ----------
create table if not exists public.site_settings (
  id int primary key default 1 check (id = 1),
  site_name text default 'WOLI DAN TECH HUB',
  tagline text default 'Learn • Build • Grow',
  whatsapp text default '08159610509',
  support_email text default 'wolidantech@gmail.com',
  bank_name text default 'MONIEPOINT',
  account_number text default '69852663361',
  account_name text default 'LUNA ENTRY SERVICES- WOLI DAN TECH HUB',
  dantech_enabled boolean default true,
  allow_registration boolean default true,
  socials jsonb default '{}',
  meta_description text default '',
  updated_at timestamptz default now()
);
insert into public.site_settings (id) values (1) on conflict (id) do nothing;
alter table public.site_settings enable row level security;
create policy "public read settings" on public.site_settings for select using (true);
create policy "admin write settings" on public.site_settings for update using (public.is_admin());

-- ---------- Payment/enrollment hardening (backend-enforced rules) ----------
-- 1. Revenue views must only count approved payments:
create or replace view public.v_revenue as
select coalesce(sum(amount), 0) as total_revenue, count(*) as approved_count
from public.manual_payments where status = 'approved';

-- 2. Enrollments may only exist for approved payments (manual), coupon grants, or admin grants.
-- Application rule mirrored in RLS: students cannot insert enrollments directly.
alter table public.enrollments enable row level security;
drop policy if exists "no direct student enrollment" on public.enrollments;
create policy "no direct student enrollment" on public.enrollments for insert
  with check (public.is_admin());  -- service-role gateway inserts on approval events
