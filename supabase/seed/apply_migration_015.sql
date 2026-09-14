-- =====================================================================
-- STEP 1 (paste SECOND, click Run): migration 015 + bookkeeping.
-- Adds seed_key columns + metadata JSONB envelopes + partial unique
-- indexes. Fully idempotent — safe to run more than once.
--
-- Source of truth: supabase/migrations/20260910000015_seed_keys.sql
-- (content below is identical; only this header + bookkeeping added)
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. seed_key columns (stable identity for idempotent upserts)
-- ---------------------------------------------------------------------

alter table public.course_modules     add column if not exists seed_key text;
alter table public.course_topics      add column if not exists seed_key text;
alter table public.lessons            add column if not exists seed_key text;
alter table public.lesson_contents    add column if not exists seed_key text;
alter table public.course_resources   add column if not exists seed_key text;
alter table public.lesson_videos      add column if not exists seed_key text;
alter table public.lesson_practicals  add column if not exists seed_key text;
alter table public.assignments        add column if not exists seed_key text;
alter table public.quizzes            add column if not exists seed_key text;
alter table public.quiz_questions     add column if not exists seed_key text;
alter table public.quiz_options       add column if not exists seed_key text;
alter table public.course_assessments add column if not exists seed_key text;

-- NOTE: courses already have a stable unique key (slug) — no seed_key needed.

-- Partial unique indexes: only seeded rows (seed_key IS NOT NULL) are
-- constrained. The seed's ON CONFLICT clauses target these indexes
-- with the matching predicate:
--   on conflict (seed_key) where seed_key is not null do update ...

create unique index if not exists uq_modules_seed_key
  on public.course_modules (seed_key) where seed_key is not null;
create unique index if not exists uq_topics_seed_key
  on public.course_topics (seed_key) where seed_key is not null;
create unique index if not exists uq_lessons_seed_key
  on public.lessons (seed_key) where seed_key is not null;
create unique index if not exists uq_lesson_contents_seed_key
  on public.lesson_contents (seed_key) where seed_key is not null;
create unique index if not exists uq_course_resources_seed_key
  on public.course_resources (seed_key) where seed_key is not null;
create unique index if not exists uq_lesson_videos_seed_key
  on public.lesson_videos (seed_key) where seed_key is not null;
create unique index if not exists uq_practicals_seed_key
  on public.lesson_practicals (seed_key) where seed_key is not null;
create unique index if not exists uq_assignments_seed_key
  on public.assignments (seed_key) where seed_key is not null;
create unique index if not exists uq_quizzes_seed_key
  on public.quizzes (seed_key) where seed_key is not null;
create unique index if not exists uq_quiz_questions_seed_key
  on public.quiz_questions (seed_key) where seed_key is not null;
create unique index if not exists uq_quiz_options_seed_key
  on public.quiz_options (seed_key) where seed_key is not null;
create unique index if not exists uq_assessments_seed_key
  on public.course_assessments (seed_key) where seed_key is not null;

comment on column public.course_modules.seed_key is 'Stable seed identity (<slug>:modNN...). Upserted by npm run seed; NULL for manually created rows.';
comment on column public.lessons.seed_key is 'Stable seed identity. Upserted by npm run seed; NULL for manually created rows.';

-- ---------------------------------------------------------------------
-- B. metadata JSONB envelopes (extended content-model fields)
-- ---------------------------------------------------------------------

alter table public.courses         add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.course_modules  add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.course_topics   add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.lessons         add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.quizzes         add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.quiz_questions  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.courses.metadata is 'Extended catalogue fields (short_description, study_hours, skills_gained, ...). See docs/COURSE_SEED_SYSTEM.md.';
comment on column public.quiz_questions.metadata is 'Extended grading fields (points, topic_tag). Points default to 1 when absent.';

-- ---------------------------------------------------------------------
-- C. Bookkeeping: record 015 as applied (same as scripts/migrate.js does)
-- ---------------------------------------------------------------------

-- Identical definition to scripts/migrate.js (name PK + executed_at).
create table if not exists public._migrations (
  name        text primary key,
  executed_at timestamptz not null default now()
);
alter table public._migrations enable row level security;
revoke all on public._migrations from anon, authenticated;
grant all on public._migrations to service_role;

insert into public._migrations (name)
values ('20260910000015_seed_keys.sql')
on conflict (name) do nothing;

-- Confirm: expect 12 (one seed_key column per curriculum table).
select count(*) as seed_key_columns_added
from information_schema.columns
where table_schema = 'public' and column_name = 'seed_key';
