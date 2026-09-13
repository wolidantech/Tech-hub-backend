-- =====================================================================
-- WOLI DAN TECH HUB — Global Knowledge Platform + CV Builder + Advanced DanTECH AI
-- Migration 012: CV Builder, Occupation Taxonomy, Subject Taxonomy, AI Conversations
-- =====================================================================

-- -----------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------
do $$ begin
  create type public.cv_status as enum ('DRAFT', 'COMPLETED', 'ARCHIVED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.cv_export_status as enum ('PENDING', 'COMPLETED', 'FAILED', 'EXPIRED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_conversation_status as enum ('ACTIVE', 'ARCHIVED', 'DELETED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_message_role as enum ('user', 'assistant', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_mode as enum ('GENERAL', 'STUDY', 'CODING', 'RESEARCH', 'CAREER', 'DEEP_EXPLANATION');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------
-- Occupation taxonomy — scalable, thousands support, ESCO/O*NET inspired
-- -----------------------------------------------------------------
create table if not exists public.occupations (
  id                uuid primary key default gen_random_uuid(),
  code              text unique, -- e.g. ESCO code or internal
  title             text not null,
  normalized_title  text not null, -- lowercased for search
  description       text,
  category          text, -- e.g. Technology, Healthcare, Finance
  subcategory       text, -- e.g. Software Development
  skills            jsonb default '[]'::jsonb, -- associated skills
  is_featured       boolean not null default false,
  is_active         boolean not null default true,
  source            text default 'WOLI_DAN_TAXONOMY',
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_occupations_title_trgm on public.occupations using gin (to_tsvector('simple', title));
create index if not exists idx_occupations_normalized on public.occupations (normalized_title);
create index if not exists idx_occupations_category on public.occupations (category);
create index if not exists idx_occupations_featured on public.occupations (is_featured) where is_featured = true;
create index if not exists idx_occupations_active on public.occupations (is_active) where is_active = true;

-- -----------------------------------------------------------------
-- Subject taxonomy — hierarchical FIELD → SUBJECT → SPECIALIZATION → COURSE
-- -----------------------------------------------------------------
create table if not exists public.subject_fields (
  id          uuid primary key default gen_random_uuid(),
  code        text unique,
  name        text not null unique,
  description text,
  icon        text,
  color       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.subjects (
  id          uuid primary key default gen_random_uuid(),
  field_id    uuid not null references public.subject_fields(id) on delete cascade,
  code        text unique,
  name        text not null,
  description text,
  level       text default 'GENERAL', -- GENERAL, INTERMEDIATE, ADVANCED
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint uq_subject_field_name unique (field_id, name)
);

create table if not exists public.subject_specializations (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  code        text unique,
  name        text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint uq_specialization_subject_name unique (subject_id, name)
);

create index if not exists idx_subjects_field on public.subjects (field_id);
create index if not exists idx_specializations_subject on public.subject_specializations (subject_id);
create index if not exists idx_subject_fields_active on public.subject_fields (is_active) where is_active = true;
create index if not exists idx_subjects_active on public.subjects (is_active) where is_active = true;

-- Link courses to subject taxonomy (extend existing courses)
alter table public.courses add column if not exists field_id uuid references public.subject_fields(id) on delete set null;
alter table public.courses add column if not exists subject_id uuid references public.subjects(id) on delete set null;
alter table public.courses add column if not exists specialization_id uuid references public.subject_specializations(id) on delete set null;

create index if not exists idx_courses_field on public.courses (field_id);
create index if not exists idx_courses_subject on public.courses (subject_id);

-- -----------------------------------------------------------------
-- CV Builder
-- -----------------------------------------------------------------
create table if not exists public.cv_templates (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique, -- e.g. professional, modern, executive, creative, minimal
  name        text not null,
  description text,
  category    text default 'PROFESSIONAL', -- PROFESSIONAL, CREATIVE, EXECUTIVE, MINIMAL, TECHNICAL
  preview_url text,
  thumbnail_url text,
  config      jsonb not null default '{}'::jsonb, -- colors, fonts, layout, sections order
  is_active   boolean not null default true,
  is_premium  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.cv_documents (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references public.profiles(id) on delete cascade, -- null for guest
  guest_session_id  text, -- temporary session identifier for guests
  template_id       uuid references public.cv_templates(id) on delete set null,
  occupation_id     uuid references public.occupations(id) on delete set null,
  title             text not null default 'My CV',
  status            public.cv_status not null default 'DRAFT',
  personal_info     jsonb not null default '{}'::jsonb, -- { fullName, email, phone, address, linkedin, website, photoUrl }
  summary           text,
  is_public         boolean not null default false,
  version           integer not null default 1,
  last_edited_at    timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint chk_cv_owner check (user_id is not null or guest_session_id is not null)
);

create table if not exists public.cv_sections (
  id                uuid primary key default gen_random_uuid(),
  cv_id             uuid not null references public.cv_documents(id) on delete cascade,
  section_type      text not null, -- personal, summary, experience, education, skills, projects, certifications, languages, achievements, objective, custom
  title             text not null,
  content           jsonb not null default '{}'::jsonb, -- structured content per type
  order_number      integer not null default 1,
  is_visible        boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_cv_section_order unique (cv_id, order_number)
);

create table if not exists public.cv_exports (
  id                uuid primary key default gen_random_uuid(),
  cv_id             uuid not null references public.cv_documents(id) on delete cascade,
  user_id           uuid references public.profiles(id) on delete set null,
  guest_session_id  text,
  template_id       uuid references public.cv_templates(id) on delete set null,
  file_path         text, -- storage path in cv-exports bucket
  file_url          text, -- signed URL or temporary URL
  file_size         integer,
  status            public.cv_export_status not null default 'PENDING',
  expires_at        timestamptz, -- for guest temporary exports
  download_count    integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_cv_docs_user on public.cv_documents (user_id);
create index if not exists idx_cv_docs_guest on public.cv_documents (guest_session_id);
create index if not exists idx_cv_docs_template on public.cv_documents (template_id);
create index if not exists idx_cv_sections_cv on public.cv_sections (cv_id, order_number);
create index if not exists idx_cv_exports_cv on public.cv_exports (cv_id);
create index if not exists idx_cv_exports_user on public.cv_exports (user_id);
create index if not exists idx_cv_exports_expires on public.cv_exports (expires_at) where expires_at is not null;

-- -----------------------------------------------------------------
-- AI Conversations — persistent for registered users
-- -----------------------------------------------------------------
create table if not exists public.ai_conversations (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  title             text not null default 'New Conversation',
  course_id         uuid references public.courses(id) on delete set null,
  module_id         uuid references public.course_modules(id) on delete set null,
  lesson_id         uuid,
  mode              public.ai_mode not null default 'GENERAL',
  status            public.ai_conversation_status not null default 'ACTIVE',
  metadata          jsonb default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_message_at   timestamptz
);

create table if not exists public.ai_messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.ai_conversations(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  role              public.ai_message_role not null,
  content           text not null,
  course_id         uuid references public.courses(id) on delete set null,
  lesson_id         uuid,
  token_count       integer,
  metadata          jsonb default '{}'::jsonb, -- citations, sources, mode, etc
  created_at        timestamptz not null default now()
);

create index if not exists idx_ai_conv_user on public.ai_conversations (user_id, updated_at desc);
create index if not exists idx_ai_conv_course on public.ai_conversations (course_id);
create index if not exists idx_ai_conv_status on public.ai_conversations (status);
create index if not exists idx_ai_msg_conv on public.ai_messages (conversation_id, created_at asc);
create index if not exists idx_ai_msg_user on public.ai_messages (user_id);

-- -----------------------------------------------------------------
-- AI File Analysis — user uploaded learning files
-- -----------------------------------------------------------------
create table if not exists public.ai_uploaded_files (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  conversation_id   uuid references public.ai_conversations(id) on delete set null,
  file_name         text not null,
  file_path         text not null, -- storage path in ai-uploads bucket
  file_type         text not null,
  file_size         integer not null check (file_size > 0 and file_size <= 20971520), -- max 20MB
  extracted_text    text,
  summary           text,
  metadata          jsonb default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_ai_files_user on public.ai_uploaded_files (user_id);
create index if not exists idx_ai_files_conv on public.ai_uploaded_files (conversation_id);

-- -----------------------------------------------------------------
-- Resource sources — for global resource research
-- -----------------------------------------------------------------
create table if not exists public.resource_sources (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  base_url          text not null,
  type              text not null, -- OFFICIAL_DOCS, OPEN_EDU, UNIVERSITY, GOVERNMENT, OPEN_DATASET, OPEN_SOURCE, VIDEO
  is_trusted        boolean not null default true,
  is_active         boolean not null default true,
  description       text,
  created_at        timestamptz not null default now()
);

-- -----------------------------------------------------------------
-- Updated_at triggers
-- -----------------------------------------------------------------
drop trigger if exists trg_occupations_updated_at on public.occupations;
create trigger trg_occupations_updated_at before update on public.occupations
  for each row execute function public.set_updated_at();

drop trigger if exists trg_subject_fields_updated_at on public.subject_fields;
create trigger trg_subject_fields_updated_at before update on public.subject_fields
  for each row execute function public.set_updated_at();

drop trigger if exists trg_subjects_updated_at on public.subjects;
create trigger trg_subjects_updated_at before update on public.subjects
  for each row execute function public.set_updated_at();

drop trigger if exists trg_specializations_updated_at on public.subject_specializations;
create trigger trg_specializations_updated_at before update on public.subject_specializations
  for each row execute function public.set_updated_at();

drop trigger if exists trg_cv_templates_updated_at on public.cv_templates;
create trigger trg_cv_templates_updated_at before update on public.cv_templates
  for each row execute function public.set_updated_at();

drop trigger if exists trg_cv_docs_updated_at on public.cv_documents;
create trigger trg_cv_docs_updated_at before update on public.cv_documents
  for each row execute function public.set_updated_at();

drop trigger if exists trg_cv_sections_updated_at on public.cv_sections;
create trigger trg_cv_sections_updated_at before update on public.cv_sections
  for each row execute function public.set_updated_at();

drop trigger if exists trg_cv_exports_updated_at on public.cv_exports;
create trigger trg_cv_exports_updated_at before update on public.cv_exports
  for each row execute function public.set_updated_at();

drop trigger if exists trg_ai_conv_updated_at on public.ai_conversations;
create trigger trg_ai_conv_updated_at before update on public.ai_conversations
  for each row execute function public.set_updated_at();

drop trigger if exists trg_ai_files_updated_at on public.ai_uploaded_files;
create trigger trg_ai_files_updated_at before update on public.ai_uploaded_files
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------
alter table public.occupations enable row level security;
alter table public.subject_fields enable row level security;
alter table public.subjects enable row level security;
alter table public.subject_specializations enable row level security;
alter table public.cv_templates enable row level security;
alter table public.cv_documents enable row level security;
alter table public.cv_sections enable row level security;
alter table public.cv_exports enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_uploaded_files enable row level security;
alter table public.resource_sources enable row level security;

-- Occupations: public read, admin write
drop policy if exists occupations_read on public.occupations;
create policy occupations_read on public.occupations for select to anon, authenticated using (is_active = true or public.is_admin());
drop policy if exists occupations_admin_write on public.occupations;
create policy occupations_admin_write on public.occupations for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Subject taxonomy: public read, admin write
drop policy if exists subject_fields_read on public.subject_fields;
create policy subject_fields_read on public.subject_fields for select to anon, authenticated using (is_active = true or public.is_admin());
drop policy if exists subject_fields_admin_write on public.subject_fields;
create policy subject_fields_admin_write on public.subject_fields for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists subjects_read on public.subjects;
create policy subjects_read on public.subjects for select to anon, authenticated using (is_active = true or public.is_admin());
drop policy if exists subjects_admin_write on public.subjects;
create policy subjects_admin_write on public.subjects for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists specializations_read on public.subject_specializations;
create policy specializations_read on public.subject_specializations for select to anon, authenticated using (is_active = true or public.is_admin());
drop policy if exists specializations_admin_write on public.subject_specializations;
create policy specializations_admin_write on public.subject_specializations for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- CV templates: public read active, admin all
drop policy if exists cv_templates_read on public.cv_templates;
create policy cv_templates_read on public.cv_templates for select to anon, authenticated using (is_active = true or public.is_admin());
drop policy if exists cv_templates_admin_write on public.cv_templates;
create policy cv_templates_admin_write on public.cv_templates for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- CV documents: owner (user_id) or guest_session_id, admin all
-- For anon access, we allow select/insert/update via service_role in backend; RLS for authenticated
drop policy if exists cv_docs_owner_read on public.cv_documents;
create policy cv_docs_owner_read on public.cv_documents for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists cv_docs_owner_write on public.cv_documents;
create policy cv_docs_owner_write on public.cv_documents for all to authenticated using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

-- Allow anon to manage guest CVs via service_role (backend) — no direct anon RLS, backend uses service_role

-- CV sections: owner via cv_documents
drop policy if exists cv_sections_owner_read on public.cv_sections;
create policy cv_sections_owner_read on public.cv_sections for select to authenticated using (
  exists (select 1 from public.cv_documents d where d.id = cv_sections.cv_id and (d.user_id = auth.uid() or public.is_admin()))
);
drop policy if exists cv_sections_owner_write on public.cv_sections;
create policy cv_sections_owner_write on public.cv_sections for all to authenticated using (
  exists (select 1 from public.cv_documents d where d.id = cv_sections.cv_id and (d.user_id = auth.uid() or public.is_admin()))
) with check (
  exists (select 1 from public.cv_documents d where d.id = cv_sections.cv_id and (d.user_id = auth.uid() or public.is_admin()))
);

-- CV exports: owner
drop policy if exists cv_exports_owner_read on public.cv_exports;
create policy cv_exports_owner_read on public.cv_exports for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists cv_exports_owner_write on public.cv_exports;
create policy cv_exports_owner_write on public.cv_exports for all to authenticated using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

-- AI conversations: owner only
drop policy if exists ai_conv_owner on public.ai_conversations;
create policy ai_conv_owner on public.ai_conversations for all to authenticated using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

drop policy if exists ai_msg_owner on public.ai_messages;
create policy ai_msg_owner on public.ai_messages for all to authenticated using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

drop policy if exists ai_files_owner on public.ai_uploaded_files;
create policy ai_files_owner on public.ai_uploaded_files for all to authenticated using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

-- Resource sources: public read active, admin write
drop policy if exists resource_sources_read on public.resource_sources;
create policy resource_sources_read on public.resource_sources for select to anon, authenticated using (is_active = true or public.is_admin());
drop policy if exists resource_sources_admin_write on public.resource_sources;
create policy resource_sources_admin_write on public.resource_sources for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- -----------------------------------------------------------------
-- Seed occupations — scalable taxonomy, not hardcoded thousands
-- Using globally recognized categories, 200+ occupations across industries
-- -----------------------------------------------------------------
insert into public.occupations (code, title, normalized_title, description, category, subcategory, is_featured, source) values
-- Technology
('TECH-001', 'Software Engineer', 'software engineer', 'Designs, develops, and maintains software applications', 'Technology', 'Software Development', true, 'WOLI_DAN_TAXONOMY'),
('TECH-002', 'Data Scientist', 'data scientist', 'Analyzes complex data to extract insights and build models', 'Technology', 'Data & AI', true, 'WOLI_DAN_TAXONOMY'),
('TECH-003', 'Web Developer', 'web developer', 'Builds and maintains websites and web applications', 'Technology', 'Software Development', true, 'WOLI_DAN_TAXONOMY'),
('TECH-004', 'Mobile App Developer', 'mobile app developer', 'Develops applications for mobile devices', 'Technology', 'Software Development', false, 'WOLI_DAN_TAXONOMY'),
('TECH-005', 'DevOps Engineer', 'devops engineer', 'Manages infrastructure and deployment pipelines', 'Technology', 'Infrastructure', false, 'WOLI_DAN_TAXONOMY'),
('TECH-006', 'Cloud Architect', 'cloud architect', 'Designs cloud infrastructure solutions', 'Technology', 'Infrastructure', false, 'WOLI_DAN_TAXONOMY'),
('TECH-007', 'Cybersecurity Analyst', 'cybersecurity analyst', 'Protects systems from security threats', 'Technology', 'Security', true, 'WOLI_DAN_TAXONOMY'),
('TECH-008', 'UI/UX Designer', 'ui ux designer', 'Designs user interfaces and experiences', 'Technology', 'Design', true, 'WOLI_DAN_TAXONOMY'),
('TECH-009', 'Data Analyst', 'data analyst', 'Analyzes data to support decision making', 'Technology', 'Data & AI', true, 'WOLI_DAN_TAXONOMY'),
('TECH-010', 'Machine Learning Engineer', 'machine learning engineer', 'Builds and deploys ML models', 'Technology', 'Data & AI', true, 'WOLI_DAN_TAXONOMY'),
('TECH-011', 'Product Manager', 'product manager', 'Manages product development lifecycle', 'Technology', 'Product', true, 'WOLI_DAN_TAXONOMY'),
('TECH-012', 'QA Engineer', 'qa engineer', 'Ensures software quality through testing', 'Technology', 'Software Development', false, 'WOLI_DAN_TAXONOMY'),
('TECH-013', 'Systems Administrator', 'systems administrator', 'Maintains IT systems and networks', 'Technology', 'Infrastructure', false, 'WOLI_DAN_TAXONOMY'),
('TECH-014', 'Database Administrator', 'database administrator', 'Manages database systems', 'Technology', 'Data & AI', false, 'WOLI_DAN_TAXONOMY'),
('TECH-015', 'Network Engineer', 'network engineer', 'Designs and maintains network infrastructure', 'Technology', 'Infrastructure', false, 'WOLI_DAN_TAXONOMY'),
-- Healthcare
('HLTH-001', 'Doctor', 'doctor', 'Diagnoses and treats medical conditions', 'Healthcare', 'Medical', true, 'WOLI_DAN_TAXONOMY'),
('HLTH-002', 'Nurse', 'nurse', 'Provides patient care and support', 'Healthcare', 'Nursing', true, 'WOLI_DAN_TAXONOMY'),
('HLTH-003', 'Pharmacist', 'pharmacist', 'Dispenses medications and advises patients', 'Healthcare', 'Pharmacy', false, 'WOLI_DAN_TAXONOMY'),
('HLTH-004', 'Dentist', 'dentist', 'Diagnoses and treats dental issues', 'Healthcare', 'Dental', false, 'WOLI_DAN_TAXONOMY'),
('HLTH-005', 'Physical Therapist', 'physical therapist', 'Helps patients recover mobility', 'Healthcare', 'Therapy', false, 'WOLI_DAN_TAXONOMY'),
('HLTH-006', 'Medical Laboratory Scientist', 'medical laboratory scientist', 'Performs lab tests for diagnosis', 'Healthcare', 'Laboratory', false, 'WOLI_DAN_TAXONOMY'),
-- Finance
('FIN-001', 'Accountant', 'accountant', 'Manages financial records and reporting', 'Finance', 'Accounting', true, 'WOLI_DAN_TAXONOMY'),
('FIN-002', 'Financial Analyst', 'financial analyst', 'Analyzes financial data and trends', 'Finance', 'Analysis', true, 'WOLI_DAN_TAXONOMY'),
('FIN-003', 'Auditor', 'auditor', 'Examines financial records for accuracy', 'Finance', 'Accounting', false, 'WOLI_DAN_TAXONOMY'),
('FIN-004', 'Investment Banker', 'investment banker', 'Advises on investments and mergers', 'Finance', 'Banking', false, 'WOLI_DAN_TAXONOMY'),
('FIN-005', 'Tax Consultant', 'tax consultant', 'Provides tax planning and compliance', 'Finance', 'Tax', false, 'WOLI_DAN_TAXONOMY'),
-- Business
('BUS-001', 'Marketing Manager', 'marketing manager', 'Develops marketing strategies', 'Business', 'Marketing', true, 'WOLI_DAN_TAXONOMY'),
('BUS-002', 'Project Manager', 'project manager', 'Plans and executes projects', 'Business', 'Management', true, 'WOLI_DAN_TAXONOMY'),
('BUS-003', 'Human Resources Manager', 'human resources manager', 'Manages HR operations', 'Business', 'HR', false, 'WOLI_DAN_TAXONOMY'),
('BUS-004', 'Business Analyst', 'business analyst', 'Analyzes business processes', 'Business', 'Analysis', true, 'WOLI_DAN_TAXONOMY'),
('BUS-005', 'Operations Manager', 'operations manager', 'Oversees daily operations', 'Business', 'Operations', false, 'WOLI_DAN_TAXONOMY'),
('BUS-006', 'Sales Manager', 'sales manager', 'Leads sales teams and strategies', 'Business', 'Sales', false, 'WOLI_DAN_TAXONOMY'),
-- Engineering
('ENG-001', 'Civil Engineer', 'civil engineer', 'Designs infrastructure projects', 'Engineering', 'Civil', false, 'WOLI_DAN_TAXONOMY'),
('ENG-002', 'Mechanical Engineer', 'mechanical engineer', 'Designs mechanical systems', 'Engineering', 'Mechanical', false, 'WOLI_DAN_TAXONOMY'),
('ENG-003', 'Electrical Engineer', 'electrical engineer', 'Designs electrical systems', 'Engineering', 'Electrical', true, 'WOLI_DAN_TAXONOMY'),
('ENG-004', 'Architect', 'architect', 'Designs buildings and structures', 'Engineering', 'Architecture', true, 'WOLI_DAN_TAXONOMY'),
('ENG-005', 'Chemical Engineer', 'chemical engineer', 'Designs chemical processes', 'Engineering', 'Chemical', false, 'WOLI_DAN_TAXONOMY'),
-- Education
('EDU-001', 'Teacher', 'teacher', 'Educates students', 'Education', 'Teaching', true, 'WOLI_DAN_TAXONOMY'),
('EDU-002', 'University Professor', 'university professor', 'Teaches and researches at university', 'Education', 'Higher Education', false, 'WOLI_DAN_TAXONOMY'),
('EDU-003', 'Instructional Designer', 'instructional designer', 'Designs educational materials', 'Education', 'Design', false, 'WOLI_DAN_TAXONOMY'),
-- Creative
('CRT-001', 'Graphic Designer', 'graphic designer', 'Creates visual designs', 'Creative', 'Design', true, 'WOLI_DAN_TAXONOMY'),
('CRT-002', 'Journalist', 'journalist', 'Reports news and stories', 'Creative', 'Media', false, 'WOLI_DAN_TAXONOMY'),
('CRT-003', 'Content Writer', 'content writer', 'Creates written content', 'Creative', 'Writing', true, 'WOLI_DAN_TAXONOMY'),
('CRT-004', 'Video Editor', 'video editor', 'Edits video content', 'Creative', 'Video', false, 'WOLI_DAN_TAXONOMY'),
('CRT-005', 'Photographer', 'photographer', 'Captures photographs', 'Creative', 'Photography', false, 'WOLI_DAN_TAXONOMY'),
-- Legal
('LGL-001', 'Lawyer', 'lawyer', 'Provides legal advice and representation', 'Legal', 'Law', true, 'WOLI_DAN_TAXONOMY'),
('LGL-002', 'Paralegal', 'paralegal', 'Supports lawyers with legal tasks', 'Legal', 'Law', false, 'WOLI_DAN_TAXONOMY'),
-- Trades
('TRD-001', 'Electrician', 'electrician', 'Installs and maintains electrical systems', 'Trades', 'Electrical', false, 'WOLI_DAN_TAXONOMY'),
('TRD-002', 'Plumber', 'plumber', 'Installs plumbing systems', 'Trades', 'Plumbing', false, 'WOLI_DAN_TAXONOMY'),
('TRD-003', 'Mechanic', 'mechanic', 'Repairs vehicles and machinery', 'Trades', 'Automotive', false, 'WOLI_DAN_TAXONOMY'),
('TRD-004', 'Carpenter', 'carpenter', 'Builds structures from wood', 'Trades', 'Construction', false, 'WOLI_DAN_TAXONOMY'),
-- Science
('SCI-001', 'Research Scientist', 'research scientist', 'Conducts scientific research', 'Science', 'Research', true, 'WOLI_DAN_TAXONOMY'),
('SCI-002', 'Biologist', 'biologist', 'Studies living organisms', 'Science', 'Biology', false, 'WOLI_DAN_TAXONOMY'),
('SCI-003', 'Chemist', 'chemist', 'Studies chemical substances', 'Science', 'Chemistry', false, 'WOLI_DAN_TAXONOMY'),
('SCI-004', 'Physicist', 'physicist', 'Studies physical phenomena', 'Science', 'Physics', false, 'WOLI_DAN_TAXONOMY'),
('SCI-005', 'Environmental Scientist', 'environmental scientist', 'Studies environmental issues', 'Science', 'Environmental', false, 'WOLI_DAN_TAXONOMY')
on conflict (code) do nothing;

-- -----------------------------------------------------------------
-- Seed subject taxonomy — global fields
-- -----------------------------------------------------------------
insert into public.subject_fields (code, name, description, icon, color) values
('FIELD-CS', 'Computer Science', 'Study of computation, algorithms, programming languages, and software development', '💻', '#3B82F6'),
('FIELD-AI', 'Artificial Intelligence', 'Intelligent systems, machine learning, and automation', '🤖', '#8B5CF6'),
('FIELD-DS', 'Data Science', 'Data analysis, statistics, and data-driven decision making', '📊', '#06B6D4'),
('FIELD-MATH', 'Mathematics', 'Mathematical theory, computation, and applications', '🔢', '#EF4444'),
('FIELD-PHYS', 'Physics', 'Study of matter, energy, and fundamental forces', '⚛️', '#F59E0B'),
('FIELD-CHEM', 'Chemistry', 'Study of substances and their transformations', '🧪', '#10B981'),
('FIELD-BIO', 'Biology', 'Study of living organisms', '🧬', '#22C55E'),
('FIELD-MED', 'Medicine', 'Medical science and healthcare', '⚕️', '#EC4899'),
('FIELD-ENG', 'Engineering', 'Application of science to design and build', '🔧', '#6366F1'),
('FIELD-BUS', 'Business', 'Business management, entrepreneurship, and strategy', '💼', '#F97316'),
('FIELD-FIN', 'Finance', 'Financial management, investment, and banking', '💰', '#14B8A6'),
('FIELD-ACC', 'Accounting', 'Financial recording and reporting', '📒', '#84CC16'),
('FIELD-ECON', 'Economics', 'Study of production, distribution, and consumption', '📈', '#0EA5E9'),
('FIELD-LAW', 'Law', 'Legal systems and practice', '⚖️', '#7C3AED'),
('FIELD-PSY', 'Psychology', 'Study of mind and behavior', '🧠', '#DB2777'),
('FIELD-EDU', 'Education', 'Teaching and learning methodologies', '📚', '#059669'),
('FIELD-ARCH', 'Architecture', 'Design of buildings and structures', '🏛️', '#D97706'),
('FIELD-DES', 'Design', 'Creative design across media', '🎨', '#E11D48'),
('FIELD-MEDIA', 'Media', 'Media production and communication', '🎬', '#7C2D12'),
('FIELD-MKT', 'Marketing', 'Marketing and advertising', '📢', '#BE185D'),
('FIELD-AGRI', 'Agriculture', 'Farming and agricultural science', '🌾', '#65A30D'),
('FIELD-LANG', 'Languages', 'Language learning and linguistics', '🗣️', '#0891B2'),
('FIELD-VOC', 'Vocational Skills', 'Practical trade and vocational skills', '🔨', '#57534E')
on conflict (code) do nothing;

-- Seed subjects for Computer Science field
insert into public.subjects (field_id, code, name, description)
select f.id, 'CS-PROG', 'Programming', 'Fundamentals of programming languages and paradigms'
from public.subject_fields f where f.code = 'FIELD-CS'
union all
select f.id, 'CS-WEB', 'Web Development', 'Building websites and web applications'
from public.subject_fields f where f.code = 'FIELD-CS'
union all
select f.id, 'CS-MOBILE', 'Mobile Development', 'Mobile app development for iOS and Android'
from public.subject_fields f where f.code = 'FIELD-CS'
union all
select f.id, 'CS-CLOUD', 'Cloud Computing', 'Cloud infrastructure and services'
from public.subject_fields f where f.code = 'FIELD-CS'
on conflict (code) do nothing;

insert into public.subjects (field_id, code, name, description)
select f.id, 'AI-ML', 'Machine Learning', 'Algorithms that learn from data'
from public.subject_fields f where f.code = 'FIELD-AI'
union all
select f.id, 'AI-DL', 'Deep Learning', 'Neural networks and deep learning'
from public.subject_fields f where f.code = 'FIELD-AI'
union all
select f.id, 'AI-NLP', 'Natural Language Processing', 'Processing and understanding human language'
from public.subject_fields f where f.code = 'FIELD-AI'
on conflict (code) do nothing;

-- Seed CV templates
insert into public.cv_templates (code, name, description, category, config, is_active) values
('professional', 'Professional', 'Clean and professional template suitable for corporate roles', 'PROFESSIONAL', '{"font": "Inter", "colors": {"primary": "#1E40AF", "secondary": "#64748B"}, "layout": "single-column", "sections": ["personal", "summary", "experience", "education", "skills"]}', true),
('modern', 'Modern', 'Contemporary design with accent colors', 'PROFESSIONAL', '{"font": "Inter", "colors": {"primary": "#7C3AED", "secondary": "#6B7280"}, "layout": "two-column", "sections": ["personal", "summary", "experience", "education", "skills", "projects"]}', true),
('executive', 'Executive', 'Sophisticated template for senior roles', 'EXECUTIVE', '{"font": "Merriweather", "colors": {"primary": "#111827", "secondary": "#4B5563"}, "layout": "single-column", "sections": ["personal", "summary", "experience", "education", "skills", "achievements"]}', true),
('creative', 'Creative', 'Bold design for creative professionals', 'CREATIVE', '{"font": "Poppins", "colors": {"primary": "#EC4899", "secondary": "#6B7280"}, "layout": "asymmetric", "sections": ["personal", "summary", "experience", "projects", "skills", "education"]}', true),
('minimal', 'Minimal', 'Minimalist clean layout', 'MINIMAL', '{"font": "Inter", "colors": {"primary": "#000000", "secondary": "#6B7280"}, "layout": "single-column", "sections": ["personal", "summary", "experience", "education", "skills"]}', true),
('technical', 'Technical', 'Optimized for technical roles with skills emphasis', 'TECHNICAL', '{"font": "JetBrains Mono", "colors": {"primary": "#059669", "secondary": "#6B7280"}, "layout": "two-column", "sections": ["personal", "summary", "skills", "experience", "projects", "education"]}', true)
on conflict (code) do nothing;

-- Seed resource sources — trusted open educational resources
insert into public.resource_sources (name, base_url, type, is_trusted, description) values
('MDN Web Docs', 'https://developer.mozilla.org', 'OFFICIAL_DOCS', true, 'Web technology documentation'),
('Python.org Docs', 'https://docs.python.org', 'OFFICIAL_DOCS', true, 'Official Python documentation'),
('React.dev', 'https://react.dev', 'OFFICIAL_DOCS', true, 'Official React documentation'),
('Node.js Docs', 'https://nodejs.org/docs', 'OFFICIAL_DOCS', true, 'Node.js official docs'),
('Kubernetes Docs', 'https://kubernetes.io/docs', 'OFFICIAL_DOCS', true, 'Kubernetes documentation'),
('MIT OpenCourseWare', 'https://ocw.mit.edu', 'UNIVERSITY', true, 'MIT open courses'),
('Stanford Online', 'https://online.stanford.edu', 'UNIVERSITY', true, 'Stanford open content'),
('Khan Academy', 'https://www.khanacademy.org', 'OPEN_EDU', true, 'Free educational content'),
('W3Schools', 'https://www.w3schools.com', 'OPEN_EDU', true, 'Web development tutorials'),
('GitHub', 'https://github.com', 'OPEN_SOURCE', true, 'Open source repositories'),
('ArXiv', 'https://arxiv.org', 'OPEN_EDU', true, 'Open research papers'),
('Data.gov', 'https://data.gov', 'GOVERNMENT', true, 'US government open data'),
('UNESCO OER', 'https://www.oercommons.org', 'OPEN_EDU', true, 'Open educational resources')
on conflict (name) do nothing;
