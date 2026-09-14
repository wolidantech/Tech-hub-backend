-- =====================================================================
-- WOLI DAN TECH HUB — LEARN • BUILD • GROW
-- Migration 015: Course seed system support (idempotency keys + metadata)
-- =====================================================================
--
-- The production course seed system (supabase/seed/courses/*.json, applied
-- with `npm run seed`) upserts every row by a stable `seed_key` so that
-- re-running the seed NEVER duplicates content — it refreshes it in place.
--
--   seed_key format:  <course-slug>:mod01[:top02[:les03[:blk04]]][:quiz][:q05]...
--   Example:          biology:mod02:top01:les02:blk01
--
-- This migration is purely additive (new nullable columns + partial unique
-- indexes). Manually created rows keep seed_key NULL and are untouched by
-- the partial indexes and by the seed runner.
--
-- It also adds `metadata` JSONB envelopes for the extended course/
-- module/topic/lesson/quiz fields required by the LMS content model
-- (short description, study hours, skills, attempt limits, points...).
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
-- constrained. The seed runner's ON CONFLICT clauses target these indexes
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
-- courses.metadata:        short_description, subcategory, study_hours,
--                          target_audience, skills_gained, requirements,
--                          instructor_name, icon, syllabus_version
-- course_modules.metadata: objectives, duration_text, study_hours, icon
-- course_topics.metadata:  objectives, duration_text
-- lessons.metadata:        objectives, introduction, key_points, references
-- quizzes.metadata:        attempt_limit, points_total, shuffle_questions
-- quiz_questions.metadata: points, topic_tag

alter table public.courses         add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.course_modules  add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.course_topics   add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.lessons         add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.quizzes         add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.quiz_questions  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.courses.metadata is 'Extended catalogue fields (short_description, study_hours, skills_gained, ...). See docs/COURSE_SEED_SYSTEM.md.';
comment on column public.quiz_questions.metadata is 'Extended grading fields (points, topic_tag). Points default to 1 when absent.';

-- ---------------------------------------------------------------------
-- NOTE on compatibility views: lesson_resources is `select *` over
-- course_resources, and course_lessons / course_content enumerate only
-- the columns they project. Adding nullable columns to the base tables
-- neither breaks those views nor leaks seed internals into them, so no
-- view changes are required here.
-- ---------------------------------------------------------------------
