-- =====================================================================
-- WOLI DAN TECH HUB — Seed curriculum (modules + lessons) for LIVE project
-- Your courses show 0 lessons because course_modules / course_lessons are empty
-- This seeds 3 modules + 3 lessons per course (36 modules, 36 lessons total)
-- Works for both frontend schema (course_modules, course_lessons) and backend schema
-- =====================================================================

-- 1. Check current counts
select c.slug, c.title, count(m.id) as modules_count
from public.courses c
left join public.course_modules m on m.course_id = c.id
group by c.slug, c.title
order by c.title;

-- If you have course_lessons table (frontend schema)
select count(*) as total_modules from public.course_modules;
select count(*) as total_lessons from public.course_lessons;
-- If you have lessons table (backend schema)
select count(*) as total_lessons_backend from public.lessons;

-- 2. Inspect course_modules columns (to adapt seed if needed)
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='course_modules'
order by ordinal_position;

-- 3. Inspect course_lessons columns
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='course_lessons'
order by ordinal_position;

-- 4. Seed modules — 3 per course (idempotent, uses course slug + module title unique)
-- This works if course_modules has: id, course_id, title, description, order_number
do $$
declare
  r record;
  m_id uuid;
begin
  for r in select id, slug, title from public.courses loop
    -- Module 1
    insert into public.course_modules (course_id, title, description, order_number)
    values (r.id, 'Module 1: Introduction', 'Introduction to ' || r.title || ' — fundamentals and overview', 1)
    on conflict do nothing;

    -- Module 2
    insert into public.course_modules (course_id, title, description, order_number)
    values (r.id, 'Module 2: Core Skills', 'Core skills and practical techniques for ' || r.title, 2)
    on conflict do nothing;

    -- Module 3
    insert into public.course_modules (course_id, title, description, order_number)
    values (r.id, 'Module 3: Final Project', 'Build a complete project using ' || r.title || ' skills', 3)
    on conflict do nothing;
  end loop;
end $$;

-- Handle case where course_modules has unique constraint on (course_id, order_number) or (course_id, title)
-- If above failed due to unique violation, try this alternative that checks existence first:
-- (The DO block above already uses on conflict do nothing, so it should be safe)

-- 5. Seed lessons — 1 per module (so each course has 3 lessons)
-- This assumes course_lessons has: id, course_id, module_id, title, description, order_number, is_published/published
do $$
declare
  mod record;
begin
  for mod in select id, course_id, title from public.course_modules loop
    -- Try frontend schema: course_lessons with course_id, module_id, title
    begin
      if exists (select 1 from information_schema.columns where table_name='course_lessons' and column_name='course_id') then
        -- Frontend schema with course_id
        insert into public.course_lessons (course_id, module_id, title, description, order_number, is_published, published, duration)
        select mod.course_id, mod.id, 'Lesson: ' || mod.title, 'Learn ' || mod.title, 1, true, true, 10
        where not exists (select 1 from public.course_lessons where module_id = mod.id)
        on conflict do nothing;
      elsif exists (select 1 from information_schema.columns where table_name='course_lessons' and column_name='module_id') then
        -- Frontend schema without course_id
        insert into public.course_lessons (module_id, title, description, order_number, is_published)
        select mod.id, 'Lesson: ' || mod.title, 'Learn ' || mod.title, 1, true
        where not exists (select 1 from public.course_lessons where module_id = mod.id)
        on conflict do nothing;
      end if;
    exception when others then
      raise notice 'course_lessons seed error for module %: %', mod.id, SQLERRM;
    end;

    -- Try backend schema: lessons table
    begin
      if exists (select 1 from information_schema.tables where table_name='lessons') then
        insert into public.lessons (module_id, title, description, lesson_type, content, duration, order_number, is_published)
        select mod.id, 'Lesson: ' || mod.title, 'Learn ' || mod.title, 'TEXT', 'Welcome to ' || mod.title, 10, 1, true
        where not exists (select 1 from public.lessons where module_id = mod.id)
        on conflict do nothing;
      end if;
    exception when others then
      raise notice 'lessons seed error: %', SQLERRM;
    end;
  end loop;
end $$;

-- 6. Also ensure course_content table has data if your frontend uses it
do $$
begin
  if exists (select 1 from information_schema.tables where table_name='course_content') then
    -- Check columns
    perform * from information_schema.columns where table_name='course_content' and column_name='course_id';
    if found then
      insert into public.course_content (course_id, title, content, order_number)
      select c.id, 'Welcome to ' || c.title, 'Welcome to ' || c.title || '! This course will teach you everything you need.', 1
      from public.courses c
      where not exists (select 1 from public.course_content where course_id = c.id)
      on conflict do nothing;
    end if;
  end if;
exception when others then
  raise notice 'course_content seed skipped: %', SQLERRM;
end $$;

-- 7. Enable RLS policies for anon to see curriculum (if not already)
do $$
begin
  -- course_modules public read
  if exists (select 1 from information_schema.tables where table_name='course_modules') then
    execute 'alter table public.course_modules enable row level security';
    execute 'drop policy if exists "modules_public_read" on public.course_modules';
    execute 'create policy "modules_public_read" on public.course_modules for select to anon, authenticated using (true)';
  end if;

  if exists (select 1 from information_schema.tables where table_name='course_lessons') then
    execute 'alter table public.course_lessons enable row level security';
    execute 'drop policy if exists "lessons_public_read" on public.course_lessons';
    execute 'create policy "lessons_public_read" on public.course_lessons for select to anon, authenticated using (true)';
  end if;

  if exists (select 1 from information_schema.tables where table_name='lessons') then
    execute 'alter table public.lessons enable row level security';
    execute 'drop policy if exists "lessons_public_read" on public.lessons';
    execute 'create policy "lessons_public_read" on public.lessons for select to anon, authenticated using (true)';
  end if;

  if exists (select 1 from information_schema.tables where table_name='course_content') then
    execute 'alter table public.course_content enable row level security';
    execute 'drop policy if exists "content_public_read" on public.course_content';
    execute 'create policy "content_public_read" on public.course_content for select to anon, authenticated using (true)';
  end if;
end $$;

-- 8. Final verify — should show 3 modules per course, 1 lesson per module
select c.slug, count(m.id) as modules, (select count(*) from public.course_lessons cl where cl.course_id = c.id) as lessons_frontend
from public.courses c
left join public.course_modules m on m.course_id = c.id
group by c.slug
order by c.slug;

-- If you use lessons table:
select c.slug, count(m.id) as modules, count(l.id) as lessons_backend
from public.courses c
left join public.course_modules m on m.course_id = c.id
left join public.lessons l on l.module_id = m.id
group by c.slug
order by c.slug;
