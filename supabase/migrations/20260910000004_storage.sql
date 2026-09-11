-- =====================================================================
-- WOLI DAN TECH HUB
-- Migration 004: Supabase Storage buckets & object policies
--
--  payment-receipts   PRIVATE (jpg/jpeg/png/pdf, 5MB) — signed URLs
--  certificates       PRIVATE (pdf, 5MB)              — signed URLs
--  lesson-resources   PRIVATE (pdf/images/docs, 20MB) — signed URLs
--  avatars            PUBLIC  (images, 2MB)
--  course-thumbnails  PUBLIC  (images, 5MB)
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('payment-receipts',  'payment-receipts',  false, 5242880,
     array['image/jpeg', 'image/png', 'application/pdf']),
  ('certificates',      'certificates',      false, 5242880,
     array['application/pdf']),
  ('lesson-resources',  'lesson-resources',  false, 20971520,
     array['application/pdf', 'image/jpeg', 'image/png', 'application/zip',
           'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/vnd.ms-excel',
           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
           'application/vnd.ms-powerpoint',
           'application/vnd.openxmlformats-officedocument.presentationml.presentation']),
  ('avatars',           'avatars',           true,  2097152,
     array['image/jpeg', 'image/png', 'image/webp']),
  ('course-thumbnails', 'course-thumbnails', true,  5242880,
     array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------
-- payment-receipts: convention <student_user_id>/<payment_id>/<file>
-- Only the owning student (matching folder) or an admin may touch
-- objects; the BACKEND additionally issues short-lived signed URLs.
-- -----------------------------------------------------------------
drop policy if exists receipts_insert_owner on storage.objects;
create policy receipts_insert_owner on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'payment-receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists receipts_select_owner on storage.objects;
create policy receipts_select_owner on storage.objects
  for select to authenticated
  using (
    bucket_id = 'payment-receipts'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  );

drop policy if exists receipts_admin_all on storage.objects;
create policy receipts_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'payment-receipts' and public.is_admin())
  with check (bucket_id = 'payment-receipts' and public.is_admin());

-- -----------------------------------------------------------------
-- certificates & lesson-resources: PRIVATE. No direct user policies
-- — access happens exclusively through backend-issued signed URLs
-- (service role), which keeps receipts/resources off the open web.
-- -----------------------------------------------------------------

-- -----------------------------------------------------------------
-- avatars: public read (bucket is public); owners manage their folder
-- -----------------------------------------------------------------
drop policy if exists avatars_owner_write on storage.objects;
create policy avatars_owner_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  );

-- -----------------------------------------------------------------
-- course-thumbnails: public read; only admins upload/modify
-- -----------------------------------------------------------------
drop policy if exists thumbnails_admin_write on storage.objects;
create policy thumbnails_admin_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'course-thumbnails' and public.is_admin());

drop policy if exists thumbnails_admin_update on storage.objects;
create policy thumbnails_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'course-thumbnails' and public.is_admin());

drop policy if exists thumbnails_admin_delete on storage.objects;
create policy thumbnails_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'course-thumbnails' and public.is_admin());
