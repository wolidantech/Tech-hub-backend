-- =====================================================================
-- WOLI DAN TECH HUB
-- Migration 007: Fix live project where courses uses `published` not `is_published`
-- The live Supabase project (vlfgnuxacprjeauqyvig) was created from frontend
-- repo migrations which use `published`/`archived`, while this backend repo
-- uses `is_published`. This migration handles BOTH schemas idempotently.
-- =====================================================================

do $$
begin
  -- Live schema: published + archived
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='courses' and column_name='published') then
    execute 'update public.courses set published = true where published = false or published is null';
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='courses' and column_name='archived') then
      execute 'update public.courses set archived = false where archived = true';
    end if;
  end if;

  -- Backend repo schema: is_published
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='courses' and column_name='is_published') then
    execute 'update public.courses set is_published = true where is_published = false';
  end if;

  -- Lessons - try all possible table/column combos
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='lessons' and column_name='published') then
    execute 'update public.lessons set published = true where published = false or published is null';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='lessons' and column_name='is_published') then
    execute 'update public.lessons set is_published = true where is_published = false';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='course_lessons' and column_name='published') then
    execute 'update public.course_lessons set published = true where published = false or published is null';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='course_lessons' and column_name='is_published') then
    execute 'update public.course_lessons set is_published = true where is_published = false';
  end if;
end $$;
