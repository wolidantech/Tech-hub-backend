-- =====================================================================
-- WOLI DAN TECH HUB — LEARN • BUILD • GROW
-- Migration 001: Initial schema (tables, enums, constraints, indexes)
-- =====================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------
-- Enumerated types
-- -----------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('student', 'admin', 'instructor');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.enrollment_status as enum ('PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_status as enum ('PENDING', 'APPROVED', 'REJECTED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_method as enum ('MANUAL_BANK_TRANSFER');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.lesson_type as enum ('VIDEO', 'TEXT', 'PDF', 'RESOURCE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.difficulty_level as enum ('BEGINNER', 'INTERMEDIATE', 'ADVANCED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_type as enum (
    'WELCOME',
    'PAYMENT_SUBMITTED',
    'PAYMENT_APPROVED',
    'PAYMENT_REJECTED',
    'COURSE_ENROLLED',
    'LESSON_COMPLETED',
    'COURSE_COMPLETED',
    'CERTIFICATE_ISSUED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.certificate_status as enum ('ACTIVE', 'REVOKED');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------
-- profiles  (one row per auth.users row)
-- -----------------------------------------------------------------
create table if not exists public.profiles (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references auth.users (id) on delete cascade,
  full_name         text not null,
  email             text not null unique,
  phone             text,
  profile_photo_url text,
  role              public.user_role not null default 'student',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_profiles_role       on public.profiles (role);
create index if not exists idx_profiles_created_at on public.profiles (created_at desc);

-- -----------------------------------------------------------------
-- course_categories
-- -----------------------------------------------------------------
create table if not exists public.course_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------
-- courses
-- -----------------------------------------------------------------
create table if not exists public.courses (
  id               uuid primary key default gen_random_uuid(),
  category_id      uuid references public.course_categories (id) on delete set null,
  title            text not null,
  slug             text not null unique,
  description      text,
  thumbnail_url    text,
  price            numeric(12, 2) not null default 5000.00 check (price >= 0),
  duration         text,
  difficulty_level public.difficulty_level not null default 'BEGINNER',
  instructor_id    uuid references public.profiles (id) on delete set null,
  is_published     boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_courses_category   on public.courses (category_id);
create index if not exists idx_courses_instructor on public.courses (instructor_id);
create index if not exists idx_courses_published  on public.courses (is_published) where is_published = true;
create index if not exists idx_courses_title_trgm on public.courses using gin (to_tsvector('simple', title));

-- -----------------------------------------------------------------
-- course_modules
-- -----------------------------------------------------------------
create table if not exists public.course_modules (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid not null references public.courses (id) on delete cascade,
  title        text not null,
  description  text,
  -- 0 is invalid; negative values are used transiently by the
  -- reorder_modules() RPC (single-transaction two-phase reorder).
  order_number integer not null default 1 check (order_number <> 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint uq_module_order unique (course_id, order_number)
);

create index if not exists idx_modules_course on public.course_modules (course_id, order_number);

-- -----------------------------------------------------------------
-- lessons
-- -----------------------------------------------------------------
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

create index if not exists idx_lessons_module    on public.lessons (module_id, order_number);
create index if not exists idx_lessons_published on public.lessons (is_published) where is_published = true;

-- -----------------------------------------------------------------
-- payments
-- -----------------------------------------------------------------
create table if not exists public.payments (
  id                    uuid primary key default gen_random_uuid(),
  student_id            uuid not null references public.profiles (id) on delete cascade,
  course_id             uuid not null references public.courses (id) on delete restrict,
  amount                numeric(12, 2) not null check (amount >= 0),
  payment_method        public.payment_method not null default 'MANUAL_BANK_TRANSFER',
  transaction_reference text not null,
  transaction_date      date not null,
  status                public.payment_status not null default 'PENDING',
  rejection_reason      text,
  submitted_at          timestamptz not null default now(),
  reviewed_at           timestamptz,
  reviewed_by           uuid references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint uq_transaction_reference unique (transaction_reference),
  constraint chk_rejection_reason check (
    (status = 'REJECTED' and rejection_reason is not null)
    or (status <> 'REJECTED')
  ),
  constraint chk_review_fields check (
    (status = 'PENDING')
    or (reviewed_at is not null and reviewed_by is not null)
  )
);

create index if not exists idx_payments_student on public.payments (student_id);
create index if not exists idx_payments_course  on public.payments (course_id);
create index if not exists idx_payments_status  on public.payments (status);

-- Only ONE pending payment per student per course is allowed at a time.
-- After a rejection the student may submit again.
create unique index if not exists uq_pending_payment_per_course
  on public.payments (student_id, course_id)
  where status = 'PENDING';

-- -----------------------------------------------------------------
-- enrollments
-- -----------------------------------------------------------------
create table if not exists public.enrollments (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles (id) on delete cascade,
  course_id    uuid not null references public.courses (id) on delete cascade,
  payment_id   uuid references public.payments (id) on delete set null,
  status       public.enrollment_status not null default 'PENDING',
  enrolled_at  timestamptz not null default now(),
  completed_at timestamptz,
  constraint uq_enrollment_student_course unique (student_id, course_id)
);

create index if not exists idx_enrollments_student on public.enrollments (student_id);
create index if not exists idx_enrollments_course  on public.enrollments (course_id);
create index if not exists idx_enrollments_status  on public.enrollments (status);

-- -----------------------------------------------------------------
-- payment_receipts  (files live in the private "payment-receipts" bucket)
-- -----------------------------------------------------------------
create table if not exists public.payment_receipts (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references public.payments (id) on delete cascade,
  student_id  uuid not null references public.profiles (id) on delete cascade,
  file_path   text not null unique,
  file_name   text not null,
  file_type   text not null check (file_type in ('image/jpeg', 'image/png', 'application/pdf')),
  uploaded_at timestamptz not null default now()
);

create index if not exists idx_receipts_payment on public.payment_receipts (payment_id);
create index if not exists idx_receipts_student on public.payment_receipts (student_id);

-- -----------------------------------------------------------------
-- lesson_progress
-- -----------------------------------------------------------------
create table if not exists public.lesson_progress (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references public.profiles (id) on delete cascade,
  lesson_id     uuid not null references public.lessons (id) on delete cascade,
  course_id     uuid not null references public.courses (id) on delete cascade,
  completed     boolean not null default false,
  completed_at  timestamptz,
  last_position integer not null default 0 check (last_position >= 0), -- seconds
  updated_at    timestamptz not null default now(),
  constraint uq_progress_student_lesson unique (student_id, lesson_id),
  constraint chk_completed_at check (
    (completed = true and completed_at is not null)
    or completed = false
  )
);

create index if not exists idx_progress_student_course on public.lesson_progress (student_id, course_id);
create index if not exists idx_progress_lesson         on public.lesson_progress (lesson_id);

-- -----------------------------------------------------------------
-- certificates
-- -----------------------------------------------------------------
create table if not exists public.certificate_counters (
  year  integer primary key,
  value integer not null default 0
);

create table if not exists public.certificates (
  id                 uuid primary key default gen_random_uuid(),
  student_id         uuid not null references public.profiles (id) on delete cascade,
  course_id          uuid not null references public.courses (id) on delete cascade,
  certificate_number text not null unique,            -- e.g. WDTH-2026-000001
  certificate_url    text,                            -- path inside the private "certificates" bucket
  issued_at          timestamptz not null default now(),
  verification_code  text not null unique default replace(gen_random_uuid()::text, '-', ''),
  status             public.certificate_status not null default 'ACTIVE',
  constraint uq_certificate_student_course unique (student_id, course_id)
);

create index if not exists idx_certificates_student on public.certificates (student_id);
create index if not exists idx_certificates_course  on public.certificates (course_id);

-- -----------------------------------------------------------------
-- notifications
-- -----------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null,
  message    text not null,
  type       public.notification_type not null,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user    on public.notifications (user_id, created_at desc);
create index if not exists idx_notifications_unread  on public.notifications (user_id) where is_read = false;

-- -----------------------------------------------------------------
-- audit_logs
-- -----------------------------------------------------------------
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  target_type text,
  target_id   uuid,
  description text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_audit_admin   on public.audit_logs (admin_id);
create index if not exists idx_audit_target  on public.audit_logs (target_type, target_id);
create index if not exists idx_audit_created on public.audit_logs (created_at desc);

-- -----------------------------------------------------------------
-- platform_settings  (bank details + future configurable settings)
-- -----------------------------------------------------------------
create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  is_public  boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);
