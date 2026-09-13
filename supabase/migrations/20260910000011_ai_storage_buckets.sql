-- =====================================================================
-- WOLI DAN TECH HUB
-- Migration 011: AI Content Storage Buckets
-- Adds course-videos (private, 500MB mp4/webm), course-resources (private, 50MB),
-- lesson-thumbnails (public, 5MB) for AI-generated curriculum delivery
-- All per spec 24: private + signed URLs for videos/PDFs/resources/submissions/certificates
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('course-videos',     'course-videos',     false, 524288000,
     array['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/mp2t']),
  ('course-resources',  'course-resources',  false, 52428800,
     array['application/pdf', 'image/jpeg', 'image/png', 'application/zip',
           'text/plain', 'text/csv', 'application/json',
           'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/vnd.ms-excel',
           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  ('lesson-thumbnails', 'lesson-thumbnails', true, 5242880,
     array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- course-videos: private, admin upload, student read via signed URL if enrolled + COMPLETED video
-- Backend issues signed URLs; RLS prevents direct listing
-- No direct user insert policies — service_role only via backend

-- course-resources: private, admin upload, student read if approved resource + enrollment
-- Service role handles signed URLs

-- lesson-thumbnails: public read, admin write (similar to course-thumbnails)
drop policy if exists lesson_thumbnails_admin_write on storage.objects;
create policy lesson_thumbnails_admin_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'lesson-thumbnails' and public.is_admin());

drop policy if exists lesson_thumbnails_admin_update on storage.objects;
create policy lesson_thumbnails_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'lesson-thumbnails' and public.is_admin());

drop policy if exists lesson_thumbnails_admin_delete on storage.objects;
create policy lesson_thumbnails_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'lesson-thumbnails' and public.is_admin());

-- course-videos admin write
drop policy if exists course_videos_admin_write on storage.objects;
create policy course_videos_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'course-videos' and public.is_admin())
  with check (bucket_id = 'course-videos' and public.is_admin());

-- course-resources admin write
drop policy if exists course_resources_admin_write on storage.objects;
create policy course_resources_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'course-resources' and public.is_admin())
  with check (bucket_id = 'course-resources' and public.is_admin());
