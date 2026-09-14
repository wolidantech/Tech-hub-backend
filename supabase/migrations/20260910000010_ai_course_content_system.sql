-- =====================================================================
-- WOLI DAN TECH HUB
-- Migration 010: AI Course Content Generation & Delivery System
-- Production-ready curriculum pipeline with versioning, review, RAG
--
-- Reuses existing tables: course_modules, lessons, course_lessons, etc.
-- Creates missing tables if not exists, compatible with live project
-- which already has ai_conversations, ai_generated_content, ai_generation_jobs
-- =====================================================================

-- -----------------------------------------------------------------
-- Enums for AI system
-- -----------------------------------------------------------------
do $$ begin
  create type public.ai_job_type as enum (
    'COURSE', 'MODULE', 'LESSON', 'LESSON_TEXT', 'VIDEO_SCRIPT',
    'VIDEO', 'QUIZ', 'ASSIGNMENT', 'PRACTICAL', 'PROJECT',
    'RESOURCE', 'SUMMARY', 'NOTES', 'FLASHCARDS', 'EXERCISE',
    'COURSE_OUTLINE', 'BULK_MISSING'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_job_status as enum ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_content_type as enum (
    'COURSE_DESCRIPTION', 'LEARNING_OBJECTIVES', 'MODULE', 'LESSON',
    'LESSON_TEXT', 'VIDEO_SCRIPT', 'VIDEO', 'QUIZ', 'ASSIGNMENT',
    'PRACTICAL', 'PROJECT', 'RESOURCE', 'SUMMARY', 'NOTES', 'FLASHCARDS',
    'EXERCISE', 'EXAMPLE', 'READING_MATERIAL'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.content_status as enum ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.resource_type as enum (
    'VIDEO', 'PDF', 'ARTICLE', 'DOCUMENTATION', 'DATASET',
    'CODE', 'TEMPLATE', 'WEBSITE', 'BOOK', 'EXERCISE'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.video_job_status as enum ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------
-- ai_generation_jobs — long-running generation jobs (non-blocking)
-- -----------------------------------------------------------------
create table if not exists public.ai_generation_jobs (
  id                uuid primary key default gen_random_uuid(),
  job_type          public.ai_job_type not null,
  status            public.ai_job_status not null default 'QUEUED',
  input             jsonb not null default '{}'::jsonb,
  output            jsonb,
  error             text,
  course_id         uuid references public.courses(id) on delete cascade,
  module_id         uuid references public.course_modules(id) on delete cascade,
  lesson_id         uuid,
  -- lesson_id may reference lessons or course_lessons, so no FK constraint to allow both
  content_type      public.ai_content_type,
  provider          text,
  model             text,
  retry_count       integer not null default 0 check (retry_count >= 0),
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  constraint chk_job_status_times check (
    (status = 'QUEUED' and started_at is null and completed_at is null) or
    (status = 'PROCESSING' and started_at is not null and completed_at is null) or
    (status in ('COMPLETED','FAILED','CANCELLED') and completed_at is not null)
  )
);

create index if not exists idx_ai_jobs_status on public.ai_generation_jobs (status);
create index if not exists idx_ai_jobs_type on public.ai_generation_jobs (job_type);
create index if not exists idx_ai_jobs_course on public.ai_generation_jobs (course_id);
create index if not exists idx_ai_jobs_created_by on public.ai_generation_jobs (created_by);
create index if not exists idx_ai_jobs_created_at on public.ai_generation_jobs (created_at desc);

-- -----------------------------------------------------------------
-- ai_generated_content — versioned AI content with review pipeline
-- -----------------------------------------------------------------
create table if not exists public.ai_generated_content (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid references public.ai_generation_jobs(id) on delete set null,
  course_id         uuid references public.courses(id) on delete cascade,
  module_id         uuid references public.course_modules(id) on delete cascade,
  lesson_id         uuid,
  content_type      public.ai_content_type not null,
  content           jsonb not null,
  version           integer not null default 1 check (version > 0),
  status            public.content_status not null default 'DRAFT',
  quality_flags     jsonb default '[]'::jsonb,
  quality_score     numeric(3,2) check (quality_score is null or (quality_score >= 0 and quality_score <= 1)),
  generated_by      uuid references public.profiles(id) on delete set null,
  generated_at      timestamptz not null default now(),
  approved_by       uuid references public.profiles(id) on delete set null,
  approved_at       timestamptz,
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_content_version unique (course_id, module_id, lesson_id, content_type, version),
  constraint chk_approval check (
    (status in ('APPROVED','PUBLISHED') and approved_by is not null and approved_at is not null) or
    (status not in ('APPROVED','PUBLISHED'))
  )
);

create index if not exists idx_ai_content_course on public.ai_generated_content (course_id);
create index if not exists idx_ai_content_module on public.ai_generated_content (module_id);
create index if not exists idx_ai_content_lesson on public.ai_generated_content (lesson_id);
create index if not exists idx_ai_content_type on public.ai_generated_content (content_type);
create index if not exists idx_ai_content_status on public.ai_generated_content (status);
create index if not exists idx_ai_content_version on public.ai_generated_content (course_id, content_type, version desc);

-- -----------------------------------------------------------------
-- course_resources — external and internal resources library
-- -----------------------------------------------------------------
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

-- -----------------------------------------------------------------
-- lesson_videos — video generation jobs and metadata
-- -----------------------------------------------------------------
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

-- -----------------------------------------------------------------
-- lesson_practicals — practical exercises
-- -----------------------------------------------------------------
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

-- -----------------------------------------------------------------
-- course_projects — final projects
-- -----------------------------------------------------------------
create table if not exists public.course_projects (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references public.courses(id) on delete cascade,
  title             text not null,
  scenario          text,
  objective         text not null,
  requirements      text not null,
  deliverables      text not null,
  evaluation_criteria jsonb default '[]'::jsonb,
  submission_format text,
  recommended_tools text,
  difficulty        public.difficulty_level not null default 'INTERMEDIATE',
  is_final          boolean not null default false,
  status            public.content_status not null default 'DRAFT',
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_projects_course on public.course_projects (course_id);
create index if not exists idx_projects_final on public.course_projects (is_final) where is_final = true;

-- -----------------------------------------------------------------
-- course_completion_rules — defines what is required to complete
-- -----------------------------------------------------------------
create table if not exists public.course_completion_rules (
  id                                uuid primary key default gen_random_uuid(),
  course_id                         uuid not null unique references public.courses(id) on delete cascade,
  required_lesson_completion_percentage integer not null default 80 check (required_lesson_completion_percentage between 0 and 100),
  minimum_quiz_score                integer check (minimum_quiz_score is null or (minimum_quiz_score between 0 and 100)),
  assignment_required               boolean not null default false,
  final_project_required            boolean not null default false,
  final_assessment_score            integer check (final_assessment_score is null or (final_assessment_score between 0 and 100)),
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now()
);

-- -----------------------------------------------------------------
-- lesson_content — RAG-ready chunks for DanTECH AI
-- -----------------------------------------------------------------
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
-- assignments — if not exists (some projects have it)
-- -----------------------------------------------------------------
create table if not exists public.assignments (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references public.courses(id) on delete cascade,
  module_id         uuid references public.course_modules(id) on delete cascade,
  lesson_id         uuid,
  title             text not null,
  description       text not null,
  instructions      text not null,
  requirements      text,
  expected_output   text,
  difficulty        public.difficulty_level not null default 'BEGINNER',
  estimated_time    integer,
  submission_type   text,
  evaluation_criteria jsonb,
  status            public.content_status not null default 'DRAFT',
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_assignments_course on public.assignments (course_id);
create index if not exists idx_assignments_lesson on public.assignments (lesson_id);

-- -----------------------------------------------------------------
-- quizzes and quiz_questions — if not exists
-- -----------------------------------------------------------------
create table if not exists public.quizzes (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references public.courses(id) on delete cascade,
  module_id         uuid references public.course_modules(id) on delete cascade,
  lesson_id         uuid,
  title             text not null,
  description       text,
  passing_score     integer default 70 check (passing_score between 0 and 100),
  time_limit        integer,
  status            public.content_status not null default 'DRAFT',
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.quiz_questions (
  id                uuid primary key default gen_random_uuid(),
  quiz_id           uuid not null references public.quizzes(id) on delete cascade,
  question          text not null,
  question_type     text not null default 'multiple_choice' check (question_type in ('multiple_choice','true_false','multiple_answer')),
  options           jsonb not null default '[]'::jsonb,
  correct_answer    jsonb,
  explanation       text,
  difficulty        public.difficulty_level not null default 'BEGINNER',
  topic             text,
  order_number      integer not null default 1,
  created_at        timestamptz not null default now()
);

create index if not exists idx_quizzes_course on public.quizzes (course_id);
create index if not exists idx_quiz_questions_quiz on public.quiz_questions (quiz_id);

-- -----------------------------------------------------------------
-- Updated_at triggers
-- -----------------------------------------------------------------
drop trigger if exists trg_ai_jobs_updated_at on public.ai_generation_jobs;
create trigger trg_ai_jobs_updated_at before update on public.ai_generation_jobs
  for each row execute function public.set_updated_at();

drop trigger if exists trg_ai_content_updated_at on public.ai_generated_content;
create trigger trg_ai_content_updated_at before update on public.ai_generated_content
  for each row execute function public.set_updated_at();

drop trigger if exists trg_course_resources_updated_at on public.course_resources;
create trigger trg_course_resources_updated_at before update on public.course_resources
  for each row execute function public.set_updated_at();

drop trigger if exists trg_lesson_videos_updated_at on public.lesson_videos;
create trigger trg_lesson_videos_updated_at before update on public.lesson_videos
  for each row execute function public.set_updated_at();

drop trigger if exists trg_lesson_practicals_updated_at on public.lesson_practicals;
create trigger trg_lesson_practicals_updated_at before update on public.lesson_practicals
  for each row execute function public.set_updated_at();

drop trigger if exists trg_course_projects_updated_at on public.course_projects;
create trigger trg_course_projects_updated_at before update on public.course_projects
  for each row execute function public.set_updated_at();

drop trigger if exists trg_completion_rules_updated_at on public.course_completion_rules;
create trigger trg_completion_rules_updated_at before update on public.course_completion_rules
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------
alter table public.ai_generation_jobs enable row level security;
alter table public.ai_generated_content enable row level security;
alter table public.course_resources enable row level security;
alter table public.lesson_videos enable row level security;
alter table public.lesson_practicals enable row level security;
alter table public.course_projects enable row level security;
alter table public.course_completion_rules enable row level security;
alter table public.lesson_content enable row level security;
alter table public.assignments enable row level security;
alter table public.quizzes enable row level security;
alter table public.quiz_questions enable row level security;

-- Policies: students can only see APPROVED/PUBLISHED content, admins see all
-- ai_generation_jobs: admin only
drop policy if exists ai_jobs_admin_all on public.ai_generation_jobs;
create policy ai_jobs_admin_all on public.ai_generation_jobs for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ai_generated_content: students see APPROVED/PUBLISHED, admins all
drop policy if exists ai_content_public_read on public.ai_generated_content;
create policy ai_content_public_read on public.ai_generated_content for select to authenticated using (
  status in ('APPROVED','PUBLISHED') or public.is_admin()
);
drop policy if exists ai_content_admin_write on public.ai_generated_content;
create policy ai_content_admin_write on public.ai_generated_content for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- course_resources: students see approved, admins all
drop policy if exists course_resources_public_read on public.course_resources;
create policy course_resources_public_read on public.course_resources for select to authenticated using (is_approved = true or public.is_admin());
drop policy if exists course_resources_admin_write on public.course_resources;
create policy course_resources_admin_write on public.course_resources for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- lesson_videos: students see COMPLETED videos for published courses
drop policy if exists lesson_videos_read on public.lesson_videos;
create policy lesson_videos_read on public.lesson_videos for select to authenticated using (
  (status = 'COMPLETED' and exists (select 1 from public.courses c where c.id = lesson_videos.course_id and c.is_published)) or public.is_admin()
);
drop policy if exists lesson_videos_admin_write on public.lesson_videos;
create policy lesson_videos_admin_write on public.lesson_videos for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- lesson_practicals: similar
drop policy if exists practicals_read on public.lesson_practicals;
create policy practicals_read on public.lesson_practicals for select to authenticated using (status in ('APPROVED','PUBLISHED') or public.is_admin());
drop policy if exists practicals_admin_write on public.lesson_practicals;
create policy practicals_admin_write on public.lesson_practicals for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- course_projects
drop policy if exists projects_read on public.course_projects;
create policy projects_read on public.course_projects for select to authenticated using (status in ('APPROVED','PUBLISHED') or public.is_admin());
drop policy if exists projects_admin_write on public.course_projects;
create policy projects_admin_write on public.course_projects for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- completion rules: public read, admin write
drop policy if exists completion_rules_read on public.course_completion_rules;
create policy completion_rules_read on public.course_completion_rules for select to anon, authenticated using (true);
drop policy if exists completion_rules_admin_write on public.course_completion_rules;
create policy completion_rules_admin_write on public.course_completion_rules for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- lesson_content: RAG — only approved content visible for search
drop policy if exists lesson_content_read on public.lesson_content;
create policy lesson_content_read on public.lesson_content for select to authenticated using (is_approved = true or public.is_admin());
drop policy if exists lesson_content_admin_write on public.lesson_content;
create policy lesson_content_admin_write on public.lesson_content for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- assignments, quizzes, questions: similar
drop policy if exists assignments_read on public.assignments;
create policy assignments_read on public.assignments for select to authenticated using (status in ('APPROVED','PUBLISHED') or public.is_admin());
drop policy if exists assignments_admin_write on public.assignments;
create policy assignments_admin_write on public.assignments for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists quizzes_read on public.quizzes;
create policy quizzes_read on public.quizzes for select to authenticated using (status in ('APPROVED','PUBLISHED') or public.is_admin());
drop policy if exists quizzes_admin_write on public.quizzes;
create policy quizzes_admin_write on public.quizzes for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists quiz_questions_read on public.quiz_questions;
create policy quiz_questions_read on public.quiz_questions for select to authenticated using (
  exists (select 1 from public.quizzes q where q.id = quiz_questions.quiz_id and (q.status in ('APPROVED','PUBLISHED') or public.is_admin()))
);
drop policy if exists quiz_questions_admin_write on public.quiz_questions;
create policy quiz_questions_admin_write on public.quiz_questions for all to authenticated using (public.is_admin()) with check (public.is_admin());
