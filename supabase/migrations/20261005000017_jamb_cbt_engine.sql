-- =====================================================================
-- WOLI DAN TECH HUB — Paid JAMB/UTME CBT engine
-- Migration 017: Subjects, syllabus versions, exam templates, private
-- question bank, immutable attempts, timed server-side grading.
--
-- Only subject and syllabus metadata are seeded here. No historical JAMB
-- question text is copied or invented. The admin import API accepts only
-- original material or material with verified reuse rights. Legacy installs
-- can use the draft course from migration 016; the live frontend uses a paid
-- bundles.kind='exam_access' entitlement from frontend migration 011. Set
-- JAMB_ACCESS_MODE=bundle for that target and apply only after migrations 001-011.
-- =====================================================================

do $$ begin
  create type public.content_status as enum ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.difficulty_level as enum ('BEGINNER', 'INTERMEDIATE', 'ADVANCED');
exception when duplicate_object then null; end $$;

create table if not exists public.jamb_subjects (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  name                text not null unique,
  description         text,
  official_source_url text not null default 'https://ibass.jamb.gov.ng/e-syllabus',
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.jamb_syllabus_versions (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references public.jamb_subjects(id) on delete cascade,
  exam_year   integer not null check (exam_year between 2000 and 2100),
  version_label text not null,
  source_url  text not null,
  topics      jsonb not null default '[]'::jsonb check (jsonb_typeof(topics) = 'array'),
  is_current  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint uq_jamb_syllabus_subject_year unique (subject_id, exam_year)
);

create unique index if not exists uq_jamb_syllabus_one_current
  on public.jamb_syllabus_versions (subject_id) where is_current;

create table if not exists public.jamb_exams (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique,
  title                 text not null,
  description           text,
  instructions          text,
  mode                  text not null check (mode in ('PRACTICE', 'MOCK')),
  syllabus_year         integer not null check (syllabus_year between 2000 and 2100),
  time_limit_minutes    integer not null check (time_limit_minutes between 1 and 360),
  max_attempts          integer check (max_attempts is null or max_attempts > 0),
  mock_elective_count   integer not null default 3 check (mock_elective_count between 1 and 3),
  status                public.content_status not null default 'DRAFT',
  access_course_id      uuid references public.courses(id) on delete restrict,
  access_bundle_id      uuid,
  shuffle_questions     boolean not null default true,
  created_by            uuid references public.profiles(id) on delete set null,
  reviewed_by           uuid references public.profiles(id) on delete set null,
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint chk_jamb_exam_access_product check (num_nonnulls(access_course_id, access_bundle_id) = 1)
);

-- Migration 011 in the frontend project creates bundles. Keep the bundle FK
-- conditional so this same feature suite remains testable in the legacy schema.
alter table public.jamb_exams add column if not exists access_bundle_id uuid;
alter table public.jamb_exams alter column access_course_id drop not null;
alter table public.jamb_exams drop constraint if exists chk_jamb_exam_access_product;
alter table public.jamb_exams add constraint chk_jamb_exam_access_product
  check (num_nonnulls(access_course_id, access_bundle_id) = 1);
do $$ begin
  if to_regclass('public.bundles') is not null
     and not exists (
       select 1 from pg_constraint
       where conrelid = 'public.jamb_exams'::regclass and conname = 'fk_jamb_exam_access_bundle'
     ) then
    alter table public.jamb_exams add constraint fk_jamb_exam_access_bundle
      foreign key (access_bundle_id) references public.bundles(id) on delete restrict;
  end if;
end $$;

create table if not exists public.jamb_exam_sections (
  id                    uuid primary key default gen_random_uuid(),
  exam_id               uuid not null references public.jamb_exams(id) on delete cascade,
  subject_id            uuid not null references public.jamb_subjects(id) on delete restrict,
  syllabus_version_id   uuid not null references public.jamb_syllabus_versions(id) on delete restrict,
  question_count        integer not null check (question_count between 1 and 200),
  is_required           boolean not null default false,
  order_number          integer not null default 1 check (order_number > 0),
  constraint uq_jamb_exam_section_order unique (exam_id, order_number),
  constraint uq_jamb_exam_subject unique (exam_id, subject_id)
);

create table if not exists public.jamb_questions (
  id                    uuid primary key default gen_random_uuid(),
  question_key          text unique,
  subject_id            uuid not null references public.jamb_subjects(id) on delete restrict,
  syllabus_version_id   uuid not null references public.jamb_syllabus_versions(id) on delete restrict,
  exam_year             integer check (exam_year is null or exam_year between 2000 and 2100),
  topic                 text,
  question              text not null,
  explanation           text not null,
  difficulty            public.difficulty_level not null default 'BEGINNER',
  source_type           text not null default 'ORIGINAL' check (source_type in ('ORIGINAL', 'LICENSED')),
  source_name           text,
  source_url            text,
  license_name          text,
  rights_verified       boolean not null default false,
  status                public.content_status not null default 'DRAFT',
  created_by            uuid references public.profiles(id) on delete set null,
  reviewed_by           uuid references public.profiles(id) on delete set null,
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_jamb_questions_subject_year
  on public.jamb_questions (subject_id, syllabus_version_id, exam_year)
  where status = 'PUBLISHED';
create index if not exists idx_jamb_questions_status on public.jamb_questions (status, subject_id);

create table if not exists public.jamb_question_options (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references public.jamb_questions(id) on delete cascade,
  option_text  text not null,
  is_correct   boolean not null default false,
  order_number integer not null check (order_number between 1 and 4),
  created_at   timestamptz not null default now(),
  constraint uq_jamb_question_option_order unique (question_id, order_number)
);

create table if not exists public.jamb_exam_attempts (
  id               uuid primary key default gen_random_uuid(),
  exam_id          uuid not null references public.jamb_exams(id) on delete restrict,
  student_id       uuid not null references public.profiles(id) on delete cascade,
  status           text not null default 'IN_PROGRESS'
    check (status in ('IN_PROGRESS', 'SUBMITTED', 'EXPIRED')),
  started_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  submitted_at     timestamptz,
  total_questions  integer not null default 0 check (total_questions >= 0),
  correct_count    integer not null default 0 check (correct_count >= 0),
  selected_subject_codes text[] not null default '{}',
  score            numeric(5, 2) not null default 0 check (score between 0 and 100),
  created_at       timestamptz not null default now(),
  constraint chk_jamb_attempt_completion check (
    (status = 'IN_PROGRESS' and submitted_at is null)
    or (status in ('SUBMITTED', 'EXPIRED') and submitted_at is not null)
  )
);

create index if not exists idx_jamb_attempts_student on public.jamb_exam_attempts (student_id, created_at desc);
create index if not exists idx_jamb_attempts_exam on public.jamb_exam_attempts (exam_id, status);

-- The options/question/correct-answer snapshot is private. Students get it
-- only via the API: correct_option_id_snapshot is never sent before submit.
create table if not exists public.jamb_exam_attempt_items (
  id                            uuid primary key default gen_random_uuid(),
  attempt_id                    uuid not null references public.jamb_exam_attempts(id) on delete cascade,
  question_id                   uuid not null references public.jamb_questions(id) on delete restrict,
  subject_id                    uuid not null references public.jamb_subjects(id) on delete restrict,
  order_number                  integer not null check (order_number > 0),
  question_snapshot             text not null,
  options_snapshot              jsonb not null check (jsonb_typeof(options_snapshot) = 'array'),
  correct_option_id_snapshot    uuid not null,
  explanation_snapshot          text not null,
  selected_option_id            uuid,
  is_correct                    boolean,
  answered_at                   timestamptz,
  constraint uq_jamb_attempt_item_order unique (attempt_id, order_number),
  constraint uq_jamb_attempt_question unique (attempt_id, question_id)
);

create index if not exists idx_jamb_attempt_items_attempt on public.jamb_exam_attempt_items (attempt_id, order_number);

-- ---------------------------------------------------------------------
-- Current subject catalogue. The live IBASS page is the maintenance
-- source; this idempotent baseline is for the 2026 UTME selector. Update
-- names/availability from the official JAMB portal each exam cycle.
-- ---------------------------------------------------------------------
insert into public.jamb_subjects (code, name, description, official_source_url) values
  ('AGRIC', 'Agricultural Science', 'UTME agricultural science syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('ARABIC', 'Arabic', 'UTME Arabic language syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('ART', 'Art', 'UTME Art syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('BIOLOGY', 'Biology', 'UTME biology syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('CHEMISTRY', 'Chemistry', 'UTME chemistry syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('CRS', 'Christian Religious Studies', 'UTME Christian Religious Studies syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('COMMERCE', 'Commerce', 'UTME commerce syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('COMPUTER-STUDIES', 'Computer Studies', 'UTME computer studies syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('ECONOMICS', 'Economics', 'UTME economics syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('FRENCH', 'French', 'UTME French syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('GEOGRAPHY', 'Geography', 'UTME geography syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('GOVERNMENT', 'Government', 'UTME government syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('HAUSA', 'Hausa', 'UTME Hausa syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('HISTORY', 'History', 'UTME history syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('HOME-ECONOMICS', 'Home Economics', 'UTME home economics syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('IGBO', 'Igbo', 'UTME Igbo syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('ISLAMIC-STUDIES', 'Islamic Studies', 'UTME Islamic Studies syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('LITERATURE', 'Literature in English', 'UTME Literature in English syllabus and practice. Prescribed texts may change by exam year.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('MATHEMATICS', 'Mathematics', 'UTME mathematics syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('MUSIC', 'Music', 'UTME music syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('PHE', 'Physical and Health Education', 'UTME physical and health education syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('PHYSICS', 'Physics', 'UTME physics syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('PRINCIPLES-OF-ACCOUNTS', 'Principles of Accounts', 'UTME Principles of Accounts syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('USE-OF-ENGLISH', 'Use of English', 'UTME Use of English syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus'),
  ('YORUBA', 'Yoruba', 'UTME Yoruba syllabus and practice.', 'https://ibass.jamb.gov.ng/e-syllabus')
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  official_source_url = excluded.official_source_url;

insert into public.jamb_syllabus_versions (subject_id, exam_year, version_label, source_url, is_current)
select s.id, 2026, 'UTME 2026', 'https://ibass.jamb.gov.ng/e-syllabus', true
from public.jamb_subjects s
on conflict (subject_id, exam_year) do update set
  version_label = excluded.version_label,
  source_url = excluded.source_url;

-- ---------------------------------------------------------------------
-- RLS. Public clients can read only subject/syllabus/exam metadata.
-- Question correctness, question payloads and attempts are API-only.
-- ---------------------------------------------------------------------
alter table public.jamb_subjects enable row level security;
alter table public.jamb_syllabus_versions enable row level security;
alter table public.jamb_exams enable row level security;
alter table public.jamb_exam_sections enable row level security;
alter table public.jamb_questions enable row level security;
alter table public.jamb_question_options enable row level security;
alter table public.jamb_exam_attempts enable row level security;
alter table public.jamb_exam_attempt_items enable row level security;

drop policy if exists jamb_subjects_read on public.jamb_subjects;
create policy jamb_subjects_read on public.jamb_subjects for select to anon, authenticated
  using (is_active or public.is_admin());
drop policy if exists jamb_subjects_admin_write on public.jamb_subjects;
create policy jamb_subjects_admin_write on public.jamb_subjects for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists jamb_syllabus_read on public.jamb_syllabus_versions;
create policy jamb_syllabus_read on public.jamb_syllabus_versions for select to anon, authenticated
  using (is_current or public.is_admin());
drop policy if exists jamb_syllabus_admin_write on public.jamb_syllabus_versions;
create policy jamb_syllabus_admin_write on public.jamb_syllabus_versions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists jamb_exams_read on public.jamb_exams;
create policy jamb_exams_read on public.jamb_exams for select to anon, authenticated
  using (status = 'PUBLISHED' or public.is_admin());
drop policy if exists jamb_exams_admin_write on public.jamb_exams;
create policy jamb_exams_admin_write on public.jamb_exams for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists jamb_sections_read on public.jamb_exam_sections;
create policy jamb_sections_read on public.jamb_exam_sections for select to anon, authenticated
  using (exists (select 1 from public.jamb_exams e where e.id = exam_id and (e.status = 'PUBLISHED' or public.is_admin())));
drop policy if exists jamb_sections_admin_write on public.jamb_exam_sections;
create policy jamb_sections_admin_write on public.jamb_exam_sections for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Deliberately no public/authenticated policies on bank/attempt tables.
revoke all on public.jamb_questions, public.jamb_question_options,
  public.jamb_exam_attempts, public.jamb_exam_attempt_items from anon, authenticated;
grant select on public.jamb_subjects, public.jamb_syllabus_versions,
  public.jamb_exams, public.jamb_exam_sections to anon, authenticated;

create or replace function public.set_jamb_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists trg_jamb_subjects_updated_at on public.jamb_subjects;
create trigger trg_jamb_subjects_updated_at before update on public.jamb_subjects
  for each row execute function public.set_jamb_updated_at();
drop trigger if exists trg_jamb_syllabus_updated_at on public.jamb_syllabus_versions;
create trigger trg_jamb_syllabus_updated_at before update on public.jamb_syllabus_versions
  for each row execute function public.set_jamb_updated_at();
drop trigger if exists trg_jamb_exams_updated_at on public.jamb_exams;
create trigger trg_jamb_exams_updated_at before update on public.jamb_exams
  for each row execute function public.set_jamb_updated_at();
drop trigger if exists trg_jamb_questions_updated_at on public.jamb_questions;
create trigger trg_jamb_questions_updated_at before update on public.jamb_questions
  for each row execute function public.set_jamb_updated_at();

-- Enforce that sections use the same subject as their syllabus version.
create or replace function public.validate_jamb_exam_section()
returns trigger language plpgsql set search_path = public as $$
declare v_subject_id uuid;
begin
  select subject_id into v_subject_id from public.jamb_syllabus_versions where id = new.syllabus_version_id;
  if v_subject_id is null or v_subject_id <> new.subject_id then
    raise exception 'JAMB_SYLLABUS_SUBJECT_MISMATCH';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_jamb_exam_section_validate on public.jamb_exam_sections;
create trigger trg_jamb_exam_section_validate before insert or update of subject_id, syllabus_version_id
  on public.jamb_exam_sections for each row execute function public.validate_jamb_exam_section();

-- A question can only become live after it has four options, exactly one
-- correct choice, and source rights are established for non-original work.
create or replace function public.validate_jamb_question_publish()
returns trigger language plpgsql set search_path = public as $$
declare v_options integer; v_correct integer; v_option_subject uuid; v_version_subject uuid;
begin
  if new.status = 'PUBLISHED' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if new.reviewed_by is null then raise exception 'JAMB_REVIEWER_REQUIRED'; end if;
    select count(*), count(*) filter (where is_correct)
      into v_options, v_correct
    from public.jamb_question_options where question_id = new.id;
    if v_options <> 4 or v_correct <> 1 then
      raise exception 'JAMB_QUESTION_REQUIRES_FOUR_OPTIONS_AND_ONE_ANSWER';
    end if;
    if new.source_type = 'LICENSED'
       and (not new.rights_verified or nullif(trim(new.source_name), '') is null
            or nullif(trim(new.source_url), '') is null
            or nullif(trim(new.license_name), '') is null) then
      raise exception 'JAMB_QUESTION_LICENSE_NOT_VERIFIED';
    end if;
    select subject_id into v_version_subject
      from public.jamb_syllabus_versions where id = new.syllabus_version_id;
    if v_version_subject is distinct from new.subject_id then
      raise exception 'JAMB_QUESTION_SYLLABUS_SUBJECT_MISMATCH';
    end if;
    new.reviewed_at := coalesce(new.reviewed_at, now());
  end if;
  return new;
end;
$$;
drop trigger if exists trg_jamb_question_publish on public.jamb_questions;
create trigger trg_jamb_question_publish before insert or update of status, syllabus_version_id, subject_id
  on public.jamb_questions for each row execute function public.validate_jamb_question_publish();

-- A mock/practice template cannot be published without enough approved
-- questions for every configured section.
create or replace function public.validate_jamb_exam_publish()
returns trigger language plpgsql set search_path = public as $$
declare
  v_sections integer;
  v_missing integer;
  v_required integer;
  v_required_english integer;
  v_elective integer;
  v_access_ready boolean := false;
  v_course_has_is_published boolean := false;
begin
  if new.status = 'PUBLISHED' and (
    tg_op = 'INSERT'
    or old.status is distinct from new.status
    or old.mock_elective_count is distinct from new.mock_elective_count
    or old.access_course_id is distinct from new.access_course_id
    or old.access_bundle_id is distinct from new.access_bundle_id
  ) then
    if new.reviewed_by is null then raise exception 'JAMB_REVIEWER_REQUIRED'; end if;
    if new.access_bundle_id is not null then
      if to_regclass('public.bundles') is null then raise exception 'JAMB_ACCESS_BUNDLE_MISSING'; end if;
      execute 'select exists (select 1 from public.bundles where id = $1 and kind = ''exam_access'' and is_published = true)'
        into v_access_ready using new.access_bundle_id;
      if not v_access_ready then raise exception 'JAMB_ACCESS_BUNDLE_NOT_PUBLISHED'; end if;
    else
      if new.access_course_id is null then raise exception 'JAMB_ACCESS_PRODUCT_REQUIRED'; end if;
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'courses' and column_name = 'is_published'
      ) into v_course_has_is_published;
      if v_course_has_is_published then
        execute 'select exists (select 1 from public.courses where id = $1 and is_published = true)'
          into v_access_ready using new.access_course_id;
      else
        execute 'select exists (select 1 from public.courses where id = $1 and published = true)'
          into v_access_ready using new.access_course_id;
      end if;
      if not v_access_ready then raise exception 'JAMB_ACCESS_COURSE_NOT_PUBLISHED'; end if;
    end if;
    select count(*), count(*) filter (where s.is_required)
      into v_sections, v_required
    from public.jamb_exam_sections s where s.exam_id = new.id;
    if v_sections = 0 then raise exception 'JAMB_EXAM_REQUIRES_SECTIONS'; end if;
    if new.mode = 'PRACTICE' and (v_sections <> 1 or v_required <> 1) then
      raise exception 'JAMB_PRACTICE_REQUIRES_ONE_REQUIRED_SUBJECT';
    end if;
    if new.mode = 'MOCK' then
      select count(*) into v_elective from public.jamb_exam_sections s
      where s.exam_id = new.id and not s.is_required;
      select count(*) filter (where s.is_required),
             count(*) filter (where s.is_required and js.code = 'USE-OF-ENGLISH')
        into v_required, v_required_english
      from public.jamb_exam_sections s
      join public.jamb_subjects js on js.id = s.subject_id
      where s.exam_id = new.id;
      if v_required <> 1 or v_required_english <> 1 or v_elective < new.mock_elective_count then
        raise exception 'JAMB_MOCK_REQUIRES_ENGLISH_AND_ELECTIVE_SUBJECTS';
      end if;
    end if;
    select count(*) into v_missing
    from public.jamb_exam_sections s
    where s.exam_id = new.id
      and (select count(*) from public.jamb_questions q
           where q.subject_id = s.subject_id
             and q.syllabus_version_id = s.syllabus_version_id
             and q.status = 'PUBLISHED'
             and (q.source_type = 'ORIGINAL' or q.rights_verified)) < s.question_count;
    if v_missing > 0 then raise exception 'JAMB_EXAM_QUESTION_BANK_INCOMPLETE'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_jamb_exam_publish on public.jamb_exams;
create trigger trg_jamb_exam_publish before insert or update of status, mock_elective_count, access_course_id, access_bundle_id
  on public.jamb_exams for each row execute function public.validate_jamb_exam_publish();

-- ---------------------------------------------------------------------
-- Server-side attempt RPCs. They are callable only by the API service role;
-- the API supplies the verified profile ID, never a client-supplied owner.
-- ---------------------------------------------------------------------
create or replace function public.start_jamb_exam_attempt(
  p_exam_id uuid, p_student_id uuid, p_subject_codes text[] default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_exam public.jamb_exams%rowtype;
  v_role text;
  v_paid_access boolean := false;
  v_attempt_id uuid;
  v_expiry timestamptz;
  v_attempts integer;
  v_section record;
  v_question record;
  v_options jsonb;
  v_correct uuid;
  v_added integer;
  v_position integer := 0;
  v_selected_codes text[];
  v_available_count integer;
  v_required_count integer;
  v_elective_count integer;
begin
  select role::text into v_role from public.profiles where id = p_student_id;
  if v_role is null then raise exception 'JAMB_PROFILE_NOT_FOUND'; end if;

  -- Serialize starts for this exam so max_attempts cannot be bypassed by concurrent requests.
  select * into v_exam from public.jamb_exams where id = p_exam_id for update;
  if not found or v_exam.status <> 'PUBLISHED' then raise exception 'JAMB_EXAM_NOT_AVAILABLE'; end if;

  if v_role <> 'admin' then
    if v_exam.access_bundle_id is not null then
      if to_regclass('public.bundles') is null or to_regclass('public.manual_payments') is null then
        raise exception 'JAMB_PAID_ACCESS_REQUIRED';
      end if;
      execute $query$
        select exists (
          select 1
          from public.manual_payments p
          join public.bundles b on b.id = p.bundle_id
          where p.user_id = $1
            and p.bundle_id = $2
            and lower(p.status) = 'approved'
            and b.kind = 'exam_access'
            and b.is_published = true
        )
      $query$ into v_paid_access using p_student_id, v_exam.access_bundle_id;
      if not v_paid_access then raise exception 'JAMB_PAID_ACCESS_REQUIRED'; end if;
    else
      if v_exam.access_course_id is null or not exists (
        select 1 from public.enrollments e
        where e.student_id = p_student_id
          and e.course_id = v_exam.access_course_id
          and e.status in ('ACTIVE', 'COMPLETED')
      ) then
        raise exception 'JAMB_PAID_ACCESS_REQUIRED';
      end if;
    end if;
  end if;

  if v_exam.mode = 'PRACTICE' then
    select array_agg(upper(js.code) order by upper(js.code)), count(*)
      into v_selected_codes, v_available_count
    from public.jamb_exam_sections s
    join public.jamb_subjects js on js.id = s.subject_id
    where s.exam_id = v_exam.id;
    if coalesce(v_available_count, 0) <> 1 then raise exception 'JAMB_PRACTICE_CONFIG_INVALID'; end if;
    if p_subject_codes is not null and
       (cardinality(p_subject_codes) <> 1 or upper(p_subject_codes[1]) <> v_selected_codes[1]) then
      raise exception 'JAMB_SUBJECT_SELECTION_INVALID';
    end if;
  else
    select count(*) into v_required_count from public.jamb_exam_sections s
      where s.exam_id = v_exam.id and s.is_required;
    if v_required_count <> 1 or not exists (
      select 1 from public.jamb_exam_sections s
      join public.jamb_subjects js on js.id = s.subject_id
      where s.exam_id = v_exam.id and s.is_required and js.code = 'USE-OF-ENGLISH'
    ) then raise exception 'JAMB_MOCK_CONFIG_INVALID'; end if;
    if p_subject_codes is null then raise exception 'JAMB_SUBJECT_SELECTION_REQUIRED'; end if;
    select array_agg(distinct upper(code) order by upper(code)) into v_selected_codes
      from unnest(p_subject_codes) as requested(code);
    if coalesce(cardinality(v_selected_codes), 0) <> cardinality(p_subject_codes) then
      raise exception 'JAMB_SUBJECT_SELECTION_DUPLICATE';
    end if;
    select count(*) into v_available_count
      from public.jamb_exam_sections s
      join public.jamb_subjects js on js.id = s.subject_id
      where s.exam_id = v_exam.id and upper(js.code) = any(v_selected_codes);
    if v_available_count <> cardinality(v_selected_codes) then raise exception 'JAMB_SUBJECT_SELECTION_INVALID'; end if;
    select count(*) into v_required_count from public.jamb_exam_sections s
      join public.jamb_subjects js on js.id = s.subject_id
      where s.exam_id = v_exam.id and s.is_required;
    if exists (
      select 1 from public.jamb_exam_sections s
      join public.jamb_subjects js on js.id = s.subject_id
      where s.exam_id = v_exam.id and s.is_required
        and not (upper(js.code) = any(v_selected_codes))
    ) then raise exception 'JAMB_REQUIRED_SUBJECT_MISSING'; end if;
    select count(*) into v_elective_count
      from public.jamb_exam_sections s
      join public.jamb_subjects js on js.id = s.subject_id
      where s.exam_id = v_exam.id and not s.is_required
        and upper(js.code) = any(v_selected_codes);
    if v_elective_count <> v_exam.mock_elective_count then raise exception 'JAMB_ELECTIVE_SUBJECT_COUNT_INVALID'; end if;
  end if;

  if v_exam.max_attempts is not null then
    select count(*) into v_attempts from public.jamb_exam_attempts
    where exam_id = v_exam.id and student_id = p_student_id;
    if v_attempts >= v_exam.max_attempts then raise exception 'JAMB_MAX_ATTEMPTS_REACHED'; end if;
  end if;

  v_expiry := now() + make_interval(mins => v_exam.time_limit_minutes);
  insert into public.jamb_exam_attempts
    (exam_id, student_id, status, started_at, expires_at, selected_subject_codes)
  values (v_exam.id, p_student_id, 'IN_PROGRESS', now(), v_expiry, v_selected_codes)
  returning id into v_attempt_id;

  for v_section in
    select s.* from public.jamb_exam_sections s
    join public.jamb_subjects js on js.id = s.subject_id
    where s.exam_id = v_exam.id and upper(js.code) = any(v_selected_codes)
    order by s.order_number
  loop
    v_added := 0;
    for v_question in
      select q.id, q.question, q.explanation
      from public.jamb_questions q
      where q.subject_id = v_section.subject_id
        and q.syllabus_version_id = v_section.syllabus_version_id
        and q.status = 'PUBLISHED'
        and (q.source_type = 'ORIGINAL' or q.rights_verified)
        and (select count(*) from public.jamb_question_options o where o.question_id = q.id) = 4
        and (select count(*) from public.jamb_question_options o where o.question_id = q.id and o.is_correct) = 1
      order by case when v_exam.shuffle_questions then random() else null::double precision end, q.id
      limit v_section.question_count
    loop
      select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.option_text) order by o.order_number)
        into v_options
      from public.jamb_question_options o where o.question_id = v_question.id;
      select id into v_correct from public.jamb_question_options
        where question_id = v_question.id and is_correct limit 1;
      v_position := v_position + 1;
      insert into public.jamb_exam_attempt_items
        (attempt_id, question_id, subject_id, order_number, question_snapshot,
         options_snapshot, correct_option_id_snapshot, explanation_snapshot)
      values
        (v_attempt_id, v_question.id, v_section.subject_id, v_position,
         v_question.question, coalesce(v_options, '[]'::jsonb), v_correct, v_question.explanation);
      v_added := v_added + 1;
    end loop;
    if v_added <> v_section.question_count then
      raise exception 'JAMB_QUESTION_BANK_INCOMPLETE: subject %, expected %, got %',
        v_section.subject_id, v_section.question_count, v_added;
    end if;
  end loop;

  update public.jamb_exam_attempts set total_questions = v_position where id = v_attempt_id;
  return jsonb_build_object('attempt_id', v_attempt_id, 'exam_id', v_exam.id,
                            'started_at', now(), 'expires_at', v_expiry,
                            'time_limit_minutes', v_exam.time_limit_minutes,
                            'total_questions', v_position,
                            'selected_subject_codes', v_selected_codes);
end;
$$;

create or replace function public.save_jamb_exam_answers(p_attempt_id uuid, p_student_id uuid, p_answers jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_attempt public.jamb_exam_attempts%rowtype;
  v_item record;
  v_answer jsonb;
  v_item_id uuid;
  v_option_id uuid;
  v_saved integer := 0;
  v_role text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then raise exception 'JAMB_ANSWERS_INVALID'; end if;
  select role::text into v_role from public.profiles where id = p_student_id;
  select * into v_attempt from public.jamb_exam_attempts where id = p_attempt_id for update;
  if not found then raise exception 'JAMB_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.student_id <> p_student_id and v_role <> 'admin' then raise exception 'JAMB_ATTEMPT_FORBIDDEN'; end if;
  if v_attempt.status <> 'IN_PROGRESS' then raise exception 'JAMB_ATTEMPT_CLOSED'; end if;
  if now() >= v_attempt.expires_at then raise exception 'JAMB_ATTEMPT_EXPIRED'; end if;

  for v_answer in select * from jsonb_array_elements(p_answers) loop
    begin
      v_item_id := (v_answer ->> 'attempt_item_id')::uuid;
      v_option_id := (v_answer ->> 'option_id')::uuid;
    exception when others then
      raise exception 'JAMB_ANSWER_INVALID_ID';
    end;
    select * into v_item from public.jamb_exam_attempt_items
      where id = v_item_id and attempt_id = v_attempt.id for update;
    if not found then raise exception 'JAMB_QUESTION_NOT_IN_ATTEMPT'; end if;
    if not exists (
      select 1 from jsonb_array_elements(v_item.options_snapshot) o
      where o ->> 'id' = v_option_id::text
    ) then raise exception 'JAMB_OPTION_NOT_FOR_QUESTION'; end if;
    update public.jamb_exam_attempt_items
      set selected_option_id = v_option_id, answered_at = now()
      where id = v_item.id;
    v_saved := v_saved + 1;
  end loop;
  return jsonb_build_object('saved_count', v_saved, 'expires_at', v_attempt.expires_at);
end;
$$;

create or replace function public.submit_jamb_exam_attempt(p_attempt_id uuid, p_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_attempt public.jamb_exam_attempts%rowtype;
  v_role text;
  v_total integer;
  v_correct integer;
  v_score numeric(5,2);
  v_status text;
begin
  select role::text into v_role from public.profiles where id = p_student_id;
  select * into v_attempt from public.jamb_exam_attempts where id = p_attempt_id for update;
  if not found then raise exception 'JAMB_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.student_id <> p_student_id and v_role <> 'admin' then raise exception 'JAMB_ATTEMPT_FORBIDDEN'; end if;
  if v_attempt.status <> 'IN_PROGRESS' then
    return jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status,
      'score', v_attempt.score, 'correct_count', v_attempt.correct_count,
      'total_questions', v_attempt.total_questions, 'submitted_at', v_attempt.submitted_at);
  end if;

  update public.jamb_exam_attempt_items
    set is_correct = (selected_option_id = correct_option_id_snapshot)
    where attempt_id = v_attempt.id;
  select count(*), count(*) filter (where is_correct)
    into v_total, v_correct from public.jamb_exam_attempt_items where attempt_id = v_attempt.id;
  if coalesce(v_total, 0) = 0 then raise exception 'JAMB_ATTEMPT_HAS_NO_QUESTIONS'; end if;
  v_score := round((coalesce(v_correct, 0)::numeric / v_total::numeric) * 100, 2);
  v_status := case when now() >= v_attempt.expires_at then 'EXPIRED' else 'SUBMITTED' end;
  update public.jamb_exam_attempts
    set status = v_status, submitted_at = now(), total_questions = v_total,
        correct_count = coalesce(v_correct, 0), score = v_score
    where id = v_attempt.id;
  return jsonb_build_object('attempt_id', v_attempt.id, 'status', v_status,
    'score', v_score, 'correct_count', coalesce(v_correct, 0),
    'total_questions', v_total, 'submitted_at', now());
end;
$$;

revoke all on function public.start_jamb_exam_attempt(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.save_jamb_exam_answers(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.submit_jamb_exam_attempt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.start_jamb_exam_attempt(uuid, uuid, text[]) to service_role;
grant execute on function public.save_jamb_exam_answers(uuid, uuid, jsonb) to service_role;
grant execute on function public.submit_jamb_exam_attempt(uuid, uuid) to service_role;

comment on table public.jamb_questions is 'Private question bank. Rows are served through the authenticated JAMB API only; direct browser reads are revoked.';
comment on table public.jamb_exam_attempt_items is 'Private per-student question snapshots, selected answers and correct-answer snapshots. Never expose directly through Supabase REST.';
comment on table public.jamb_syllabus_versions is 'Year-versioned subject syllabus references. Populate historical years only from verified/licensed source material.';
