-- =====================================================================
-- STEP 0.5 (paste AFTER precheck, BEFORE Step 1): base tables + 014 + bookkeeping.
-- Only needed if the precheck showed MISSING tables.
--   PART A: creates any missing BASE tables (live-DB retrofit, safe no-op otherwise)
--   PART B: migration 014 core (byte-identical to the migration file)
--   PART C: bookkeeping + confirmation
-- Your existing course_lessons table is only READ (backfilled from), never modified.
-- Fully idempotent — safe to run more than once.
-- =====================================================================

-- =====================================================================
-- PART A. ENSURE BASE TABLES (live-DB retrofit)
-- Live production DBs predate the 001-015 migration set and may lack the
-- base tables 014 builds on (lessons, course_resources, lesson_videos,
-- lesson_practicals, lesson_content). Definitions below are VERBATIM
-- extracts from 001/010 (all IF NOT EXISTS / duplicate_object guarded),
-- so this is a safe no-op where the tables already exist.
-- =====================================================================

create extension if not exists pgcrypto;

-- enum public.lesson_type (verbatim from 001)
do $$ begin
  create type public.lesson_type as enum ('VIDEO', 'TEXT', 'PDF', 'RESOURCE');
exception when duplicate_object then null; end $$;

-- enum public.difficulty_level (verbatim from 001)
do $$ begin
  create type public.difficulty_level as enum ('BEGINNER', 'INTERMEDIATE', 'ADVANCED');
exception when duplicate_object then null; end $$;

-- enum public.resource_type (verbatim from 010)
do $$ begin
  create type public.resource_type as enum (
    'VIDEO', 'PDF', 'ARTICLE', 'DOCUMENTATION', 'DATASET',
    'CODE', 'TEMPLATE', 'WEBSITE', 'BOOK', 'EXERCISE'
  );
exception when duplicate_object then null; end $$;

-- enum public.video_job_status (verbatim from 010)
do $$ begin
  create type public.video_job_status as enum ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
exception when duplicate_object then null; end $$;

-- enum public.content_status (verbatim from 010)
do $$ begin
  create type public.content_status as enum ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');
exception when duplicate_object then null; end $$;

-- table public.lessons (verbatim from 001)
create table if not exists public.lessons (
  id           uuid primary key default gen_random_uuid(),
  module_id    uuid not null references public.course_modules (id) on delete cascade,
  title        text not null,
  description  text,
  lesson_type  public.lesson_type not null default 'VIDEO',
  video_url    text,
  content      text,
  resource_url text,
  duration     integer check (duration is null or duration >= 0), -- minutes
  order_number integer not null default 1 check (order_number <> 0),
  is_published boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint uq_lesson_order unique (module_id, order_number)
);
create index if not exists idx_lessons_published on public.lessons (is_published) where is_published = true;

-- table public.course_resources (verbatim from 010)
create table if not exists public.course_resources (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid references public.courses(id) on delete cascade,
  module_id         uuid references public.course_modules(id) on delete cascade,
  lesson_id         uuid,
  title             text not null,
  description       text,
  url               text,
  storage_path      text,
  source            text,
  license           text,
  resource_type     public.resource_type not null default 'ARTICLE',
  is_external       boolean not null default true,
  access_date       date default current_date,
  attribution       text,
  quality_score     numeric(3,2),
  is_approved       boolean not null default false,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint chk_resource_location check (
    (is_external = true and url is not null) or
    (is_external = false and storage_path is not null) or
    (url is not null or storage_path is not null)
  )
);
create index if not exists idx_course_resources_course on public.course_resources (course_id);
create index if not exists idx_course_resources_module on public.course_resources (module_id);
create index if not exists idx_course_resources_lesson on public.course_resources (lesson_id);
create index if not exists idx_course_resources_type on public.course_resources (resource_type);
create index if not exists idx_course_resources_approved on public.course_resources (is_approved) where is_approved = true;

-- table public.lesson_videos (verbatim from 010)
create table if not exists public.lesson_videos (
  id                uuid primary key default gen_random_uuid(),
  lesson_id         uuid not null,
  course_id         uuid references public.courses(id) on delete cascade,
  module_id         uuid references public.course_modules(id) on delete cascade,
  title             text not null,
  script            text,
  video_url         text,
  storage_path      text,
  duration          integer check (duration is null or duration > 0),
  thumbnail_url     text,
  captions_url      text,
  transcript        text,
  status            public.video_job_status not null default 'QUEUED',
  provider          text,
  provider_metadata jsonb default '{}'::jsonb,
  voice             text,
  language          text default 'en',
  teaching_style    text,
  visual_style      text,
  error             text,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_lesson_videos_lesson on public.lesson_videos (lesson_id);
create index if not exists idx_lesson_videos_course on public.lesson_videos (course_id);
create index if not exists idx_lesson_videos_status on public.lesson_videos (status);

-- table public.lesson_practicals (verbatim from 010)
create table if not exists public.lesson_practicals (
  id                uuid primary key default gen_random_uuid(),
  lesson_id         uuid not null,
  course_id         uuid references public.courses(id) on delete cascade,
  module_id         uuid references public.course_modules(id) on delete cascade,
  title             text not null,
  objective         text not null,
  scenario          text,
  instructions      text not null,
  requirements      text,
  expected_output   text,
  difficulty        public.difficulty_level not null default 'BEGINNER',
  estimated_time    integer check (estimated_time is null or estimated_time > 0),
  submission_type   text,
  evaluation_criteria jsonb default '[]'::jsonb,
  status            public.content_status not null default 'DRAFT',
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_practicals_lesson on public.lesson_practicals (lesson_id);
create index if not exists idx_practicals_course on public.lesson_practicals (course_id);

-- table public.lesson_content (verbatim from 010, incl. pgvector guards)
-- pgvector is preinstalled on Supabase cloud but absent from plain
-- Postgres (e.g. embedded test databases). Install it first when
-- available; when it is not, the embedding column is skipped and RAG
-- degrades to keyword search (the "handled gracefully" intent).
do $$
begin
  create extension if not exists vector;
exception when others then
  raise notice 'pgvector not available — lesson_content.embedding will be skipped';
end $$;

create table if not exists public.lesson_content (
  id                uuid primary key default gen_random_uuid(),
  lesson_id         uuid not null,
  course_id         uuid not null references public.courses(id) on delete cascade,
  module_id         uuid references public.course_modules(id) on delete cascade,
  content_type      text not null default 'TEXT',
  content           text not null,
  chunk_index       integer not null default 0,
  metadata          jsonb default '{}'::jsonb,
  is_approved       boolean not null default false,
  created_at        timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    alter table public.lesson_content add column if not exists embedding vector;
  else
    raise notice 'pgvector not available — lesson_content.embedding skipped';
  end if;
exception when others then
  raise notice 'lesson_content.embedding skipped: %', SQLERRM;
end $$;

create index if not exists idx_lesson_content_course on public.lesson_content (course_id);
create index if not exists idx_lesson_content_lesson on public.lesson_content (lesson_id);
create index if not exists idx_lesson_content_approved on public.lesson_content (is_approved) where is_approved = true;

-- -----------------------------------------------------------------


-- =====================================================================
-- PART B. MIGRATION 014 CORE (byte-identical to supabase/migrations/20260910000014_lms_curriculum_engine.sql)
-- =====================================================================

-- =====================================================================
-- WOLI DAN TECH HUB — LEARN • BUILD • GROW
-- Migration 014: Complete LMS Curriculum Engine
--
-- Delivers the REAL production curriculum chain:
--
--   courses → course_modules → course_topics → lessons (course_lessons)
--     → lesson_contents → lesson_resources → lesson_videos
--     → lesson_practicals → assignments → assignment_submissions
--     → quizzes → quiz_questions → quiz_options → quiz_attempts
--     → course_assessments → lesson_progress (student_progress)
--     → certificates
--
-- DESIGN PRINCIPLES (do not regress these):
--  * REUSE, don't duplicate. `lessons` is canonical; `course_lessons` is a
--    compatibility VIEW (or a one-way mirror when the live project already
--    has a `course_lessons` TABLE with real data). `course_resources` is
--    canonical; `lesson_resources` is a view. `lesson_progress` is
--    canonical; `student_progress` is a view. `lesson_content` (singular,
--    RAG chunks) is kept; `lesson_contents` (plural, structured learning
--    blocks) is the NEW structured table — they serve different purposes.
--  * DUAL-FLAG NORMALISATION. The backend historically used `is_published`
--    while the live/frontend project used `published`/`archived`. Both
--    columns now exist everywhere and BEFORE triggers keep them in sync,
--    so backend code, the AI gateway, and direct-Supabase frontends all
--    agree on what is visible.
--  * IDEMPOTENT + embedded-Postgres safe (scripts/test-db.mjs runs every
--    migration against stubbed auth/storage schemas).
-- =====================================================================

-- =====================================================================
-- A. COURSES — compat flags + curriculum metadata
-- =====================================================================

alter table public.courses add column if not exists published boolean not null default false;
alter table public.courses add column if not exists archived boolean not null default false;
alter table public.courses add column if not exists is_published boolean not null default false;
alter table public.courses add column if not exists learning_outcomes jsonb not null default '[]'::jsonb;
alter table public.courses add column if not exists prerequisites jsonb not null default '[]'::jsonb;
alter table public.courses add column if not exists learning_objectives jsonb not null default '[]'::jsonb;
alter table public.courses add column if not exists level text;
alter table public.courses add column if not exists category text;

-- Reconcile the two flag conventions exactly once (triggers keep them in
-- sync afterwards). Visible = is_published AND NOT archived.
update public.courses
set is_published = coalesce(is_published, false) or (coalesce(published, false) and not coalesce(archived, false))
where true;

update public.courses
set published = is_published,
    archived  = case when is_published then false else archived end
where published is distinct from is_published
   or (is_published and archived);

-- Backfill denormalised display columns (best effort; trigger maintains).
update public.courses c
set level = c.difficulty_level::text
where c.level is null;

update public.courses c
set category = cc.name
from public.course_categories cc
where cc.id = c.category_id and c.category is null;

-- Canonical publish-flag synchronisation. Single source of truth is
-- `is_published`; `published` mirrors it; `archived = true` forces both
-- to false so the course disappears from every surface (backend RLS,
-- gateway RAG filter `published AND NOT archived`, direct REST).
create or replace function public.sync_course_publish_flags()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.archived, false) then
    new.is_published := false;
    new.published    := false;
  elsif tg_op = 'INSERT' then
    -- Either flag true wins on insert, then mirror.
    new.is_published := coalesce(new.is_published, false) or coalesce(new.published, false);
    new.published    := new.is_published;
  elsif new.is_published is distinct from old.is_published then
    -- Canonical flag changed: mirror follows it (publish AND unpublish work).
    new.published := coalesce(new.is_published, false);
  elsif new.published is distinct from old.published then
    -- Legacy flag changed explicitly: canonical follows it.
    new.is_published := coalesce(new.published, false);
    new.published    := coalesce(new.is_published, false);
  else
    -- Unrelated columns updated: enforce the mirror.
    new.published    := coalesce(new.is_published, false);
    new.is_published := coalesce(new.is_published, false);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_courses_publish_sync on public.courses;
create trigger trg_courses_publish_sync
  before insert or update of is_published, published, archived on public.courses
  for each row execute function public.sync_course_publish_flags();

-- Best-effort denormalisation for frontend/gateway compatibility
-- (`courses.level`, `courses.category`). Never allowed to break writes.
create or replace function public.denorm_course_display()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  begin
    new.level := new.difficulty_level::text;
  exception when others then
    -- keep caller-supplied value
  end;
  begin
    if new.category_id is not null then
      select cc.name into new.category
      from public.course_categories cc
      where cc.id = new.category_id;
    else
      new.category := null;
    end if;
  exception when others then
    -- keep caller-supplied value
  end;
  return new;
end;
$$;

drop trigger if exists trg_courses_denorm on public.courses;
create trigger trg_courses_denorm
  before insert or update of difficulty_level, category_id, category, level on public.courses
  for each row execute function public.denorm_course_display();

create index if not exists idx_courses_published_live on public.courses (published) where published = true;
create index if not exists idx_courses_archived on public.courses (archived) where archived = false;

comment on column public.courses.published is 'Frontend/live-project mirror of is_published. Kept in sync by trg_courses_publish_sync — never diverges.';
comment on column public.courses.archived is 'When true the course is hidden everywhere (forces is_published/published to false).';
comment on column public.courses.learning_outcomes is 'JSON array of strings: what the student will be able to do after this course.';
comment on column public.courses.prerequisites is 'JSON array of strings: required knowledge/tools before starting.';
comment on column public.courses.learning_objectives is 'JSON array of strings: lesson-level teaching objectives roll-up.';

-- =====================================================================
-- B. COURSE_TOPICS — the missing layer between modules and lessons
-- =====================================================================

create table if not exists public.course_topics (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid not null references public.courses (id) on delete cascade,
  module_id    uuid not null references public.course_modules (id) on delete cascade,
  title        text not null,
  description  text,
  summary      text,
  order_number integer not null default 1 check (order_number <> 0),
  is_published boolean not null default false,
  published    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint uq_topic_order unique (module_id, order_number)
);

create index if not exists idx_topics_course on public.course_topics (course_id, order_number);
create index if not exists idx_topics_module on public.course_topics (module_id, order_number);
create index if not exists idx_topics_published on public.course_topics (is_published) where is_published = true;

-- A topic's module must belong to the topic's course (fail fast, no orphans).
create or replace function public.check_topic_module_course()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_course uuid;
begin
  select m.course_id into v_course
  from public.course_modules m
  where m.id = new.module_id;

  if v_course is null then
    raise exception 'TOPIC_MODULE_NOT_FOUND: module % does not exist', new.module_id;
  end if;
  if v_course <> new.course_id then
    raise exception 'TOPIC_COURSE_MISMATCH: module % belongs to a different course', new.module_id;
  end if;

  -- Flag mirror (OLD/NEW-aware so unpublish is never undone).
  if tg_op = 'INSERT' then
    new.is_published := coalesce(new.is_published, false) or coalesce(new.published, false);
    new.published := new.is_published;
  elsif new.is_published is distinct from old.is_published then
    new.published := coalesce(new.is_published, false);
  elsif new.published is distinct from old.published then
    new.is_published := coalesce(new.published, false);
    new.published := coalesce(new.is_published, false);
  else
    new.published := coalesce(new.is_published, false);
    new.is_published := coalesce(new.is_published, false);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_topics_integrity on public.course_topics;
create trigger trg_topics_integrity
  before insert or update of course_id, module_id, is_published, published on public.course_topics
  for each row execute function public.check_topic_module_course();

drop trigger if exists trg_topics_updated_at on public.course_topics;
create trigger trg_topics_updated_at
  before update on public.course_topics
  for each row execute function public.set_updated_at();

alter table public.course_topics enable row level security;

drop policy if exists topics_read on public.course_topics;
create policy topics_read on public.course_topics
  for select to anon, authenticated
  using (
    exists (select 1 from public.courses c
            where c.id = course_topics.course_id
              and c.is_published and not coalesce(c.archived, false))
    or public.is_admin()
    or public.is_course_instructor(course_topics.course_id)
    or public.has_active_enrollment(course_topics.course_id)
  );

drop policy if exists topics_admin_write on public.course_topics;
create policy topics_admin_write on public.course_topics
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

comment on table public.course_topics is 'Curriculum layer: course_modules → course_topics → lessons. Lessons may also attach directly to a module (topic_id NULL) for backwards compatibility.';

-- =====================================================================
-- C. LESSONS — topic link, denormalised course, flag sync, previews
-- =====================================================================

alter table public.lessons add column if not exists topic_id uuid references public.course_topics (id) on delete set null;
alter table public.lessons add column if not exists course_id uuid references public.courses (id) on delete cascade;
alter table public.lessons add column if not exists published boolean not null default false;
alter table public.lessons add column if not exists is_free_preview boolean not null default false;

-- Backfill denormalised course + flag mirror for pre-existing rows.
update public.lessons l
set course_id = m.course_id
from public.course_modules m
where m.id = l.module_id and l.course_id is null;

update public.lessons
set published = is_published
where published is distinct from is_published;

create or replace function public.sync_lesson_denorm()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_course uuid;
  v_topic_module uuid;
begin
  -- Flag mirror (OLD/NEW-aware so unpublish is never undone).
  if tg_op = 'INSERT' then
    new.is_published := coalesce(new.is_published, false) or coalesce(new.published, false);
    new.published := new.is_published;
  elsif new.is_published is distinct from old.is_published then
    new.published := coalesce(new.is_published, false);
  elsif new.published is distinct from old.published then
    new.is_published := coalesce(new.published, false);
    new.published := coalesce(new.is_published, false);
  else
    new.published := coalesce(new.is_published, false);
    new.is_published := coalesce(new.is_published, false);
  end if;

  -- course_id always mirrors the module's course (self-healing).
  select m.course_id into v_course
  from public.course_modules m
  where m.id = new.module_id;

  if v_course is null then
    raise exception 'LESSON_MODULE_NOT_FOUND: module % does not exist', new.module_id;
  end if;
  new.course_id := v_course;

  -- A linked topic must belong to the same module.
  if new.topic_id is not null then
    select t.module_id into v_topic_module
    from public.course_topics t
    where t.id = new.topic_id;

    if v_topic_module is null then
      raise exception 'LESSON_TOPIC_NOT_FOUND: topic % does not exist', new.topic_id;
    end if;
    if v_topic_module <> new.module_id then
      raise exception 'LESSON_TOPIC_MISMATCH: topic % belongs to a different module', new.topic_id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_lessons_denorm on public.lessons;
create trigger trg_lessons_denorm
  before insert or update of module_id, topic_id, course_id, is_published, published on public.lessons
  for each row execute function public.sync_lesson_denorm();

create index if not exists idx_lessons_topic on public.lessons (topic_id, order_number);
create index if not exists idx_lessons_course on public.lessons (course_id, order_number);
create index if not exists idx_lessons_preview on public.lessons (is_free_preview) where is_free_preview = true;

comment on column public.lessons.topic_id is 'Optional link into course_topics. NULL = lesson sits directly under its module (legacy layout).';
comment on column public.lessons.course_id is 'Denormalised from course_modules. Maintained by trg_lessons_denorm — never set manually.';
comment on column public.lessons.published is 'Frontend/live mirror of is_published. Kept in sync by trg_lessons_denorm.';
comment on column public.lessons.is_free_preview is 'When true, this lesson outline/body is publicly readable (marketing previews). Default false.';

-- =====================================================================
-- H. COURSE_ASSESSMENTS — module exams + final exams
-- =====================================================================

create table if not exists public.course_assessments (
  id                 uuid primary key default gen_random_uuid(),
  course_id          uuid not null references public.courses (id) on delete cascade,
  module_id          uuid references public.course_modules (id) on delete cascade,
  title              text not null,
  description        text,
  instructions       text,
  assessment_type    text not null default 'FINAL_EXAM'
    check (assessment_type in ('FINAL_EXAM', 'MODULE_EXAM', 'PLACEMENT', 'PRACTICE')),
  passing_score      integer not null default 70 check (passing_score between 0 and 100),
  time_limit_minutes integer check (time_limit_minutes is null or time_limit_minutes > 0),
  max_attempts       integer check (max_attempts is null or max_attempts > 0),
  order_number       integer not null default 1 check (order_number > 0),
  status             public.content_status not null default 'DRAFT',
  created_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_assessments_course on public.course_assessments (course_id, order_number);
create index if not exists idx_assessments_module on public.course_assessments (module_id);
create index if not exists idx_assessments_status on public.course_assessments (status);

drop trigger if exists trg_assessments_updated_at on public.course_assessments;
create trigger trg_assessments_updated_at
  before update on public.course_assessments
  for each row execute function public.set_updated_at();

alter table public.course_assessments enable row level security;

-- Enrolled students / instructors / admins read live assessments;
-- everyone else (and drafts) is hidden. Outline counts are served by
-- the backend / get_course_outline RPC.
drop policy if exists assessments_read on public.course_assessments;
create policy assessments_read on public.course_assessments
  for select to authenticated
  using (
    (status in ('APPROVED', 'PUBLISHED')
      and (public.has_active_enrollment(course_assessments.course_id)
           or public.is_course_instructor(course_assessments.course_id)))
    or public.is_admin()
  );

drop policy if exists assessments_admin_write on public.course_assessments;
create policy assessments_admin_write on public.course_assessments
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

comment on table public.course_assessments is 'Course-level and module-level exams. Question banks reuse the quiz engine: quizzes rows with assessment_id + scope FINAL.';

-- =====================================================================
-- E. EXTEND EXISTING CONTENT TABLES (topic links + grading fields)
-- =====================================================================

alter table public.course_resources add column if not exists topic_id uuid references public.course_topics (id) on delete set null;
alter table public.lesson_content add column if not exists topic_id uuid references public.course_topics (id) on delete set null;
alter table public.lesson_practicals add column if not exists topic_id uuid references public.course_topics (id) on delete set null;
alter table public.lesson_videos add column if not exists topic_id uuid references public.course_topics (id) on delete set null;

alter table public.assignments add column if not exists topic_id uuid references public.course_topics (id) on delete set null;
alter table public.assignments add column if not exists max_score numeric(6, 2) not null default 100 check (max_score > 0);
alter table public.assignments add column if not exists pass_score numeric(6, 2) not null default 50 check (pass_score >= 0);
alter table public.assignments add column if not exists due_date timestamptz;

alter table public.quizzes add column if not exists topic_id uuid references public.course_topics (id) on delete set null;
alter table public.quizzes add column if not exists scope text not null default 'LESSON'
  check (scope in ('LESSON', 'TOPIC', 'MODULE', 'FINAL'));
alter table public.quizzes add column if not exists assessment_id uuid references public.course_assessments (id) on delete set null;
alter table public.quizzes add column if not exists order_number integer not null default 1 check (order_number > 0);

create index if not exists idx_course_resources_topic on public.course_resources (topic_id);
create index if not exists idx_lesson_content_topic on public.lesson_content (topic_id);
create index if not exists idx_practicals_topic on public.lesson_practicals (topic_id);
create index if not exists idx_lesson_videos_topic on public.lesson_videos (topic_id);
create index if not exists idx_assignments_topic on public.assignments (topic_id);
create index if not exists idx_quizzes_topic on public.quizzes (topic_id);
create index if not exists idx_quizzes_assessment on public.quizzes (assessment_id);
create index if not exists idx_quizzes_scope on public.quizzes (course_id, scope);

-- =====================================================================
-- D. LESSON_CONTENTS — structured learning blocks
-- =====================================================================
-- NOTE: `lesson_content` (singular, migration 010) stores RAG/search
-- chunks for DanTECH AI. `lesson_contents` (plural, here) stores the
-- ordered, publishable learning blocks students actually read/watch:
-- theory, examples, videos, PDFs, code, summaries. Different purpose,
-- not a duplicate.

create table if not exists public.lesson_contents (
  id               uuid primary key default gen_random_uuid(),
  lesson_id        uuid not null references public.lessons (id) on delete cascade,
  course_id        uuid references public.courses (id) on delete cascade,
  module_id        uuid references public.course_modules (id) on delete cascade,
  topic_id         uuid references public.course_topics (id) on delete set null,
  block_type       text not null default 'THEORY'
    check (block_type in ('THEORY', 'TEXT', 'EXAMPLE', 'VIDEO', 'PDF', 'IMAGE',
                          'AUDIO', 'CODE', 'EMBED', 'SUMMARY', 'KEY_CONCEPTS',
                          'READING', 'DOWNLOAD')),
  title            text,
  body             text,
  url              text,
  storage_path     text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  order_number     integer not null default 1 check (order_number <> 0),
  is_published     boolean not null default false,
  published        boolean not null default false,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint uq_content_order unique (lesson_id, order_number),
  constraint chk_content_payload check (
    body is not null or url is not null or storage_path is not null
  )
);

create index if not exists idx_lesson_contents_lesson on public.lesson_contents (lesson_id, order_number);
create index if not exists idx_lesson_contents_course on public.lesson_contents (course_id);
create index if not exists idx_lesson_contents_published on public.lesson_contents (is_published) where is_published = true;

create or replace function public.sync_lesson_content_denorm()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_course uuid;
  v_module uuid;
  v_topic uuid;
begin
  -- Flag mirror (OLD/NEW-aware so unpublish is never undone).
  if tg_op = 'INSERT' then
    new.is_published := coalesce(new.is_published, false) or coalesce(new.published, false);
    new.published := new.is_published;
  elsif new.is_published is distinct from old.is_published then
    new.published := coalesce(new.is_published, false);
  elsif new.published is distinct from old.published then
    new.is_published := coalesce(new.published, false);
    new.published := coalesce(new.is_published, false);
  else
    new.published := coalesce(new.is_published, false);
    new.is_published := coalesce(new.is_published, false);
  end if;

  select l.course_id, l.module_id, l.topic_id
    into v_course, v_module, v_topic
  from public.lessons l
  where l.id = new.lesson_id;

  if v_module is null then
    raise exception 'CONTENT_LESSON_NOT_FOUND: lesson % does not exist', new.lesson_id;
  end if;

  new.course_id := v_course;
  new.module_id := v_module;
  new.topic_id  := v_topic;
  return new;
end;
$$;

drop trigger if exists trg_lesson_contents_denorm on public.lesson_contents;
create trigger trg_lesson_contents_denorm
  before insert or update of lesson_id, is_published, published on public.lesson_contents
  for each row execute function public.sync_lesson_content_denorm();

drop trigger if exists trg_lesson_contents_updated_at on public.lesson_contents;
create trigger trg_lesson_contents_updated_at
  before update on public.lesson_contents
  for each row execute function public.set_updated_at();

alter table public.lesson_contents enable row level security;

-- Gated exactly like lessons: enrolled students, instructor, admin.
drop policy if exists lesson_contents_read on public.lesson_contents;
create policy lesson_contents_read on public.lesson_contents
  for select to authenticated
  using (
    public.is_admin()
    or public.is_course_instructor(lesson_contents.course_id)
    or public.has_active_enrollment(lesson_contents.course_id)
  );

drop policy if exists lesson_contents_admin_write on public.lesson_contents;
create policy lesson_contents_admin_write on public.lesson_contents
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

comment on table public.lesson_contents is 'Ordered learning blocks per lesson: THEORY / EXAMPLE / VIDEO / PDF / CODE / SUMMARY ... Publishable individually.';

-- =====================================================================
-- F. ASSIGNMENT_SUBMISSIONS — student work + grading
-- =====================================================================

create table if not exists public.assignment_submissions (
  id             uuid primary key default gen_random_uuid(),
  assignment_id  uuid not null references public.assignments (id) on delete cascade,
  student_id     uuid not null references public.profiles (id) on delete cascade,
  course_id      uuid not null references public.courses (id) on delete cascade,
  lesson_id      uuid references public.lessons (id) on delete set null,
  attempt_number integer not null default 1 check (attempt_number > 0),
  submission_text text,
  file_path      text,
  file_name      text,
  file_type      text,
  status         text not null default 'SUBMITTED'
    check (status in ('SUBMITTED', 'UNDER_REVIEW', 'GRADED', 'RETURNED')),
  score          numeric(6, 2) check (score is null or (score >= 0 and score <= 100)),
  feedback       text,
  graded_by      uuid references public.profiles (id) on delete set null,
  graded_at      timestamptz,
  submitted_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint uq_submission_attempt unique (assignment_id, student_id, attempt_number),
  constraint chk_submission_payload check (
    submission_text is not null or file_path is not null
  ),
  constraint chk_grading_fields check (
    (status in ('GRADED', 'RETURNED') and graded_at is not null)
    or status in ('SUBMITTED', 'UNDER_REVIEW')
  )
);

create index if not exists idx_submissions_assignment on public.assignment_submissions (assignment_id, submitted_at desc);
create index if not exists idx_submissions_student_course on public.assignment_submissions (student_id, course_id);
create index if not exists idx_submissions_status on public.assignment_submissions (status);

drop trigger if exists trg_submissions_updated_at on public.assignment_submissions;
create trigger trg_submissions_updated_at
  before update on public.assignment_submissions
  for each row execute function public.set_updated_at();

-- Students can never grade their own work: any change to score /
-- feedback / status / grading identity by a non-privileged caller is
-- rejected. The backend service role bypasses RLS but NOT triggers, so
-- the trigger must let the service role through explicitly (PostgREST
-- always sets request.jwt.claims, including role=service_role).
create or replace function public.guard_submission_grading()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_claims jsonb;
begin
  if tg_op = 'INSERT' then
    -- Students may only create ungraded submissions for themselves.
    if new.score is not null or new.feedback is not null
       or new.status not in ('SUBMITTED') or new.graded_by is not null then
      begin
        v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
      exception when others then
        v_claims := null;
      end;
      if coalesce(v_claims ->> 'role', '') <> 'service_role'
         and not public.is_admin()
         and not public.is_course_instructor(new.course_id) then
        raise exception 'FORBIDDEN: students cannot pre-grade their own submission';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE path
  if new.score is distinct from old.score
     or new.feedback is distinct from old.feedback
     or new.status is distinct from old.status
     or new.graded_by is distinct from old.graded_by
     or new.graded_at is distinct from old.graded_at then
    begin
      v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    exception when others then
      v_claims := null;
    end;
    if coalesce(v_claims ->> 'role', '') <> 'service_role'
       and not public.is_admin()
       and not public.is_course_instructor(new.course_id) then
      raise exception 'FORBIDDEN: only an instructor or admin can grade a submission';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_submissions_grading_guard on public.assignment_submissions;
create trigger trg_submissions_grading_guard
  before insert or update on public.assignment_submissions
  for each row execute function public.guard_submission_grading();

alter table public.assignment_submissions enable row level security;

drop policy if exists submissions_select on public.assignment_submissions;
create policy submissions_select on public.assignment_submissions
  for select to authenticated
  using (
    student_id = public.current_profile_id()
    or public.is_admin()
    or public.is_course_instructor(course_id)
  );

-- Enrolled students submit for themselves only, ungraded.
drop policy if exists submissions_insert_own on public.assignment_submissions;
create policy submissions_insert_own on public.assignment_submissions
  for insert to authenticated
  with check (
    student_id = public.current_profile_id()
    and public.has_active_enrollment(course_id)
    and status = 'SUBMITTED'
    and score is null
    and graded_by is null
    and graded_at is null
  );

-- Students may revise while ungraded; grading columns are protected by
-- the trigger above even if RLS permits the row update.
drop policy if exists submissions_update_own on public.assignment_submissions;
create policy submissions_update_own on public.assignment_submissions
  for update to authenticated
  using (
    student_id = public.current_profile_id()
    and status in ('SUBMITTED', 'RETURNED')
  )
  with check (
    student_id = public.current_profile_id()
    and status in ('SUBMITTED', 'RETURNED')
  );

drop policy if exists submissions_admin_all on public.assignment_submissions;
create policy submissions_admin_all on public.assignment_submissions
  for all to authenticated
  using (public.is_admin() or public.is_course_instructor(course_id))
  with check (public.is_admin() or public.is_course_instructor(course_id));

comment on table public.assignment_submissions is 'Student assignment work. Grading (score/feedback/status) is instructor/admin-only, enforced by trigger + RLS.';

-- =====================================================================
-- G. QUIZ_OPTIONS (normalised) + QUIZ_ATTEMPTS (graded attempts)
-- =====================================================================

create table if not exists public.quiz_options (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references public.quiz_questions (id) on delete cascade,
  option_text  text not null,
  is_correct   boolean not null default false,
  order_number integer not null default 1 check (order_number > 0),
  explanation  text,
  created_at   timestamptz not null default now(),
  constraint uq_option_order unique (question_id, order_number)
);

create index if not exists idx_quiz_options_question on public.quiz_options (question_id, order_number);

-- Backfill normalised options from the legacy quiz_questions.options
-- JSONB column (best effort per question — one bad row never fails the
-- migration). Display shapes handled: string items, {text}, {option_text},
-- {label}; correctness from correct_answer (string | string[] | boolean).
do $$
declare
  q record;
  v_item jsonb;
  v_idx integer;
  v_text text;
  v_correct boolean;
  v_answer jsonb;
begin
  for q in select id, options, correct_answer, question_type from public.quiz_questions loop
    if q.options is null or jsonb_typeof(q.options) <> 'array' or jsonb_array_length(q.options) = 0 then
      continue;
    end if;
    if exists (select 1 from public.quiz_options o where o.question_id = q.id) then
      continue;
    end if;
    begin
      v_idx := 0;
      for v_item in select * from jsonb_array_elements(q.options) loop
        v_idx := v_idx + 1;
        v_text := case jsonb_typeof(v_item)
          when 'string' then v_item #>> '{}'
          else coalesce(v_item ->> 'text', v_item ->> 'option_text', v_item ->> 'label', v_item ->> 'value', v_item::text)
        end;
        v_answer := q.correct_answer;
        v_correct := false;
        if v_answer is not null then
          if jsonb_typeof(v_answer) = 'array' then
            v_correct := exists (
              select 1 from jsonb_array_elements_text(v_answer) a
              where lower(trim(a)) = lower(trim(coalesce(v_text, '')))
                 or a = (v_item ->> 'id')
            );
          elsif jsonb_typeof(v_answer) = 'boolean' then
            v_correct := lower(trim(coalesce(v_text, ''))) = case when (v_answer::text)::boolean then 'true' else 'false' end;
          else
            v_correct := lower(trim(v_answer #>> '{}')) = lower(trim(coalesce(v_text, '')));
          end if;
        end if;
        insert into public.quiz_options (question_id, option_text, is_correct, order_number)
        values (q.id, coalesce(v_text, ''), coalesce(v_correct, false), v_idx)
        on conflict do nothing;
      end loop;
    exception when others then
      raise notice 'quiz_options backfill skipped for question %: %', q.id, SQLERRM;
    end;
  end loop;
end $$;

-- Keep the legacy options JSONB in sync as DISPLAY-ONLY data
-- ({id, text, order} — never correctness flags) so old readers keep
-- working without leaking answers.
create or replace function public.sync_question_options_json()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_question uuid;
begin
  v_question := coalesce(new.question_id, old.question_id);
  update public.quiz_questions qq
  set options = coalesce((
    select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.option_text, 'order', o.order_number)
                     order by o.order_number)
    from public.quiz_options o
    where o.question_id = v_question
  ), '[]'::jsonb)
  where qq.id = v_question;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_quiz_options_sync on public.quiz_options;
create trigger trg_quiz_options_sync
  after insert or update or delete on public.quiz_options
  for each row execute function public.sync_question_options_json();

alter table public.quiz_options enable row level security;

drop policy if exists quiz_options_read on public.quiz_options;
create policy quiz_options_read on public.quiz_options
  for select to authenticated
  using (
    exists (select 1 from public.quiz_questions q
            join public.quizzes z on z.id = q.quiz_id
            where q.id = quiz_options.question_id
              and (z.status in ('APPROVED', 'PUBLISHED') or public.is_admin()))
  );

drop policy if exists quiz_options_admin_write on public.quiz_options;
create policy quiz_options_admin_write on public.quiz_options
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

comment on table public.quiz_options is 'Normalised answer options. Canonical correctness lives in is_correct; quiz_questions.options JSONB is a display-only mirror. Students should fetch quizzes via the backend or get_quiz_for_student() (answers stripped).';

-- -----------------------------------------------------------------
-- quiz_attempts — immutable graded attempts
-- -----------------------------------------------------------------

create table if not exists public.quiz_attempts (
  id              uuid primary key default gen_random_uuid(),
  quiz_id         uuid not null references public.quizzes (id) on delete cascade,
  student_id      uuid not null references public.profiles (id) on delete cascade,
  course_id       uuid not null references public.courses (id) on delete cascade,
  score           numeric(5, 2) not null default 0 check (score >= 0 and score <= 100),
  passed          boolean not null default false,
  total_questions integer not null default 0 check (total_questions >= 0),
  correct_count   integer not null default 0 check (correct_count >= 0),
  answers         jsonb not null default '[]'::jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_quiz_attempts_quiz_student on public.quiz_attempts (quiz_id, student_id, created_at desc);
create index if not exists idx_quiz_attempts_student_course on public.quiz_attempts (student_id, course_id);

alter table public.quiz_attempts enable row level security;

drop policy if exists quiz_attempts_select on public.quiz_attempts;
create policy quiz_attempts_select on public.quiz_attempts
  for select to authenticated
  using (
    student_id = public.current_profile_id()
    or public.is_admin()
    or public.is_course_instructor(course_id)
  );

-- Attempts are created through grading (backend/RPC). Direct inserts are
-- allowed only for enrolled students on live quizzes; the score columns
-- are still validated by grading logic server-side.
drop policy if exists quiz_attempts_insert_own on public.quiz_attempts;
create policy quiz_attempts_insert_own on public.quiz_attempts
  for insert to authenticated
  with check (
    student_id = public.current_profile_id()
    and public.has_active_enrollment(course_id)
  );

-- No student UPDATE/DELETE policy: attempts are immutable.

drop policy if exists quiz_attempts_admin_all on public.quiz_attempts;
create policy quiz_attempts_admin_all on public.quiz_attempts
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- =====================================================================
-- I. COMPATIBILITY VIEWS + LIVE course_lessons MIRROR
-- =====================================================================

-- lesson_resources → canonical course_resources (view freezes its column
-- list at creation; re-run this statement after altering the base table).
drop view if exists public.lesson_resources;
create view public.lesson_resources as
  select * from public.course_resources;

comment on view public.lesson_resources is 'Compat alias for course_resources (requested LMS name). Canonical writes go to course_resources.';

-- student_progress → canonical lesson_progress enriched with module/topic.
drop view if exists public.student_progress;
create view public.student_progress as
  select lp.id, lp.student_id, lp.lesson_id, lp.course_id,
         lp.completed, lp.completed_at, lp.last_position, lp.updated_at,
         l.module_id, l.topic_id
  from public.lesson_progress lp
  join public.lessons l on l.id = lp.lesson_id;

comment on view public.student_progress is 'Compat alias for lesson_progress (requested LMS name) + module/topic context. Writes go to lesson_progress.';

grant select on public.lesson_resources to anon, authenticated, service_role;
grant select on public.student_progress to anon, authenticated, service_role;

-- course_lessons: canonical data lives in `lessons`.
--   * Fresh / backend-schema DBs: expose a VIEW so gateway + frontend
--     queries written against `course_lessons` keep working.
--   * Live DBs where `course_lessons` is already a TABLE: backfill any
--     missing rows INTO `lessons` (same UUIDs, so progress/FKs keep
--     working) and mirror future `lessons` writes back, so old readers
--     never go stale. The mirror trigger can never break canonical
--     writes (exception-guarded).
do $$
begin
  if to_regclass('public.course_lessons') is null then
    create view public.course_lessons as
      select l.id,
             l.course_id,
             l.module_id,
             l.topic_id,
             l.title,
             l.description,
             l.lesson_type,
             l.content,
             l.video_url,
             l.resource_url,
             l.duration,
             l.order_number,
             l.order_number as position,
             l.is_published,
             l.published,
             l.is_free_preview,
             l.created_at,
             l.updated_at
      from public.lessons l;

    comment on view public.course_lessons is 'Compat projection of lessons (requested LMS name). Canonical writes go to lessons. Exposes both order_number and position.';
    grant select on public.course_lessons to anon, authenticated, service_role;
  end if;
end $$;

-- course_content: gateway RAG embeds `course_content(body_markdown)`.
-- Provide the same projection when the live table does not exist.
do $$
begin
  if to_regclass('public.course_content') is null then
    create view public.course_content as
      select l.id as id,
             l.id as lesson_id,
             l.course_id as course_id,
             l.module_id as module_id,
             l.title as title,
             l.content as body_markdown,
             l.content as body,
             l.video_url as video_url,
             l.updated_at as updated_at
      from public.lessons l;

    comment on view public.course_content is 'Compat projection of lesson bodies for RAG/gateway readers. Canonical source is lessons.content.';
    grant select on public.course_content to anon, authenticated, service_role;
  end if;
end $$;

-- Backfill lessons FROM a legacy course_lessons TABLE (same ids).
do $$
declare
  r record;
  v_has_is_published boolean;
  v_has_published boolean;
  v_has_position boolean;
  v_has_order boolean;
  v_has_content boolean;
  v_has_video boolean;
  v_has_description boolean;
  v_has_duration boolean;
  v_has_type boolean;
  v_row jsonb;
begin
  if to_regclass('public.course_lessons') is null then
    return;
  end if;
  -- Only when it is a real TABLE (relkind r/p), not our view.
  if (select c.relkind from pg_class c where c.oid = to_regclass('public.course_lessons')) not in ('r', 'p') then
    return;
  end if;

  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'course_lessons' and column_name = 'is_published') into v_has_is_published;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'course_lessons' and column_name = 'published') into v_has_published;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'course_lessons' and column_name = 'position') into v_has_position;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'course_lessons' and column_name = 'order_number') into v_has_order;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'course_lessons' and column_name = 'content') into v_has_content;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'course_lessons' and column_name = 'video_url') into v_has_video;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'course_lessons' and column_name = 'description') into v_has_description;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'course_lessons' and column_name = 'duration') into v_has_duration;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'course_lessons' and column_name = 'lesson_type') into v_has_type;

  for r in execute 'select * from public.course_lessons cl where not exists (select 1 from public.lessons l where l.id = cl.id)' loop
    begin
      v_row := to_jsonb(r);
      insert into public.lessons (id, module_id, title, description, lesson_type, video_url, content, duration, order_number, is_published)
      values (
        (v_row ->> 'id')::uuid,
        (v_row ->> 'module_id')::uuid,
        coalesce(v_row ->> 'title', 'Untitled lesson'),
        case when v_has_description then v_row ->> 'description' else null end,
        case when v_has_type and coalesce(v_row ->> 'lesson_type', '') in ('VIDEO', 'TEXT', 'PDF', 'RESOURCE')
             then (v_row ->> 'lesson_type')::public.lesson_type else 'TEXT'::public.lesson_type end,
        case when v_has_video then v_row ->> 'video_url' else null end,
        case when v_has_content then v_row ->> 'content' else null end,
        case when v_has_duration
             then nullif(regexp_replace(coalesce(v_row ->> 'duration', ''), '[^0-9]', '', 'g'), '')::integer
             else null end,
        coalesce(
          case when v_has_order then nullif(v_row ->> 'order_number', '')::integer end,
          case when v_has_position then nullif(v_row ->> 'position', '')::integer end,
          1
        ),
        coalesce(
          case when v_has_is_published then (v_row ->> 'is_published')::boolean end,
          case when v_has_published then (v_row ->> 'published')::boolean end,
          false
        )
      )
      on conflict (id) do nothing;
    exception when others then
      raise notice 'course_lessons backfill skipped for id %: %', v_row ->> 'id', SQLERRM;
    end;
  end loop;
end $$;

-- One-way mirror: lessons → legacy course_lessons TABLE (if one exists).
-- Exception-guarded: it can NEVER break canonical writes.
create or replace function public.sync_course_lessons_mirror()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_cols text[];
  v_sets text[];
  v_ins_cols text[];
  v_ins_vals text[];
begin
  begin
    if to_regclass('public.course_lessons') is null then
      return coalesce(new, old);
    end if;
    if (select c.relkind from pg_class c where c.oid = to_regclass('public.course_lessons')) not in ('r', 'p') then
      return coalesce(new, old);
    end if;

    select coalesce(array_agg(column_name), '{}') into v_cols
    from information_schema.columns
    where table_schema = 'public' and table_name = 'course_lessons';

    if tg_op = 'DELETE' then
      execute format('delete from public.course_lessons where id = %L', old.id);
      return old;
    end if;

    -- Build dynamic upsert covering only columns that exist.
    v_ins_cols := array['id'];
    v_ins_vals := array[format('%L', new.id)];
    v_sets := array[]::text[];

    if 'module_id' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'module_id';
      v_ins_vals := v_ins_vals || format('%L', new.module_id);
      v_sets := v_sets || format('module_id = %L', new.module_id);
    end if;
    if 'course_id' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'course_id';
      v_ins_vals := v_ins_vals || format('%L', new.course_id);
      v_sets := v_sets || format('course_id = %L', new.course_id);
    end if;
    if 'title' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'title';
      v_ins_vals := v_ins_vals || format('%L', new.title);
      v_sets := v_sets || format('title = %L', new.title);
    end if;
    if 'description' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'description';
      v_ins_vals := v_ins_vals || format('%L', new.description);
      v_sets := v_sets || format('description = %L', new.description);
    end if;
    if 'content' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'content';
      v_ins_vals := v_ins_vals || format('%L', new.content);
      v_sets := v_sets || format('content = %L', new.content);
    end if;
    if 'video_url' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'video_url';
      v_ins_vals := v_ins_vals || format('%L', new.video_url);
      v_sets := v_sets || format('video_url = %L', new.video_url);
    end if;
    if 'duration' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'duration';
      v_ins_vals := v_ins_vals || format('%L', new.duration);
      v_sets := v_sets || format('duration = %L', new.duration);
    end if;
    if 'order_number' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'order_number';
      v_ins_vals := v_ins_vals || format('%L', new.order_number);
      v_sets := v_sets || format('order_number = %L', new.order_number);
    end if;
    if 'position' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'position';
      v_ins_vals := v_ins_vals || format('%L', new.order_number);
      v_sets := v_sets || format('position = %L', new.order_number);
    end if;
    if 'is_published' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'is_published';
      v_ins_vals := v_ins_vals || format('%L', new.is_published);
      v_sets := v_sets || format('is_published = %L', new.is_published);
    end if;
    if 'published' = any (v_cols) then
      v_ins_cols := v_ins_cols || 'published';
      v_ins_vals := v_ins_vals || format('%L', new.published);
      v_sets := v_sets || format('published = %L', new.published);
    end if;

    if array_length(v_sets, 1) is null then
      execute format(
        'insert into public.course_lessons (%s) values (%s) on conflict (id) do nothing',
        array_to_string(v_ins_cols, ', '), array_to_string(v_ins_vals, ', ')
      );
    else
      execute format(
        'insert into public.course_lessons (%s) values (%s) on conflict (id) do update set %s',
        array_to_string(v_ins_cols, ', '), array_to_string(v_ins_vals, ', '),
        array_to_string(v_sets, ', ')
      );
    end if;
  exception when others then
    raise notice 'course_lessons mirror skipped: %', SQLERRM;
  end;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_lessons_course_lessons_mirror on public.lessons;
create trigger trg_lessons_course_lessons_mirror
  after insert or update or delete on public.lessons
  for each row execute function public.sync_course_lessons_mirror();

-- =====================================================================
-- J. RLS — normalise existing policies for dual flags + previews
-- =====================================================================

-- Courses: visible = is_published AND NOT archived (both flags are
-- trigger-synced, so either convention stays correct).
drop policy if exists courses_public_read on public.courses;
create policy courses_public_read on public.courses
  for select to anon, authenticated
  using (
    (is_published and not coalesce(archived, false))
    or public.is_admin()
    or public.is_course_instructor(id)
  );

-- Modules: same dual-flag visibility.
drop policy if exists modules_read on public.course_modules;
create policy modules_read on public.course_modules
  for select to anon, authenticated
  using (
    exists (select 1 from public.courses c
            where c.id = course_modules.course_id
              and c.is_published and not coalesce(c.archived, false))
    or public.is_admin()
    or public.is_course_instructor(course_modules.course_id)
    or public.has_active_enrollment(course_modules.course_id)
  );

-- Lessons: keep the strict gate AND add free-preview rows. Multiple
-- SELECT policies combine with OR, so previews add rows without
-- weakening the gate for the rest.
drop policy if exists lessons_preview_public on public.lessons;
create policy lessons_preview_public on public.lessons
  for select to anon, authenticated
  using (
    is_free_preview
    and exists (
      select 1 from public.course_modules m
      join public.courses c on c.id = m.course_id
      where m.id = lessons.module_id
        and c.is_published and not coalesce(c.archived, false)
        and lessons.is_published
    )
  );

-- Topics outline for direct-Supabase readers is already covered by
-- topics_read (section B). Contents stay fully gated (section D).

-- Lesson contents uploaded to private buckets are delivered via
-- backend-issued signed URLs only (no direct object policies).

-- =====================================================================
-- K. RPCs — outline, classroom, quizzes, completion, publishing
-- =====================================================================
-- Public wrappers resolve the caller via auth.uid() and are granted to
-- anon/authenticated. `*_for_student` / `*_for` variants take an
-- explicit student id and are granted to service_role ONLY (backend).
-- Triggers call the service variants as the function owner.

-- -----------------------------------------------------------------
-- get_course_outline — PUBLIC, safe columns only
-- -----------------------------------------------------------------
create or replace function public.get_course_outline(p_course_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_course jsonb;
  v_modules jsonb;
  v_counts jsonb;
  v_complete boolean;
begin
  select jsonb_build_object(
           'id', c.id, 'title', c.title, 'slug', c.slug,
           'description', c.description, 'thumbnail_url', c.thumbnail_url,
           'price', c.price, 'duration', c.duration,
           'difficulty_level', c.difficulty_level, 'level', c.level,
           'category', coalesce(c.category, cc.name),
           'learning_outcomes', coalesce(c.learning_outcomes, '[]'::jsonb),
           'prerequisites', coalesce(c.prerequisites, '[]'::jsonb),
           'learning_objectives', coalesce(c.learning_objectives, '[]'::jsonb)
         )
    into v_course
  from public.courses c
  left join public.course_categories cc on cc.id = c.category_id
  where c.id = p_course_id
    and c.is_published and not coalesce(c.archived, false);

  if v_course is null then
    return null;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', m.id, 'title', m.title, 'description', m.description,
      'order_number', m.order_number,
      'topics', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'title', t.title, 'description', t.description,
          'order_number', t.order_number,
          'lessons_count', (select count(*) from public.lessons l
                             where l.topic_id = t.id and l.is_published)
        ) order by t.order_number)
        from public.course_topics t
        where t.module_id = m.id and t.is_published
      ), '[]'::jsonb),
      'lessons', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', l.id, 'module_id', l.module_id, 'topic_id', l.topic_id,
          'title', l.title, 'description', l.description,
          'lesson_type', l.lesson_type, 'duration', l.duration,
          'order_number', l.order_number,
          'is_free_preview', coalesce(l.is_free_preview, false)
        ) order by l.order_number)
        from public.lessons l
        where l.module_id = m.id and l.is_published
      ), '[]'::jsonb)
    ) order by m.order_number
  ), '[]'::jsonb)
  into v_modules
  from public.course_modules m
  where m.course_id = p_course_id;

  select jsonb_build_object(
           'modules', (select count(*) from public.course_modules where course_id = p_course_id),
           'topics', (select count(*) from public.course_topics where course_id = p_course_id and is_published),
           'lessons', (select count(*) from public.lessons l
                        join public.course_modules m on m.id = l.module_id
                        where m.course_id = p_course_id and l.is_published),
           'quizzes', (select count(*) from public.quizzes where course_id = p_course_id and status in ('APPROVED', 'PUBLISHED')),
           'assignments', (select count(*) from public.assignments where course_id = p_course_id and status in ('APPROVED', 'PUBLISHED')),
           'assessments', (select count(*) from public.course_assessments where course_id = p_course_id and status in ('APPROVED', 'PUBLISHED'))
         )
    into v_counts;

  v_complete := (v_counts ->> 'modules')::int > 0 and (v_counts ->> 'lessons')::int > 0;

  return jsonb_build_object(
    'course', v_course,
    'modules', v_modules,
    'counts', v_counts,
    'curriculum_complete', v_complete
  );
end;
$$;

-- -----------------------------------------------------------------
-- get_course_classroom_for_student — FULL gated classroom (service)
-- -----------------------------------------------------------------
create or replace function public.get_course_classroom_for_student(p_course_id uuid, p_student_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_role text;
  v_instructor uuid;
  v_enrollment jsonb;
  v_course jsonb;
  v_modules jsonb;
  v_progress jsonb;
  v_certificate jsonb;
  v_rules jsonb;
  v_assessments jsonb;
begin
  select c.instructor_id into v_instructor
  from public.courses c
  where c.id = p_course_id;
  if v_instructor is null and not exists (select 1 from public.courses where id = p_course_id) then
    raise exception 'COURSE_NOT_FOUND';
  end if;

  select p.role::text into v_role from public.profiles p where p.id = p_student_id;

  if v_role = 'admin' or v_instructor = p_student_id then
    v_enrollment := null;
  else
    select jsonb_build_object('id', e.id, 'status', e.status,
                              'enrolled_at', e.enrolled_at, 'completed_at', e.completed_at)
      into v_enrollment
    from public.enrollments e
    where e.course_id = p_course_id and e.student_id = p_student_id;

    if v_enrollment is null or not ((v_enrollment ->> 'status') in ('ACTIVE', 'COMPLETED')) then
      raise exception 'COURSE_ACCESS_DENIED: verified enrollment required';
    end if;
  end if;

  select jsonb_build_object(
           'id', c.id, 'title', c.title, 'slug', c.slug,
           'description', c.description, 'thumbnail_url', c.thumbnail_url,
           'price', c.price, 'duration', c.duration,
           'difficulty_level', c.difficulty_level, 'level', c.level,
           'category', c.category,
           'learning_outcomes', coalesce(c.learning_outcomes, '[]'::jsonb),
           'prerequisites', coalesce(c.prerequisites, '[]'::jsonb),
           'learning_objectives', coalesce(c.learning_objectives, '[]'::jsonb)
         )
    into v_course
  from public.courses c
  where c.id = p_course_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', m.id, 'title', m.title, 'description', m.description,
      'order_number', m.order_number,
      'topics', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'title', t.title, 'description', t.description,
          'summary', t.summary, 'order_number', t.order_number,
          'is_published', t.is_published
        ) order by t.order_number)
        from public.course_topics t
        where t.module_id = m.id
          and (v_role = 'admin' or v_instructor = p_student_id or t.is_published)
      ), '[]'::jsonb),
      'lessons', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', l.id, 'module_id', l.module_id, 'topic_id', l.topic_id,
          'title', l.title, 'description', l.description,
          'lesson_type', l.lesson_type, 'video_url', l.video_url,
          'content', l.content, 'resource_url', l.resource_url,
          'duration', l.duration, 'order_number', l.order_number,
          'is_published', l.is_published,
          'is_free_preview', coalesce(l.is_free_preview, false),
          'contents', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', lc.id, 'block_type', lc.block_type, 'title', lc.title,
              'body', lc.body, 'url', lc.url, 'storage_path', lc.storage_path,
              'duration_seconds', lc.duration_seconds, 'order_number', lc.order_number
            ) order by lc.order_number)
            from public.lesson_contents lc
            where lc.lesson_id = l.id
              and (v_role = 'admin' or v_instructor = p_student_id or lc.is_published)
          ), '[]'::jsonb),
          'videos', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', lv.id, 'title', lv.title, 'video_url', lv.video_url,
              'storage_path', lv.storage_path, 'duration', lv.duration,
              'thumbnail_url', lv.thumbnail_url, 'transcript', lv.transcript
            ) order by lv.created_at desc)
            from public.lesson_videos lv
            where lv.lesson_id = l.id and lv.status = 'COMPLETED'
          ), '[]'::jsonb),
          'resources', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', r.id, 'title', r.title, 'description', r.description,
              'url', r.url, 'storage_path', r.storage_path, 'source', r.source,
              'license', r.license, 'resource_type', r.resource_type,
              'is_external', r.is_external
            ))
            from public.course_resources r
            where r.lesson_id = l.id and r.is_approved
          ), '[]'::jsonb),
          'practicals', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', pr.id, 'title', pr.title, 'objective', pr.objective,
              'scenario', pr.scenario, 'instructions', pr.instructions,
              'requirements', pr.requirements, 'expected_output', pr.expected_output,
              'difficulty', pr.difficulty, 'estimated_time', pr.estimated_time
            ))
            from public.lesson_practicals pr
            where pr.lesson_id = l.id and pr.status in ('APPROVED', 'PUBLISHED')
          ), '[]'::jsonb),
          'assignments', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', a.id, 'title', a.title, 'description', a.description,
              'instructions', a.instructions, 'difficulty', a.difficulty,
              'max_score', a.max_score, 'pass_score', a.pass_score,
              'due_date', a.due_date
            ))
            from public.assignments a
            where a.lesson_id = l.id and a.status in ('APPROVED', 'PUBLISHED')
          ), '[]'::jsonb),
          'quizzes', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', q.id, 'title', q.title, 'description', q.description,
              'scope', q.scope, 'passing_score', q.passing_score,
              'time_limit', q.time_limit,
              'questions', (
                select coalesce(jsonb_agg(jsonb_build_object(
                  'id', qq.id, 'question', qq.question,
                  'question_type', qq.question_type,
                  'difficulty', qq.difficulty, 'order_number', qq.order_number,
                  'options', coalesce((
                    select jsonb_agg(jsonb_build_object(
                      'id', qo.id, 'text', qo.option_text, 'order_number', qo.order_number
                    ) order by qo.order_number)
                    from public.quiz_options qo
                    where qo.question_id = qq.id
                  ), qq.options)
                ) order by qq.order_number), '[]'::jsonb)
                from public.quiz_questions qq
                where qq.quiz_id = q.id
              )
            ))
            from public.quizzes q
            where q.lesson_id = l.id and q.status in ('APPROVED', 'PUBLISHED')
          ), '[]'::jsonb),
          'progress', (
            select jsonb_build_object('completed', lp.completed,
                                      'completed_at', lp.completed_at,
                                      'last_position', lp.last_position)
            from public.lesson_progress lp
            where lp.lesson_id = l.id and lp.student_id = p_student_id
          )
        ) order by l.order_number)
        from public.lessons l
        where l.module_id = m.id
          and (v_role = 'admin' or v_instructor = p_student_id or l.is_published)
      ), '[]'::jsonb)
    ) order by m.order_number
  ), '[]'::jsonb)
  into v_modules
  from public.course_modules m
  where m.course_id = p_course_id;

  select jsonb_build_object(
           'total_lessons', (select count(*) from public.lessons l
                              join public.course_modules m on m.id = l.module_id
                              where m.course_id = p_course_id and l.is_published),
           'completed_lessons', (select count(*) from public.lesson_progress lp
                                  where lp.course_id = p_course_id
                                    and lp.student_id = p_student_id and lp.completed)
         )
    into v_progress;
  v_progress := v_progress || jsonb_build_object(
    'percentage', case when (v_progress ->> 'total_lessons')::int = 0 then 0
      else round(((v_progress ->> 'completed_lessons')::numeric
        / (v_progress ->> 'total_lessons')::numeric) * 100)::int end
  );

  select jsonb_build_object('id', c.id, 'certificate_number', c.certificate_number,
                            'issued_at', c.issued_at, 'status', c.status)
    into v_certificate
  from public.certificates c
  where c.course_id = p_course_id and c.student_id = p_student_id and c.status = 'ACTIVE';

  select to_jsonb(r) - 'id' - 'course_id' - 'created_at' - 'updated_at'
    into v_rules
  from public.course_completion_rules r
  where r.course_id = p_course_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'module_id', a.module_id, 'title', a.title,
           'description', a.description, 'instructions', a.instructions,
           'assessment_type', a.assessment_type, 'passing_score', a.passing_score,
           'time_limit_minutes', a.time_limit_minutes, 'max_attempts', a.max_attempts,
           'order_number', a.order_number,
           'quizzes', coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', q.id, 'title', q.title, 'passing_score', q.passing_score,
               'time_limit', q.time_limit
             ) order by q.order_number)
             from public.quizzes q
             where q.assessment_id = a.id and q.status in ('APPROVED', 'PUBLISHED')
           ), '[]'::jsonb)
         ) order by a.order_number), '[]'::jsonb)
    into v_assessments
  from public.course_assessments a
  where a.course_id = p_course_id and a.status in ('APPROVED', 'PUBLISHED');

  return jsonb_build_object(
    'course', v_course,
    'enrollment', v_enrollment,
    'modules', v_modules,
    'progress', v_progress,
    'certificate', v_certificate,
    'completion_rules', v_rules,
    'assessments', v_assessments
  );
end;
$$;

-- Authenticated wrapper: identity comes from the JWT, never the client.
create or replace function public.get_course_classroom(p_course_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_student uuid;
begin
  v_student := public.current_profile_id();
  if v_student is null then
    raise exception 'NOT_AUTHENTICATED: sign in required';
  end if;
  return public.get_course_classroom_for_student(p_course_id, v_student);
end;
$$;

-- -----------------------------------------------------------------
-- Student-safe single quiz (answers stripped)
-- -----------------------------------------------------------------
create or replace function public.get_quiz_for_student_for(p_quiz_id uuid, p_student_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_quiz record;
  v_role text;
  v_instructor uuid;
  v_enrolled boolean;
begin
  select q.*, c.instructor_id as course_instructor
    into v_quiz
  from public.quizzes q
  join public.courses c on c.id = q.course_id
  where q.id = p_quiz_id;

  if v_quiz.id is null then
    raise exception 'QUIZ_NOT_FOUND';
  end if;
  if v_quiz.status not in ('APPROVED', 'PUBLISHED') then
    raise exception 'QUIZ_NOT_AVAILABLE: quiz is not published';
  end if;

  select p.role::text into v_role from public.profiles p where p.id = p_student_id;
  v_instructor := v_quiz.course_instructor;

  if v_role = 'admin' or v_instructor = p_student_id then
    v_enrolled := true;
  else
    select exists (
      select 1 from public.enrollments e
      where e.course_id = v_quiz.course_id and e.student_id = p_student_id
        and e.status in ('ACTIVE', 'COMPLETED')
    ) into v_enrolled;
  end if;

  if not v_enrolled then
    raise exception 'COURSE_ACCESS_DENIED: verified enrollment required';
  end if;

  return jsonb_build_object(
    'id', v_quiz.id,
    'course_id', v_quiz.course_id,
    'module_id', v_quiz.module_id,
    'topic_id', v_quiz.topic_id,
    'lesson_id', v_quiz.lesson_id,
    'assessment_id', v_quiz.assessment_id,
    'scope', v_quiz.scope,
    'title', v_quiz.title,
    'description', v_quiz.description,
    'passing_score', v_quiz.passing_score,
    'time_limit', v_quiz.time_limit,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', qq.id, 'question', qq.question,
               'question_type', qq.question_type,
               'difficulty', qq.difficulty, 'topic', qq.topic,
               'order_number', qq.order_number,
               'options', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', qo.id, 'text', qo.option_text,
                          'order_number', qo.order_number
                        ) order by qo.order_number)
                 from public.quiz_options qo
                 where qo.question_id = qq.id
               ), qq.options)
             ) order by qq.order_number)
      from public.quiz_questions qq
      where qq.quiz_id = v_quiz.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_quiz_for_student(p_quiz_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_student uuid;
begin
  v_student := public.current_profile_id();
  if v_student is null then
    raise exception 'NOT_AUTHENTICATED: sign in required';
  end if;
  return public.get_quiz_for_student_for(p_quiz_id, v_student);
end;
$$;

-- -----------------------------------------------------------------
-- Server-side quiz grading (single implementation, two entry points)
-- -----------------------------------------------------------------
create or replace function public.grade_quiz_attempt(p_quiz_id uuid, p_student_id uuid, p_answers jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_quiz record;
  v_role text;
  v_instructor uuid;
  v_enrolled boolean;
  v_attempts_made integer;
  v_max_attempts integer;
  v_question record;
  v_options jsonb;
  v_submitted jsonb;
  v_correct boolean;
  v_total integer := 0;
  v_right integer := 0;
  v_score numeric(5, 2);
  v_passed boolean;
  v_attempt_id uuid;
  v_results jsonb := '[]'::jsonb;
  v_item jsonb;
  v_opt jsonb;
  v_expected jsonb;
  v_sub_set text[];
  v_correct_set text[];
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) = 0 then
    raise exception 'ANSWERS_REQUIRED: submit at least one answer';
  end if;

  select q.*, c.instructor_id as course_instructor
    into v_quiz
  from public.quizzes q
  join public.courses c on c.id = q.course_id
  where q.id = p_quiz_id;

  if v_quiz.id is null then
    raise exception 'QUIZ_NOT_FOUND';
  end if;
  if v_quiz.status not in ('APPROVED', 'PUBLISHED') then
    raise exception 'QUIZ_NOT_AVAILABLE: quiz is not published';
  end if;

  select p.role::text into v_role from public.profiles p where p.id = p_student_id;
  v_instructor := v_quiz.course_instructor;

  if v_role = 'admin' or v_instructor = p_student_id then
    v_enrolled := true;
  else
    select exists (
      select 1 from public.enrollments e
      where e.course_id = v_quiz.course_id and e.student_id = p_student_id
        and e.status in ('ACTIVE', 'COMPLETED')
    ) into v_enrolled;
  end if;

  if not v_enrolled then
    raise exception 'COURSE_ACCESS_DENIED: verified enrollment required';
  end if;

  -- Assessment attempt caps apply to assessment-linked quizzes.
  if v_quiz.assessment_id is not null then
    select a.max_attempts into v_max_attempts
    from public.course_assessments a
    where a.id = v_quiz.assessment_id;
    if v_max_attempts is not null then
      select count(*) into v_attempts_made
      from public.quiz_attempts qa
      where qa.quiz_id = p_quiz_id and qa.student_id = p_student_id;
      if v_attempts_made >= v_max_attempts then
        raise exception 'MAX_ATTEMPTS_REACHED: no attempts left for this assessment';
      end if;
    end if;
  end if;

  for v_question in
    select * from public.quiz_questions where quiz_id = p_quiz_id order by order_number
  loop
    v_total := v_total + 1;

    select coalesce(jsonb_agg(jsonb_build_object(
             'id', o.id::text, 'text', o.option_text, 'correct', o.is_correct
           ) order by o.order_number), '[]'::jsonb)
      into v_options
    from public.quiz_options o
    where o.question_id = v_question.id;

    select a -> 'answer' into v_submitted
    from jsonb_array_elements(p_answers) a
    where a ->> 'question_id' = v_question.id::text
    limit 1;

    v_correct := false;

    if v_question.question_type = 'multiple_answer' then
      if jsonb_typeof(v_options) = 'array' and jsonb_array_length(v_options) > 0 then
        select coalesce(array_agg(x.id order by x.id), '{}') into v_correct_set
        from jsonb_to_recordset(v_options) as x(id text, correct boolean)
        where x.correct;
        if jsonb_typeof(v_submitted) = 'array' then
          select coalesce(array_agg(distinct lower(trim(s)) order by lower(trim(s))), '{}')
            into v_sub_set
          from jsonb_array_elements_text(v_submitted) s;
        elsif v_submitted is not null then
          v_sub_set := array[lower(trim(v_submitted #>> '{}'))];
        else
          v_sub_set := '{}';
        end if;
        -- submitted option ids resolve against option ids; texts resolve
        -- against lower-cased option texts.
        if array_length(v_correct_set, 1) is not null and array_length(v_correct_set, 1) > 0 then
          v_correct := (
            select count(*) = array_length(v_correct_set, 1)
              and bool_and(v_sub_set @> array[lower(trim(x.id))])
            from unnest(v_correct_set) x(id)
          ) and array_length(v_sub_set, 1) = array_length(v_correct_set, 1);
        end if;
      else
        v_expected := v_question.correct_answer;
        if jsonb_typeof(v_expected) = 'array' then
          select coalesce(array_agg(distinct lower(trim(s)) order by lower(trim(s))), '{}')
            into v_correct_set
          from jsonb_array_elements_text(v_expected) s;
        elsif v_expected is not null then
          v_correct_set := array[lower(trim(v_expected #>> '{}'))];
        else
          v_correct_set := '{}';
        end if;
        if jsonb_typeof(v_submitted) = 'array' then
          select coalesce(array_agg(distinct lower(trim(s)) order by lower(trim(s))), '{}')
            into v_sub_set
          from jsonb_array_elements_text(v_submitted) s;
        elsif v_submitted is not null then
          v_sub_set := array[lower(trim(v_submitted #>> '{}'))];
        else
          v_sub_set := '{}';
        end if;
        v_correct := v_sub_set = v_correct_set and array_length(v_correct_set, 1) > 0;
      end if;
    else
      -- multiple_choice / true_false: single answer.
      if jsonb_typeof(v_options) = 'array' and jsonb_array_length(v_options) > 0 then
        if jsonb_typeof(v_submitted) = 'array' then
          v_item := v_submitted -> 0;
        else
          v_item := v_submitted;
        end if;
        if v_item is not null then
          -- match by option id first, then by text.
          select (x.correct) into v_correct
          from jsonb_to_recordset(v_options) as x(id text, text text, correct boolean)
          where x.id = (v_item #>> '{}')
          limit 1;
          if v_correct is null then
            select (x.correct) into v_correct
            from jsonb_to_recordset(v_options) as x(id text, text text, correct boolean)
            where lower(trim(x.text)) = lower(trim(v_item #>> '{}'))
            limit 1;
          end if;
          v_correct := coalesce(v_correct, false);
        end if;
      else
        v_expected := v_question.correct_answer;
        if jsonb_typeof(v_submitted) = 'array' then
          v_item := v_submitted -> 0;
        else
          v_item := v_submitted;
        end if;
        if v_item is not null and v_expected is not null then
          if jsonb_typeof(v_expected) = 'array' then
            v_correct := exists (
              select 1 from jsonb_array_elements_text(v_expected) e
              where lower(trim(e)) = lower(trim(v_item #>> '{}'))
            );
          else
            v_correct := lower(trim(v_expected #>> '{}')) = lower(trim(v_item #>> '{}'));
          end if;
        end if;
      end if;
    end if;

    if v_correct then
      v_right := v_right + 1;
    end if;

    v_results := v_results || jsonb_build_object(
      'question_id', v_question.id,
      'correct', coalesce(v_correct, false),
      'explanation', v_question.explanation
    );
  end loop;

  if v_total = 0 then
    raise exception 'QUIZ_EMPTY: this quiz has no questions yet';
  end if;

  v_score := round((v_right::numeric / v_total::numeric) * 100, 2);
  v_passed := v_score >= v_quiz.passing_score;

  insert into public.quiz_attempts
    (quiz_id, student_id, course_id, score, passed, total_questions, correct_count, answers, completed_at)
  values
    (p_quiz_id, p_student_id, v_quiz.course_id, v_score, v_passed, v_total, v_right, p_answers, now())
  returning id into v_attempt_id;

  return jsonb_build_object(
    'attempt_id', v_attempt_id,
    'quiz_id', p_quiz_id,
    'score', v_score,
    'passed', v_passed,
    'passing_score', v_quiz.passing_score,
    'correct_count', v_right,
    'total_questions', v_total,
    'results', v_results
  );
end;
$$;

create or replace function public.submit_quiz_attempt_for(p_quiz_id uuid, p_student_id uuid, p_answers jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  return public.grade_quiz_attempt(p_quiz_id, p_student_id, p_answers);
end;
$$;

create or replace function public.submit_quiz_attempt(p_quiz_id uuid, p_answers jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_student uuid;
begin
  v_student := public.current_profile_id();
  if v_student is null then
    raise exception 'NOT_AUTHENTICATED: sign in required';
  end if;
  return public.grade_quiz_attempt(p_quiz_id, v_student, p_answers);
end;
$$;

-- -----------------------------------------------------------------
-- check_course_completion — rules-aware completion + certification
-- -----------------------------------------------------------------
create or replace function public.check_course_completion(p_student_id uuid, p_course_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_total integer;
  v_done integer;
  v_pct numeric;
  v_rules record;
  v_required_pct integer := 100;
  v_quiz_avg numeric;
  v_live_quizzes integer;
  v_assignment_ok boolean := true;
  v_pending_assignments integer;
  v_final_ok boolean := true;
  v_final_required_score integer;
  v_final_quizzes integer;
  v_final_passed integer;
  v_enrollment_status public.enrollment_status;
  v_course_title text;
  v_certificate uuid;
  v_completed boolean := false;
  v_reasons text[] := array[]::text[];
begin
  select e.status into v_enrollment_status
  from public.enrollments e
  where e.student_id = p_student_id and e.course_id = p_course_id;

  -- Only ACTIVE enrollments can complete (COMPLETED stays completed).
  if v_enrollment_status is null or v_enrollment_status <> 'ACTIVE' then
    return jsonb_build_object('completed', v_enrollment_status = 'COMPLETED',
                              'status', v_enrollment_status, 'reasons', v_reasons);
  end if;

  select title into v_course_title from public.courses where id = p_course_id;

  select count(*) into v_total
  from public.lessons l
  join public.course_modules m on m.id = l.module_id
  where m.course_id = p_course_id and l.is_published;

  select count(*) into v_done
  from public.lesson_progress lp
  join public.lessons l on l.id = lp.lesson_id
  join public.course_modules m on m.id = l.module_id
  where lp.student_id = p_student_id
    and m.course_id = p_course_id
    and l.is_published
    and lp.completed;

  v_pct := case when v_total = 0 then 0 else round((v_done::numeric / v_total::numeric) * 100, 2) end;

  select * into v_rules
  from public.course_completion_rules
  where course_id = p_course_id;

  if v_rules is not null then
    v_required_pct := coalesce(v_rules.required_lesson_completion_percentage, 80);
  end if;

  if v_total = 0 or v_pct < v_required_pct then
    v_reasons := v_reasons || format('lessons %s/%s (%s%%, need %s%%)', v_done, v_total, v_pct, v_required_pct);
  end if;

  -- Quiz gate (only when rules demand it and live quizzes exist).
  if v_rules is not null and v_rules.minimum_quiz_score is not null then
    select count(*) into v_live_quizzes
    from public.quizzes
    where course_id = p_course_id and status in ('APPROVED', 'PUBLISHED');

    if v_live_quizzes > 0 then
      select round(avg(best.best_score), 2) into v_quiz_avg
      from (
        select q.id, max(qa.score) as best_score
        from public.quizzes q
        left join public.quiz_attempts qa
          on qa.quiz_id = q.id and qa.student_id = p_student_id
        where q.course_id = p_course_id and q.status in ('APPROVED', 'PUBLISHED')
        group by q.id
      ) best;

      if v_quiz_avg is null or v_quiz_avg < v_rules.minimum_quiz_score then
        v_reasons := v_reasons || format('quiz average %s%%, need %s%%',
                                         coalesce(v_quiz_avg, 0), v_rules.minimum_quiz_score);
      end if;
    end if;
  end if;

  -- Assignment gate.
  if v_rules is not null and coalesce(v_rules.assignment_required, false) then
    select count(*) into v_pending_assignments
    from public.assignments a
    where a.course_id = p_course_id
      and a.status in ('APPROVED', 'PUBLISHED')
      and not exists (
        select 1 from public.assignment_submissions s
        where s.assignment_id = a.id
          and s.student_id = p_student_id
          and s.status = 'GRADED'
          and coalesce(s.score, 0) >= coalesce(a.pass_score, 50)
      );

    if v_pending_assignments > 0 then
      v_assignment_ok := false;
      v_reasons := v_reasons || format('%s assignment(s) still need a passing grade', v_pending_assignments);
    end if;
  end if;

  -- Final-exam gate.
  if v_rules is not null
     and (coalesce(v_rules.final_project_required, false) or v_rules.final_assessment_score is not null) then
    v_final_required_score := coalesce(v_rules.final_assessment_score, 70);

    select count(*) into v_final_quizzes
    from public.quizzes q
    where q.course_id = p_course_id
      and q.status in ('APPROVED', 'PUBLISHED')
      and (q.scope = 'FINAL' or q.assessment_id is not null);

    if v_final_quizzes > 0 then
      select count(*) into v_final_passed
      from public.quizzes q
      where q.course_id = p_course_id
        and q.status in ('APPROVED', 'PUBLISHED')
        and (q.scope = 'FINAL' or q.assessment_id is not null)
        and exists (
          select 1 from public.quiz_attempts qa
          where qa.quiz_id = q.id and qa.student_id = p_student_id
            and qa.score >= v_final_required_score
        );

      if v_final_passed < v_final_quizzes then
        v_final_ok := false;
        v_reasons := v_reasons || format('final exam: %s/%s passed (need %s%%)',
                                         v_final_passed, v_final_quizzes, v_final_required_score);
      end if;
    end if;
  end if;

  if array_length(v_reasons, 1) is null then
    update public.enrollments
    set status = 'COMPLETED', completed_at = coalesce(completed_at, now())
    where student_id = p_student_id and course_id = p_course_id and status = 'ACTIVE';

    if found then
      v_completed := true;

      insert into public.notifications (user_id, title, message, type)
      values (
        p_student_id,
        'Course completed',
        'Congratulations! You have completed ' || coalesce(v_course_title, 'the course') || '. Your certificate is now available.',
        'COURSE_COMPLETED'
      );

      insert into public.certificates (student_id, course_id, certificate_number)
      values (p_student_id, p_course_id, public.next_certificate_number())
      on conflict (student_id, course_id) do nothing
      returning id into v_certificate;

      if v_certificate is not null then
        insert into public.notifications (user_id, title, message, type)
        values (
          p_student_id,
          'Certificate issued',
          'Your certificate for "' || coalesce(v_course_title, 'the course') || '" is ready. View and download it from your Certificates page.',
          'CERTIFICATE_ISSUED'
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'completed', v_completed,
    'lesson_percentage', v_pct,
    'required_lesson_percentage', v_required_pct,
    'quiz_average', v_quiz_avg,
    'assignments_ok', v_assignment_ok,
    'final_ok', v_final_ok,
    'reasons', coalesce(to_jsonb(v_reasons), '[]'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------
-- publish_course_content — cascade publish/unpublish (service/admin)
-- -----------------------------------------------------------------
create or replace function public.publish_course_content(p_course_id uuid, p_publish boolean)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_modules integer := 0;
  v_topics integer := 0;
  v_lessons integer := 0;
  v_contents integer := 0;
begin
  update public.courses
  set is_published = p_publish, updated_at = now()
  where id = p_course_id;

  if not found then
    raise exception 'COURSE_NOT_FOUND';
  end if;

  update public.course_topics
  set is_published = p_publish, updated_at = now()
  where course_id = p_course_id;
  get diagnostics v_topics = row_count;

  update public.lessons l
  set is_published = p_publish, updated_at = now()
  from public.course_modules m
  where m.id = l.module_id and m.course_id = p_course_id;
  get diagnostics v_lessons = row_count;

  update public.lesson_contents lc
  set is_published = p_publish, updated_at = now()
  from public.lessons l
  join public.course_modules m on m.id = l.module_id
  where lc.lesson_id = l.id and m.course_id = p_course_id;
  get diagnostics v_contents = row_count;

  select count(*) into v_modules
  from public.course_modules
  where course_id = p_course_id;

  return jsonb_build_object(
    'course_id', p_course_id,
    'published', p_publish,
    'modules', v_modules,
    'topics_updated', v_topics,
    'lessons_updated', v_lessons,
    'contents_updated', v_contents
  );
end;
$$;

-- -----------------------------------------------------------------
-- Atomic reordering for topics + lesson contents (mirrors 002)
-- -----------------------------------------------------------------
create or replace function public.reorder_topics(p_module_id uuid, p_topic_ids uuid[])
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_i integer := 0;
begin
  foreach v_id in array p_topic_ids loop
    v_i := v_i + 1;
    update public.course_topics
    set order_number = -v_i
    where id = v_id and module_id = p_module_id;
  end loop;

  v_i := 0;
  foreach v_id in array p_topic_ids loop
    v_i := v_i + 1;
    update public.course_topics
    set order_number = v_i
    where id = v_id and module_id = p_module_id;
  end loop;
end;
$$;

create or replace function public.reorder_lesson_contents(p_lesson_id uuid, p_content_ids uuid[])
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_i integer := 0;
begin
  foreach v_id in array p_content_ids loop
    v_i := v_i + 1;
    update public.lesson_contents
    set order_number = -v_i
    where id = v_id and lesson_id = p_lesson_id;
  end loop;

  v_i := 0;
  foreach v_id in array p_content_ids loop
    v_i := v_i + 1;
    update public.lesson_contents
    set order_number = v_i
    where id = v_id and lesson_id = p_lesson_id;
  end loop;
end;
$$;

-- =====================================================================
-- L. COMPLETION TRIGGERS — lessons, quizzes, graded assignments
-- =====================================================================

-- Reworked lesson trigger: keeps the module-milestone notification,
-- delegates the course-completion decision to check_course_completion()
-- (legacy 100%-lessons behaviour preserved when no rules row exists).
create or replace function public.handle_lesson_completion()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_course_title text;
  v_module_id uuid;
  v_module_title text;
  v_module_total integer;
  v_module_done integer;
begin
  if not (new.completed and (tg_op = 'INSERT' or old.completed is distinct from true)) then
    return new;
  end if;

  select title into v_course_title from public.courses where id = new.course_id;

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

  -- Rules-aware course completion (certificates issued inside).
  perform public.check_course_completion(new.student_id, new.course_id);

  return new;
end;
$$;

-- Every graded quiz attempt can complete the course.
create or replace function public.handle_quiz_attempt_completion()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.check_course_completion(new.student_id, new.course_id);
  return new;
end;
$$;

drop trigger if exists trg_quiz_attempt_completion on public.quiz_attempts;
create trigger trg_quiz_attempt_completion
  after insert on public.quiz_attempts
  for each row execute function public.handle_quiz_attempt_completion();

-- A graded assignment can complete the course.
create or replace function public.handle_submission_graded()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.status = 'GRADED' and old.status is distinct from 'GRADED' then
    perform public.check_course_completion(new.student_id, new.course_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_submission_graded on public.assignment_submissions;
create trigger trg_submission_graded
  after update on public.assignment_submissions
  for each row execute function public.handle_submission_graded();

-- =====================================================================
-- M. STORAGE — assignment submissions bucket (private)
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('assignment-submissions', 'assignment-submissions', false, 20971520,
     array['application/pdf', 'image/jpeg', 'image/png', 'application/zip',
           'text/plain',
           'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Convention: <student_user_id>/<submission_id>/<file>
drop policy if exists submissions_insert_owner on storage.objects;
create policy submissions_insert_owner on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'assignment-submissions'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists submissions_select_owner on storage.objects;
create policy submissions_select_owner on storage.objects
  for select to authenticated
  using (
    bucket_id = 'assignment-submissions'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  );

drop policy if exists submissions_admin_all on storage.objects;
create policy submissions_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'assignment-submissions' and public.is_admin())
  with check (bucket_id = 'assignment-submissions' and public.is_admin());

-- =====================================================================
-- N. GRANTS + STATISTICS EXTENSION
-- =====================================================================

-- Public outline: safe for everyone.
grant execute on function public.get_course_outline(uuid) to anon, authenticated, service_role;

-- Authenticated wrappers resolve identity from the JWT.
grant execute on function public.get_course_classroom(uuid) to authenticated, service_role;
grant execute on function public.get_quiz_for_student(uuid) to authenticated, service_role;
grant execute on function public.submit_quiz_attempt(uuid, jsonb) to authenticated, service_role;

-- Service-role-only internals (triggers execute them as owner).
revoke execute on function public.get_course_classroom_for_student(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.get_quiz_for_student_for(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.submit_quiz_attempt_for(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.grade_quiz_attempt(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.check_course_completion(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.publish_course_content(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.reorder_topics(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.reorder_lesson_contents(uuid, uuid[]) from public, anon, authenticated;

grant execute on function public.get_course_classroom_for_student(uuid, uuid) to service_role;
grant execute on function public.get_quiz_for_student_for(uuid, uuid) to service_role;
grant execute on function public.submit_quiz_attempt_for(uuid, uuid, jsonb) to service_role;
grant execute on function public.grade_quiz_attempt(uuid, uuid, jsonb) to service_role;
grant execute on function public.check_course_completion(uuid, uuid) to service_role;
grant execute on function public.publish_course_content(uuid, boolean) to service_role;
grant execute on function public.reorder_topics(uuid, uuid[]) to service_role;
grant execute on function public.reorder_lesson_contents(uuid, uuid[]) to service_role;

-- admin_statistics: additive curriculum keys only (existing keys untouched).
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
    'total_topics',        (select count(*) from public.course_topics),
    'total_lessons',       (select count(*) from public.lessons),
    'published_lessons',   (select count(*) from public.lessons where is_published),
    'total_contents',      (select count(*) from public.lesson_contents),
    'total_quizzes',       (select count(*) from public.quizzes),
    'live_quizzes',        (select count(*) from public.quizzes where status in ('APPROVED', 'PUBLISHED')),
    'total_assignments',   (select count(*) from public.assignments),
    'live_assignments',    (select count(*) from public.assignments where status in ('APPROVED', 'PUBLISHED')),
    'pending_submissions', (select count(*) from public.assignment_submissions where status in ('SUBMITTED', 'UNDER_REVIEW')),
    'total_assessments',   (select count(*) from public.course_assessments),
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

revoke execute on function public.admin_statistics() from public, anon, authenticated;
grant execute on function public.admin_statistics() to service_role;

-- =====================================================================
-- Migration 014 complete.
-- Verify: select public.get_course_outline((select id from courses limit 1));
-- =====================================================================

-- ---------------------------------------------------------------------
-- PART C. Bookkeeping: record 014 as applied (same as scripts/migrate.js does)
-- ---------------------------------------------------------------------

create table if not exists public._migrations (
  name        text primary key,
  executed_at timestamptz not null default now()
);
alter table public._migrations enable row level security;
revoke all on public._migrations from anon, authenticated;
grant all on public._migrations to service_role;

insert into public._migrations (name)
values ('20260910000014_lms_curriculum_engine.sql')
on conflict (name) do nothing;

-- Confirm: expect base_tables = 5 AND curriculum_tables = 8.
select
  (select count(*) from information_schema.tables where table_schema = 'public'
     and table_name in ('lessons', 'course_resources', 'lesson_videos',
       'lesson_practicals', 'lesson_content')) as base_tables,
  (select count(*) from information_schema.tables where table_schema = 'public'
     and table_name in ('course_topics', 'lessons', 'lesson_contents',
       'course_resources', 'lesson_videos', 'lesson_practicals',
       'quiz_options', 'course_assessments')) as curriculum_tables;
