-- ============================================================
-- 007 — CLASSROOM UPGRADE
-- ------------------------------------------------------------
-- 1. Extends lesson types so every lesson can declare what the
--    student will DO there (watch, read, practice, quiz, submit,
--    build, download). Existing 'video'/'text' rows unaffected.
-- 2. Adds lesson_activity: per-student "lesson started / video
--    progress" tracking, deliberately SEPARATE from lesson_progress
--    (which remains the completion-only table the certificate
--    trigger counts). RLS: students own their rows, admins see all.
-- 3. Adds a lesson description column for classroom display.
-- Idempotent: safe to re-run.
-- ============================================================

-- ---------- 1. richer lesson types ----------
alter table public.course_lessons
  drop constraint if exists course_lessons_type_check;
alter table public.course_lessons
  add constraint course_lessons_type_check
  check (type in ('video','text','practical','quiz','assignment','project','resource'));

alter table public.course_lessons
  add column if not exists description text default '';

-- ---------- 2. lesson activity (starts + video progress) ----------
create table if not exists public.lesson_activity (
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  lesson_id uuid not null references public.course_lessons(id) on delete cascade,
  started_at timestamptz default now(),
  video_seconds int default 0,
  video_duration int,
  updated_at timestamptz default now(),
  primary key (user_id, lesson_id)
);
create index if not exists idx_activity_user_course on public.lesson_activity(user_id, course_id);

alter table public.lesson_activity enable row level security;
drop policy if exists "own activity" on public.lesson_activity;
create policy "own activity" on public.lesson_activity
  for all using (auth.uid() = user_id or public.is_admin())
  with check (auth.uid() = user_id or public.is_admin());

-- Keep updated_at fresh on upserts.
drop trigger if exists trg_activity_touch on public.lesson_activity;
create trigger trg_activity_touch before update on public.lesson_activity
  for each row execute function public.touch_updated_at();

-- ---------- 3. realtime (students resume across devices) ----------
-- Guarded: the publication exists on Supabase but not in test harnesses.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lesson_activity'
     ) then
    alter publication supabase_realtime add table public.lesson_activity;
  end if;
end $$;
