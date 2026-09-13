-- =====================================================================
-- WOLI DAN TECH HUB — LIVE PROJECT FIX (project vlfgnuxacprjeauqyvig)
-- Your live DB uses `courses.published` (not `is_published`) and
-- `courses.archived`. This file fixes the [FAIL] Course catalog error.
-- Paste this WHOLE file into Supabase SQL Editor and Run.
-- =====================================================================

-- 1. See what columns your live courses table actually has
select column_name, data_type
from information_schema.columns
where table_schema='public' and table_name='courses'
order by ordinal_position;

-- 2. Publish all courses — handles BOTH schemas (published vs is_published)
do $$
begin
  -- Live schema: published + archived
  if exists (select 1 from information_schema.columns where table_name='courses' and column_name='published') then
    execute 'update public.courses set published = true where published = false or published is null';
    if exists (select 1 from information_schema.columns where table_name='courses' and column_name='archived') then
      execute 'update public.courses set archived = false where archived = true or archived is null';
    end if;
    raise notice 'Fixed live schema (published/archived)';
  end if;

  -- Legacy/backend repo schema: is_published
  if exists (select 1 from information_schema.columns where table_name='courses' and column_name='is_published') then
    execute 'update public.courses set is_published = true where is_published = false';
    raise notice 'Fixed legacy schema (is_published)';
  end if;
end $$;

-- 3. Also publish lessons if they have published/is_published flag
do $$
begin
  if exists (select 1 from information_schema.columns where table_name='lessons' and column_name='published') then
    execute 'update public.lessons set published = true where published = false or published is null';
  end if;
  if exists (select 1 from information_schema.columns where table_name='lessons' and column_name='is_published') then
    execute 'update public.lessons set is_published = true where is_published = false';
  end if;
  if exists (select 1 from information_schema.columns where table_name='course_lessons' and column_name='published') then
    execute 'update public.course_lessons set published = true where published = false or published is null';
  end if;
  if exists (select 1 from information_schema.columns where table_name='course_lessons' and column_name='is_published') then
    execute 'update public.course_lessons set is_published = true where is_published = false';
  end if;
end $$;

-- 4. If courses table is STILL empty, seed 12 courses (works for both schemas)
-- This will insert only if count is 0
do $$
declare
  v_count int;
  v_has_published boolean;
  v_has_is_published boolean;
  v_has_archived boolean;
begin
  select count(*) into v_count from public.courses;
  if v_count > 0 then
    raise notice 'Courses already exist: % rows, skipping seed', v_count;
    return;
  end if;

  select exists(select 1 from information_schema.columns where table_name='courses' and column_name='published') into v_has_published;
  select exists(select 1 from information_schema.columns where table_name='courses' and column_name='is_published') into v_has_is_published;
  select exists(select 1 from information_schema.columns where table_name='courses' and column_name='archived') into v_has_archived;

  -- Ensure categories exist (for both schemas, categories table is same)
  insert into public.course_categories (name, description) values
    ('AI & Technology','AI skills'),('Design','Design'),('Video & Media','Video'),
    ('Marketing','Marketing'),('Web Development','Web'),('Mobile Development','Mobile'),
    ('Microsoft Office','Office')
  on conflict (name) do nothing;

  -- Seed using dynamic SQL based on actual columns
  if v_has_published then
    -- Live schema uses published/archived
    execute '
    insert into public.courses (category_id, title, slug, description, price, duration, difficulty_level, published, archived)
    select c.id, t.title, t.slug, t.description, 5000.00, t.duration, t.difficulty::public.difficulty_level, true, false
    from (values
        (''ai-video-content-creation'',''AI Video Content Creation'',''AI & Technology'',''Learn AI video tools'',''4 weeks'',''BEGINNER''),
        (''video-editing-with-capcut'',''Video Editing with CapCut'',''Video & Media'',''Master CapCut'',''6 weeks'',''BEGINNER''),
        (''graphic-design-with-canva'',''Graphic Design with Canva'',''Design'',''Design with Canva'',''4 weeks'',''BEGINNER''),
        (''digital-marketing'',''Digital Marketing'',''Marketing'',''Grow business online'',''6 weeks'',''BEGINNER''),
        (''mobile-application-development'',''Mobile Application Development'',''Mobile Development'',''Build mobile apps'',''10 weeks'',''INTERMEDIATE''),
        (''portfolio-creation'',''Portfolio Creation'',''Design'',''Professional portfolio'',''2 weeks'',''BEGINNER''),
        (''frontend-web-development'',''Frontend Web Development'',''Web Development'',''HTML CSS JS'',''12 weeks'',''INTERMEDIATE''),
        (''web-design-with-wordpress'',''Web Design with WordPress'',''Web Development'',''WordPress sites'',''5 weeks'',''BEGINNER''),
        (''ui-ux-design-with-figma'',''UI/UX Design with Figma'',''Design'',''Figma design'',''8 weeks'',''INTERMEDIATE''),
        (''microsoft-excel'',''Microsoft Excel'',''Microsoft Office'',''Excel mastery'',''4 weeks'',''BEGINNER''),
        (''microsoft-word'',''Microsoft Word'',''Microsoft Office'',''Word mastery'',''3 weeks'',''BEGINNER''),
        (''microsoft-powerpoint'',''Microsoft PowerPoint'',''Microsoft Office'',''PowerPoint'',''3 weeks'',''BEGINNER'')
    ) as t(slug, title, category_name, description, duration, difficulty)
    join public.course_categories c on c.name = t.category_name
    on conflict (slug) do nothing';
  elsif v_has_is_published then
    execute '
    insert into public.courses (category_id, title, slug, description, price, duration, difficulty_level, is_published)
    select c.id, t.title, t.slug, t.description, 5000.00, t.duration, t.difficulty::public.difficulty_level, true
    from (values
        (''ai-video-content-creation'',''AI Video Content Creation'',''AI & Technology'',''Learn AI video tools'',''4 weeks'',''BEGINNER''),
        (''video-editing-with-capcut'',''Video Editing with CapCut'',''Video & Media'',''Master CapCut'',''6 weeks'',''BEGINNER''),
        (''graphic-design-with-canva'',''Graphic Design with Canva'',''Design'',''Design with Canva'',''4 weeks'',''BEGINNER''),
        (''digital-marketing'',''Digital Marketing'',''Marketing'',''Grow business online'',''6 weeks'',''BEGINNER''),
        (''mobile-application-development'',''Mobile Application Development'',''Mobile Development'',''Build mobile apps'',''10 weeks'',''INTERMEDIATE''),
        (''portfolio-creation'',''Portfolio Creation'',''Design'',''Professional portfolio'',''2 weeks'',''BEGINNER''),
        (''frontend-web-development'',''Frontend Web Development'',''Web Development'',''HTML CSS JS'',''12 weeks'',''INTERMEDIATE''),
        (''web-design-with-wordpress'',''Web Design with WordPress'',''Web Development'',''WordPress sites'',''5 weeks'',''BEGINNER''),
        (''ui-ux-design-with-figma'',''UI/UX Design with Figma'',''Design'',''Figma design'',''8 weeks'',''INTERMEDIATE''),
        (''microsoft-excel'',''Microsoft Excel'',''Microsoft Office'',''Excel mastery'',''4 weeks'',''BEGINNER''),
        (''microsoft-word'',''Microsoft Word'',''Microsoft Office'',''Word mastery'',''3 weeks'',''BEGINNER''),
        (''microsoft-powerpoint'',''Microsoft PowerPoint'',''Microsoft Office'',''PowerPoint'',''3 weeks'',''BEGINNER'')
    ) as t(slug, title, category_name, description, duration, difficulty)
    join public.course_categories c on c.name = t.category_name
    on conflict (slug) do nothing';
  end if;
end $$;

-- 5. FINAL VERIFY — what students (anon) will see
select
  'courses table' as check,
  count(*) as total,
  count(*) filter (where (case when exists(select 1 from information_schema.columns where table_name='courses' and column_name='published') then published else is_published end)) as published_visible
from public.courses;

-- Show actual rows
select id, title, slug,
  case when exists(select 1 from information_schema.columns where table_name='courses' and column_name='published') then published::text else is_published::text end as is_published_now
from public.courses
order by created_at
limit 20;
