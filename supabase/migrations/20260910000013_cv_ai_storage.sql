-- =====================================================================
-- WOLI DAN TECH HUB — CV Builder + AI Files Storage Buckets
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('cv-exports', 'cv-exports', false, 10485760,
     array['application/pdf']),
  ('cv-photos', 'cv-photos', true, 5242880,
     array['image/jpeg', 'image/png', 'image/webp']),
  ('ai-uploads', 'ai-uploads', false, 20971520,
     array['application/pdf', 'text/plain', 'text/csv', 'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'image/jpeg', 'image/png', 'text/markdown'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- cv-exports: private, service_role via backend signed URLs, guest temporary cleanup
drop policy if exists cv_exports_admin_all on storage.objects;
create policy cv_exports_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'cv-exports' and public.is_admin())
  with check (bucket_id = 'cv-exports' and public.is_admin());

-- ai-uploads: owner only via backend
drop policy if exists ai_uploads_owner on storage.objects;
create policy ai_uploads_owner on storage.objects
  for all to authenticated
  using (bucket_id = 'ai-uploads' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'ai-uploads' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists ai_uploads_admin_all on storage.objects;
create policy ai_uploads_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'ai-uploads' and public.is_admin())
  with check (bucket_id = 'ai-uploads' and public.is_admin());

-- cv-photos: public read, owner write
drop policy if exists cv_photos_owner_write on storage.objects;
create policy cv_photos_owner_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'cv-photos');

drop policy if exists cv_photos_owner_update on storage.objects;
create policy cv_photos_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'cv-photos');

drop policy if exists cv_photos_owner_delete on storage.objects;
create policy cv_photos_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'cv-photos');
