-- =====================================================================
-- WOLI DAN TECH HUB
-- Publish all courses — makes them visible to students
-- Run this AFTER seed_12_courses.sql in Supabase SQL Editor
--
-- RLS: courses_public_read only exposes is_published = true
-- Without this step, the storefront stays empty even though data exists,
-- which is why the frontend diagnostics shows [FAIL] Course catalog
-- =====================================================================

-- Publish every course that is currently a draft
update public.courses
set is_published = true,
    updated_at = now()
where is_published = false;

-- Optionally publish all lessons/modules that were seeded as published
-- (this is safe — modules/lessons visibility is still gated by course published flag)
update public.lessons
set is_published = true,
    updated_at = now()
where is_published = false;

-- Verification query — should show 12 published courses
select
  c.slug,
  c.title,
  cc.name as category,
  c.price,
  c.is_published,
  c.created_at
from public.courses c
left join public.course_categories cc on cc.id = c.category_id
order by c.created_at;

-- Expected: 12 rows, all is_published = true
-- If anon key still sees 0 rows, check RLS:
-- select * from public.courses where is_published = true; -- as anon via API should return rows
