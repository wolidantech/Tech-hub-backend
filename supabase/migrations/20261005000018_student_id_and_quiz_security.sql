-- =====================================================================
-- WOLI DAN TECH HUB — Student identity cards + quiz answer protection
-- Migration 018
-- =====================================================================

-- Stable, server-assigned student numbers. Existing profiles are backfilled
-- once; future profiles receive a number in the BEFORE INSERT trigger.
create sequence if not exists public.student_number_seq start with 1;
alter table public.profiles add column if not exists student_number text;

update public.profiles p
set student_number = 'WDTH-' || to_char(coalesce(p.created_at, now()), 'YYYY') || '-' ||
                     lpad(nextval('public.student_number_seq')::text, 6, '0')
where p.student_number is null;

create unique index if not exists uq_profiles_student_number
  on public.profiles (student_number) where student_number is not null;

create or replace function public.assign_student_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.student_number is null or btrim(new.student_number) = '' then
    new.student_number := 'WDTH-' || to_char(coalesce(new.created_at, now()), 'YYYY') || '-' ||
                          lpad(nextval('public.student_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_assign_student_number on public.profiles;
create trigger trg_profiles_assign_student_number
  before insert on public.profiles
  for each row execute function public.assign_student_number();

create or replace function public.protect_student_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.student_number is distinct from old.student_number
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'FORBIDDEN: student number is system assigned';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_student_number_guard on public.profiles;
create trigger trg_profiles_student_number_guard
  before update of student_number on public.profiles
  for each row execute function public.protect_student_number();

create table if not exists public.student_id_cards (
  profile_id          uuid primary key references public.profiles(id) on delete cascade,
  student_number      text not null unique,
  status              text not null default 'PENDING_PHOTO'
    check (status in ('PENDING_PHOTO', 'PENDING_GENERATION', 'GENERATED', 'REVOKED')),
  card_storage_path   text,
  issued_at           timestamptz,
  last_generated_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint chk_student_id_generated_path check (status <> 'GENERATED' or card_storage_path is not null)
);

create index if not exists idx_student_id_cards_status on public.student_id_cards (status);

create or replace function public.sync_student_id_card()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.student_id_cards (profile_id, student_number, status)
  values (
    new.id,
    new.student_number,
    case when nullif(trim(new.profile_photo_url), '') is null
      then 'PENDING_PHOTO' else 'PENDING_GENERATION' end
  )
  on conflict (profile_id) do update set
    student_number = excluded.student_number,
    status = case
      when public.student_id_cards.status = 'REVOKED' then 'REVOKED'
      when nullif(trim(new.profile_photo_url), '') is null then 'PENDING_PHOTO'
      else 'PENDING_GENERATION'
    end,
    card_storage_path = null,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_student_id_card_insert on public.profiles;
create trigger trg_profiles_student_id_card_insert
  after insert on public.profiles
  for each row execute function public.sync_student_id_card();

drop trigger if exists trg_profiles_student_id_card_photo on public.profiles;
create trigger trg_profiles_student_id_card_photo
  after update of profile_photo_url on public.profiles
  for each row when (new.profile_photo_url is distinct from old.profile_photo_url)
  execute function public.sync_student_id_card();

-- Backfill one card row per existing profile. Cards wait for photo upload.
insert into public.student_id_cards (profile_id, student_number, status)
select p.id, p.student_number,
       case when nullif(trim(p.profile_photo_url), '') is null
         then 'PENDING_PHOTO' else 'PENDING_GENERATION' end
from public.profiles p
where p.student_number is not null
on conflict (profile_id) do nothing;

alter table public.student_id_cards enable row level security;
drop policy if exists student_id_card_read_own on public.student_id_cards;
create policy student_id_card_read_own on public.student_id_cards
  for select to authenticated
  using (profile_id = public.current_profile_id() or public.is_admin());
drop policy if exists student_id_card_admin_write on public.student_id_cards;
create policy student_id_card_admin_write on public.student_id_cards
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.set_student_id_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists trg_student_id_cards_updated_at on public.student_id_cards;
create trigger trg_student_id_cards_updated_at before update on public.student_id_cards
  for each row execute function public.set_student_id_updated_at();

-- Private PDF bucket. Objects are served only through short-lived backend
-- signed URLs; no direct storage.objects policy is granted to students.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-id-cards', 'student-id-cards', false, 5242880, array['application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- A table RLS policy cannot hide selected columns. Revoke direct student
-- REST reads of quiz rows/options containing answer keys. Students must use
-- the backend's answer-stripping quiz endpoint/RPC; admins use service_role
-- through the protected backend routes.
revoke select on public.quiz_questions from anon, authenticated;
revoke select on public.quiz_options from anon, authenticated;
