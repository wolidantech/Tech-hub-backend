-- ============================================================
-- 005: public showcase reads (additive; no changes to 001–004)
-- - Lets ANYONE (including logged-out visitors) read the image files
--   behind the public project showcase: approved file submissions
--   (images) from students with a public portfolio.
-- - Everything else in `submissions` stays owner+admin only.
-- ============================================================

drop policy if exists "showcase public read" on storage.objects;
create policy "showcase public read" on storage.objects
  for select using (
    bucket_id = 'submissions'
    and exists (
      select 1
      from public.assignment_submissions s
      join public.profiles p on p.id = s.user_id
      where s.storage_path = storage.objects.name
        and s.status = 'approved'
        and s.kind = 'file'
        and s.file_type like 'image/%'
        and coalesce(p.portfolio_public, true) = true
    )
  );
