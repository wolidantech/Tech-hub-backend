-- ============================================================
-- 009 — FIX is_admin() RLS RECURSION + PUBLIC CATALOG SCOPE
-- ------------------------------------------------------------
-- profiles policies call public.is_admin().  The original invoker-rights
-- helper also selected from profiles, so evaluating those policies called the
-- helper again until PostgreSQL raised "stack depth limit exceeded".
--
-- SECURITY DEFINER makes the one fixed role lookup run as the function owner;
-- the fixed search_path prevents object-shadowing.  The helper still trusts
-- only profiles.role for the current auth.uid() — never editable JWT metadata.
--
-- Also keep public catalog/title reads aligned with courses.archived, which was
-- added in migration 002 after the original policies were created.  Enrolled
-- students retain curriculum-title access; lesson bodies and published videos
-- remain restricted to active enrollments (or admins).
--
-- Idempotent: safe to apply to an existing project and safe to re-run.
-- ============================================================

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

comment on function public.is_admin() is
  'Checks profiles.role for auth.uid(); SECURITY DEFINER avoids recursive profiles RLS evaluation.';

-- Function audit: the other SECURITY DEFINER functions are non-recursive, but
-- two functions created before migration 003 did not pin their name-resolution
-- path. Keep all elevated public functions protected from search-path shadowing.
-- ALTER FUNCTION is idempotent and does not change either function's behavior.
alter function public.verify_certificate(text) set search_path = public;
alter function public.enroll_bundle_courses(uuid, uuid, uuid[], text) set search_path = public;

-- Anonymous/authenticated storefront users may only see live, unarchived
-- courses. Admins can still manage drafts and archived records.
drop policy if exists "published courses public" on public.courses;
create policy "published courses public" on public.courses
  for select
  using (
    (published = true and coalesce(archived, false) = false)
    or public.is_admin()
  );

-- Curriculum titles are public only when their parent course is live and
-- unarchived. Active enrollments and admins keep their existing access.
drop policy if exists "modules readable" on public.course_modules;
create policy "modules readable" on public.course_modules
  for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.courses c
      where c.id = course_modules.course_id
        and c.published = true
        and coalesce(c.archived, false) = false
    )
    or exists (
      select 1
      from public.enrollments e
      where e.course_id = course_modules.course_id
        and e.user_id = auth.uid()
        and e.status = 'active'
    )
  );

drop policy if exists "lessons readable" on public.course_lessons;
create policy "lessons readable" on public.course_lessons
  for select
  using (
    public.is_admin()
    or exists (
      select 1
      from public.courses c
      where c.id = course_lessons.course_id
        and c.published = true
        and coalesce(c.archived, false) = false
    )
    or exists (
      select 1
      from public.enrollments e
      where e.course_id = course_lessons.course_id
        and e.user_id = auth.uid()
        and e.status = 'active'
    )
  );

-- Do not expose draft/processing video metadata to students. This does not
-- replace Storage RLS; uploaded files are independently protected there.
drop policy if exists "videos enrolled only" on public.course_videos;
create policy "videos enrolled only" on public.course_videos
  for select
  using (
    public.is_admin()
    or (
      status = 'published'
      and exists (
        select 1
        from public.course_lessons l
        join public.enrollments e on e.course_id = l.course_id
        where l.id = course_videos.lesson_id
          and e.user_id = auth.uid()
          and e.status = 'active'
      )
    )
  );
