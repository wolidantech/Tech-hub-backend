-- ============================================================
-- 011 — STUDENT IDENTITY + EXAM-ACCESS PRODUCTS
-- ============================================================
-- 1. Student ID cards.
--    The card is ISSUED BY THE DATABASE, never fabricated by the browser:
--    `issue_student_id_card()` requires a profile photo, allocates a unique
--    card number server-side and is idempotent. Clients can only READ their own
--    card (or, for admins, any card) — there is no client insert/update/delete,
--    so a student cannot mint or edit an identity document.
--
-- 2. Exam-access products.
--    `bundles.kind = 'exam_access'` marks a purchasable pass for the standalone
--    exam area (JAMB CBT) as opposed to a course bundle. Buying it uses the
--    existing manual bank-transfer payment + admin approval flow, so there is no
--    second payment path and no new entitlement table to drift out of sync.
--
-- No answer keys, no exam questions and no biometric data are stored here:
-- WebAuthn passkeys live in Supabase Auth, and a profile photo is an ordinary
-- storage object referenced by path.
-- ============================================================

-- ---------- 1. Exam-access products ----------
alter table public.bundles
  add column if not exists kind text not null default 'courses'
    check (kind in ('courses', 'exam_access'));

create index if not exists idx_bundles_kind on public.bundles(kind) where kind = 'exam_access';

-- ---------- 2. Student ID cards ----------
create table if not exists public.student_id_cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references public.profiles(id) on delete cascade,
  card_number text not null unique,
  full_name   text not null,
  photo_path  text not null,
  programme   text not null default 'Digital Skills',
  issued_at   timestamptz not null default now(),
  status      text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at  timestamptz
);

create index if not exists idx_id_cards_user on public.student_id_cards(user_id);
alter table public.student_id_cards enable row level security;

drop policy if exists "id cards own read" on public.student_id_cards;
create policy "id cards own read" on public.student_id_cards
  for select using (auth.uid() = user_id or public.is_admin());

-- Deliberately NO insert/update/delete policies: issuance and revocation happen
-- only through the SECURITY DEFINER functions below.

-- ---------- 3. Issuance ----------
create or replace function public.issue_student_id_card()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prof record;
  existing record;
  candidate text;
  tries int := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign in to generate your student ID card';
  end if;

  select id, full_name, avatar_url into prof from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Account setup is incomplete';
  end if;

  -- The photo is a hard requirement: the card is a photo ID.
  if coalesce(trim(prof.avatar_url), '') = '' then
    raise exception 'Upload a profile photo to generate your ID card';
  end if;

  select * into existing from public.student_id_cards where user_id = auth.uid();
  if found and existing.status = 'active' then
    -- Idempotent: refreshing the page never mints a second card.
    return jsonb_build_object(
      'id', existing.id, 'cardNumber', existing.card_number, 'fullName', existing.full_name,
      'photoPath', existing.photo_path, 'programme', existing.programme,
      'issuedAt', existing.issued_at, 'status', existing.status, 'reissued', false);
  end if;

  loop
    candidate := 'WDTH-' || to_char(now(), 'YYYY') || '-' || lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.student_id_cards where card_number = candidate);
    tries := tries + 1;
    if tries > 20 then raise exception 'Could not allocate a card number. Please try again.'; end if;
  end loop;

  if found then
    -- A revoked card is re-issued with a fresh number and the current photo.
    update public.student_id_cards
      set card_number = candidate, full_name = prof.full_name, photo_path = prof.avatar_url,
          status = 'active', issued_at = now(), revoked_at = null
      where user_id = auth.uid()
      returning * into existing;
  else
    insert into public.student_id_cards (user_id, card_number, full_name, photo_path)
    values (auth.uid(), candidate, prof.full_name, prof.avatar_url)
    returning * into existing;
  end if;

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (prof.full_name, prof.full_name, 'id_card.issue', 'student_id_card', existing.id::text,
          jsonb_build_object('cardNumber', existing.card_number, 'userId', auth.uid()));

  return jsonb_build_object(
    'id', existing.id, 'cardNumber', existing.card_number, 'fullName', existing.full_name,
    'photoPath', existing.photo_path, 'programme', existing.programme,
    'issuedAt', existing.issued_at, 'status', existing.status, 'reissued', true);
end $$;

-- ---------- 4. Revocation (admin only) ----------
create or replace function public.revoke_student_id_card(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  admin_email text;
  card record;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select email into admin_email from public.profiles where id = auth.uid();

  update public.student_id_cards
    set status = 'revoked', revoked_at = now()
    where user_id = p_user_id and status = 'active'
    returning * into card;
  if not found then raise exception 'No active ID card for that student'; end if;

  insert into public.audit_logs (actor_email, actor_name, action, entity_type, entity_id, details)
  values (admin_email, admin_email, 'id_card.revoke', 'student_id_card', card.id::text,
          jsonb_build_object('cardNumber', card.card_number, 'userId', p_user_id));

  return jsonb_build_object('ok', true, 'cardNumber', card.card_number);
end $$;
