-- =====================================================================
-- WOLI DAN TECH HUB — BOOTSTRAP FOR EMPTY LIVE DB
-- Use when: select count(*) from courses = 0/0 and course_categories missing
-- This creates minimal tables needed for storefront and seeds 12 courses
-- Works even if your live project has NO tables yet
-- =====================================================================

-- 1. What tables do you actually have?
select table_name from information_schema.tables where table_schema='public' order by table_name;

-- 2. Create course_categories if missing (idempotent)
create table if not exists public.course_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz not null default now()
);

-- 3. Create courses table if missing — with BOTH published and is_published for compatibility
-- If table already exists but missing columns, add them
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.course_categories(id) on delete set null,
  title text not null,
  slug text not null unique,
  description text,
  thumbnail_url text,
  price numeric(12,2) not null default 5000.00,
  duration text,
  difficulty_level text not null default 'BEGINNER',
  instructor_id uuid,
  published boolean not null default true,
  archived boolean not null default false,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Add missing columns if table existed with old schema
alter table public.courses add column if not exists published boolean not null default true;
alter table public.courses add column if not exists archived boolean not null default false;
alter table public.courses add column if not exists is_published boolean not null default true;
alter table public.courses add column if not exists category_id uuid references public.course_categories(id) on delete set null;
alter table public.courses add column if not exists price numeric(12,2) not null default 5000.00;
alter table public.courses add column if not exists duration text;
alter table public.courses add column if not exists difficulty_level text not null default 'BEGINNER';
alter table public.courses add column if not exists thumbnail_url text;

-- 4. Enable RLS and create permissive policies if not exists (so anon can see published)
alter table public.course_categories enable row level security;
alter table public.courses enable row level security;

-- Drop old policies if they block anon, recreate
drop policy if exists "categories_public_read" on public.course_categories;
create policy "categories_public_read" on public.course_categories for select to anon, authenticated using (true);

drop policy if exists "courses_public_read" on public.courses;
-- Allow anon to see published courses (handles both column names)
create policy "courses_public_read" on public.courses for select to anon, authenticated using (published = true or is_published = true);

-- 5. Seed categories
insert into public.course_categories (name, description) values
  ('AI & Technology','AI skills'),('Design','Design'),('Video & Media','Video'),
  ('Marketing','Marketing'),('Web Development','Web'),('Mobile Development','Mobile'),
  ('Microsoft Office','Office')
on conflict (name) do nothing;

-- 6. Seed 12 courses as PUBLISHED (visible to students)
insert into public.courses (category_id, title, slug, description, price, duration, difficulty_level, published, archived, is_published)
select c.id, t.title, t.slug, t.description, 5000.00, t.duration, t.difficulty, true, false, true
from (values
  ('ai-video-content-creation','AI Video Content Creation','AI & Technology','Learn AI video tools','4 weeks','BEGINNER'),
  ('video-editing-with-capcut','Video Editing with CapCut','Video & Media','Master CapCut','6 weeks','BEGINNER'),
  ('graphic-design-with-canva','Graphic Design with Canva','Design','Canva design','4 weeks','BEGINNER'),
  ('digital-marketing','Digital Marketing','Marketing','Grow business online','6 weeks','BEGINNER'),
  ('mobile-application-development','Mobile Application Development','Mobile Development','Build mobile apps','10 weeks','INTERMEDIATE'),
  ('portfolio-creation','Portfolio Creation','Design','Professional portfolio','2 weeks','BEGINNER'),
  ('frontend-web-development','Frontend Web Development','Web Development','HTML CSS JS','12 weeks','INTERMEDIATE'),
  ('web-design-with-wordpress','Web Design with WordPress','Web Development','WordPress sites','5 weeks','BEGINNER'),
  ('ui-ux-design-with-figma','UI/UX Design with Figma','Design','Figma design','8 weeks','INTERMEDIATE'),
  ('microsoft-excel','Microsoft Excel','Microsoft Office','Excel mastery','4 weeks','BEGINNER'),
  ('microsoft-word','Microsoft Word','Microsoft Office','Word mastery','3 weeks','BEGINNER'),
  ('microsoft-powerpoint','Microsoft PowerPoint','Microsoft Office','PowerPoint','3 weeks','BEGINNER')
) as t(slug, title, category_name, description, duration, difficulty)
join public.course_categories c on c.name = t.category_name
on conflict (slug) do nothing;

-- 7. Force publish everything
update public.courses set published=true, archived=false, is_published=true;

-- 8. Verify — this is what students (anon) will see via API
select count(*) as total, count(*) filter (where published) as published_live, count(*) filter (where is_published) as published_legacy from public.courses;
select slug, title, published, is_published from public.courses order by created_at;

-- 9. Test anon access (should return 12 rows when you call REST API with anon key)
-- In your browser, open (replace YOUR_ANON_KEY):
-- https://vlfgnuxacprjeauqyvig.supabase.co/rest/v1/courses?select=title,slug,published&published=eq.true
-- Header: apikey: YOUR_ANON_KEY
