-- ============================================================
-- 008 — CV BUILDER + STUDY TOOLS
-- ------------------------------------------------------------
-- cv_documents:    saved CVs for registered users (guests can
--                  build & download without an account; cloud
--                  saving is opt-in after registration).
-- study_notes:     personal notes per course/lesson.
-- study_bookmarks: bookmarked lessons/resources.
-- All three: own-rows RLS. Idempotent.
-- ============================================================

create table if not exists public.cv_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'My CV',
  template text not null default 'modern',
  data jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_cv_user on public.cv_documents(user_id);

create table if not exists public.study_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid references public.courses(id) on delete cascade,
  lesson_id uuid references public.course_lessons(id) on delete set null,
  title text not null default 'Note',
  body text not null default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_notes_user on public.study_notes(user_id, course_id);

create table if not exists public.study_bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  lesson_id uuid references public.course_lessons(id) on delete cascade,
  note text default '',
  created_at timestamptz default now(),
  unique (user_id, lesson_id)
);

alter table public.cv_documents enable row level security;
alter table public.study_notes enable row level security;
alter table public.study_bookmarks enable row level security;

drop policy if exists "own cvs" on public.cv_documents;
create policy "own cvs" on public.cv_documents
  for all using (auth.uid() = user_id or public.is_admin())
  with check (auth.uid() = user_id or public.is_admin());

drop policy if exists "own notes" on public.study_notes;
create policy "own notes" on public.study_notes
  for all using (auth.uid() = user_id or public.is_admin())
  with check (auth.uid() = user_id or public.is_admin());

drop policy if exists "own bookmarks" on public.study_bookmarks;
create policy "own bookmarks" on public.study_bookmarks
  for all using (auth.uid() = user_id or public.is_admin())
  with check (auth.uid() = user_id or public.is_admin());

drop trigger if exists trg_cv_touch on public.cv_documents;
create trigger trg_cv_touch before update on public.cv_documents
  for each row execute function public.touch_updated_at();
drop trigger if exists trg_notes_touch on public.study_notes;
create trigger trg_notes_touch before update on public.study_notes
  for each row execute function public.touch_updated_at();
