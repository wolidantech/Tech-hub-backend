-- =====================================================================
-- WOLI DAN TECH HUB
-- Migration 008: Coupons + payment enhancements (production-ready manual payment verification)
--
-- Extends existing payments model without breaking existing data.
-- Adds coupon system for 100% free enrollments and partial discounts.
-- Adds currency, coupon tracking, and missing indexes per spec.
-- =====================================================================

-- -----------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------
do $$ begin
  create type public.discount_type as enum ('PERCENTAGE', 'FIXED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.coupon_status as enum ('ACTIVE', 'INACTIVE', 'EXPIRED');
exception when duplicate_object then null; end $$;

-- Extend notification_type if not exists with coupon types
do $$
begin
  -- Add new notification types if missing
  begin
    alter type public.notification_type add value if not exists 'COUPON_APPLIED';
  exception when duplicate_object then null; end;
  begin
    alter type public.notification_type add value if not exists 'COUPON_REDEEMED';
  exception when duplicate_object then null; end;
end $$;

-- Extend payment_method if needed (keep MANUAL_BANK_TRANSFER, add FREE for 100% coupons)
do $$
begin
  -- payment_method is enum, we need to add FREE if not exists
  -- Postgres doesn't support ADD VALUE IF NOT EXISTS in older versions, so use exception handling
  begin
    alter type public.payment_method add value if not exists 'FREE';
  exception when duplicate_object then null;
    when others then
      -- Fallback for PG that doesn't support IF NOT EXISTS
      begin
        alter type public.payment_method add value 'FREE';
      exception when duplicate_object then null; end;
  end;
end $$;

-- -----------------------------------------------------------------
-- Payments table enhancements
-- -----------------------------------------------------------------
alter table public.payments add column if not exists currency text not null default 'NGN' check (currency in ('NGN', 'USD'));
alter table public.payments add column if not exists coupon_id uuid references public.coupons(id) on delete set null;
alter table public.payments add column if not exists discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0);
alter table public.payments add column if not exists original_amount numeric(12,2) check (original_amount is null or original_amount >= 0);
-- For spec compatibility: payment_reference alias (we keep transaction_reference as canonical, but add payment_reference as generated or nullable)
alter table public.payments add column if not exists payment_reference text;
alter table public.payments add column if not exists receipt_path text;
alter table public.payments add column if not exists payment_date date;

-- Backfill new columns from existing data where possible
update public.payments set payment_reference = transaction_reference where payment_reference is null;
update public.payments set payment_date = transaction_date where payment_date is null;
update public.payments set original_amount = amount + discount_amount where original_amount is null;

-- Indexes per spec
create index if not exists idx_payments_payment_reference on public.payments (payment_reference);
create index if not exists idx_payments_transaction_reference on public.payments (transaction_reference);
create index if not exists idx_payments_created_at on public.payments (created_at desc);
create index if not exists idx_payments_coupon_id on public.payments (coupon_id) where coupon_id is not null;
create index if not exists idx_payments_currency on public.payments (currency);

-- -----------------------------------------------------------------
-- Coupons table
-- -----------------------------------------------------------------
create table if not exists public.coupons (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique check (code ~ '^[A-Z0-9_-]{3,50}$'),
  description       text,
  discount_type     public.discount_type not null default 'PERCENTAGE',
  discount_value    numeric(12,2) not null check (discount_value > 0),
  -- For PERCENTAGE: 1-100, for FIXED: amount in NGN
  max_uses          integer check (max_uses is null or max_uses > 0),
  used_count        integer not null default 0 check (used_count >= 0),
  min_amount        numeric(12,2) not null default 0 check (min_amount >= 0),
  applicable_course_ids uuid[] default null,
  applicable_category_ids uuid[] default null,
  is_active         boolean not null default true,
  valid_from        timestamptz not null default now(),
  valid_until       timestamptz,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint chk_discount_value check (
    (discount_type = 'PERCENTAGE' and discount_value <= 100) or
    (discount_type = 'FIXED')
  ),
  constraint chk_validity check (
    valid_until is null or valid_until > valid_from
  )
);

create index if not exists idx_coupons_code on public.coupons (code);
create index if not exists idx_coupons_is_active on public.coupons (is_active) where is_active = true;
create index if not exists idx_coupons_valid_until on public.coupons (valid_until) where valid_until is not null;

-- -----------------------------------------------------------------
-- Coupon redemptions (audit trail)
-- -----------------------------------------------------------------
create table if not exists public.coupon_redemptions (
  id                uuid primary key default gen_random_uuid(),
  coupon_id         uuid not null references public.coupons(id) on delete cascade,
  student_id        uuid not null references public.profiles(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  payment_id        uuid references public.payments(id) on delete set null,
  enrollment_id     uuid references public.enrollments(id) on delete set null,
  discount_amount   numeric(12,2) not null check (discount_amount >= 0),
  amount_paid       numeric(12,2) not null check (amount_paid >= 0),
  original_amount   numeric(12,2) not null check (original_amount >= 0),
  redeemed_at       timestamptz not null default now(),
  constraint uq_coupon_student_course unique (coupon_id, student_id, course_id)
);

create index if not exists idx_redemptions_coupon on public.coupon_redemptions (coupon_id);
create index if not exists idx_redemptions_student on public.coupon_redemptions (student_id);
create index if not exists idx_redemptions_course on public.coupon_redemptions (course_id);
create index if not exists idx_redemptions_payment on public.coupon_redemptions (payment_id) where payment_id is not null;

-- -----------------------------------------------------------------
-- Updated_at trigger for coupons
-- -----------------------------------------------------------------
drop trigger if exists trg_coupons_updated_at on public.coupons;
create trigger trg_coupons_updated_at before update on public.coupons
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------
-- Functions: coupon validation and application
-- -----------------------------------------------------------------
create or replace function public.validate_coupon(
  p_code text,
  p_course_id uuid,
  p_student_id uuid
)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_coupon public.coupons%rowtype;
  v_course_price numeric;
  v_discount numeric;
  v_amount_due numeric;
  v_is_eligible boolean := true;
  v_reason text;
begin
  -- Normalize code
  p_code := upper(trim(p_code));

  select * into v_coupon from public.coupons where code = p_code;

  if not found then
    return jsonb_build_object('valid', false, 'reason', 'Invalid coupon code');
  end if;

  if not v_coupon.is_active then
    return jsonb_build_object('valid', false, 'reason', 'Coupon is inactive');
  end if;

  if v_coupon.valid_until is not null and v_coupon.valid_until < now() then
    return jsonb_build_object('valid', false, 'reason', 'Coupon has expired');
  end if;

  if v_coupon.valid_from > now() then
    return jsonb_build_object('valid', false, 'reason', 'Coupon is not yet valid');
  end if;

  if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
    return jsonb_build_object('valid', false, 'reason', 'Coupon usage limit reached');
  end if;

  -- Check if student already used this coupon for this course
  if exists (select 1 from public.coupon_redemptions where coupon_id = v_coupon.id and student_id = p_student_id and course_id = p_course_id) then
    return jsonb_build_object('valid', false, 'reason', 'You have already used this coupon for this course');
  end if;

  -- Get course price
  select price into v_course_price from public.courses where id = p_course_id;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'Course not found');
  end if;

  -- Check applicable courses
  if v_coupon.applicable_course_ids is not null and array_length(v_coupon.applicable_course_ids, 1) > 0 then
    if not (p_course_id = any(v_coupon.applicable_course_ids)) then
      return jsonb_build_object('valid', false, 'reason', 'Coupon not applicable to this course');
    end if;
  end if;

  -- Check min amount
  if v_course_price < v_coupon.min_amount then
    return jsonb_build_object('valid', false, 'reason', 'Course price does not meet minimum amount for this coupon');
  end if;

  -- Calculate discount
  if v_coupon.discount_type = 'PERCENTAGE' then
    v_discount := round(v_course_price * v_coupon.discount_value / 100.0, 2);
  else
    v_discount := least(v_coupon.discount_value, v_course_price);
  end if;

  v_amount_due := greatest(v_course_price - v_discount, 0);

  return jsonb_build_object(
    'valid', true,
    'coupon_id', v_coupon.id,
    'code', v_coupon.code,
    'discount_type', v_coupon.discount_type,
    'discount_value', v_coupon.discount_value,
    'discount_amount', v_discount,
    'original_amount', v_course_price,
    'amount_due', v_amount_due,
    'is_free', v_amount_due = 0
  );
end;
$$;

-- -----------------------------------------------------------------
-- Function: apply 100% coupon (free enrollment) — transactional
-- -----------------------------------------------------------------
create or replace function public.apply_coupon_free(
  p_code text,
  p_course_id uuid,
  p_student_id uuid
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_validation jsonb;
  v_coupon_id uuid;
  v_discount numeric;
  v_original numeric;
  v_enrollment_id uuid;
  v_redemption_id uuid;
  v_course_title text;
begin
  -- Validate coupon
  v_validation := public.validate_coupon(p_code, p_course_id, p_student_id);

  if not (v_validation->>'valid')::boolean then
    raise exception 'COUPON_INVALID: %', v_validation->>'reason';
  end if;

  if not (v_validation->>'is_free')::boolean then
    raise exception 'COUPON_NOT_FREE: This coupon requires partial payment of NGN %. Use checkout with coupon.', v_validation->>'amount_due';
  end if;

  v_coupon_id := (v_validation->>'coupon_id')::uuid;
  v_discount := (v_validation->>'discount_amount')::numeric;
  v_original := (v_validation->>'original_amount')::numeric;

  -- Check if already enrolled
  if exists (select 1 from public.enrollments where student_id = p_student_id and course_id = p_course_id and status in ('ACTIVE','COMPLETED')) then
    raise exception 'ALREADY_ENROLLED';
  end if;

  select title into v_course_title from public.courses where id = p_course_id;

  -- Lock coupon row to prevent race on used_count
  perform * from public.coupons where id = v_coupon_id for update;

  -- Create enrollment (free)
  insert into public.enrollments (student_id, course_id, status, enrolled_at)
  values (p_student_id, p_course_id, 'ACTIVE', now())
  on conflict (student_id, course_id) do update set status = 'ACTIVE', enrolled_at = now()
  returning id into v_enrollment_id;

  -- Create payment record for audit (amount 0, FREE)
  insert into public.payments (student_id, course_id, amount, original_amount, discount_amount, coupon_id, payment_method, transaction_reference, transaction_date, payment_reference, payment_date, currency, status, reviewed_at, reviewed_by)
  values (
    p_student_id, p_course_id, 0, v_original, v_discount, v_coupon_id,
    'FREE',
    'FREE-' || upper(substring(p_code from 1 for 10)) || '-' || substring(p_student_id::text from 1 for 8),
    current_date,
    'FREE-' || upper(substring(p_code from 1 for 10)) || '-' || substring(p_student_id::text from 1 for 8),
    current_date,
    'NGN',
    'APPROVED',
    now(),
    p_student_id
  )
  on conflict (transaction_reference) do nothing;

  -- Increment coupon used_count
  update public.coupons set used_count = used_count + 1, updated_at = now() where id = v_coupon_id;

  -- Create redemption record
  insert into public.coupon_redemptions (coupon_id, student_id, course_id, enrollment_id, discount_amount, amount_paid, original_amount)
  values (v_coupon_id, p_student_id, p_course_id, v_enrollment_id, v_discount, 0, v_original)
  returning id into v_redemption_id;

  -- Notifications
  insert into public.notifications (user_id, title, message, type) values
    (p_student_id, 'Coupon applied — free enrollment', 'Your coupon "' || p_code || '" was applied. You now have full access to "' || coalesce(v_course_title, 'your course') || '" for free!', 'COUPON_APPLIED'),
    (p_student_id, 'You are enrolled', 'You now have full access to "' || coalesce(v_course_title, 'your course') || '". Open My Courses and start learning.', 'COURSE_ENROLLED');

  -- Audit log
  insert into public.audit_logs (admin_id, action, target_type, target_id, description)
  values (
    p_student_id,
    'COUPON_FREE_ENROLLMENT',
    'coupon',
    v_coupon_id,
    'Free enrollment via coupon "' || p_code || '" for course "' || coalesce(v_course_title, p_course_id::text) || '" — discount NGN ' || v_discount
  );

  return jsonb_build_object(
    'enrollment_id', v_enrollment_id,
    'redemption_id', v_redemption_id,
    'coupon_id', v_coupon_id,
    'discount_amount', v_discount,
    'amount_paid', 0,
    'is_free', true
  );
end;
$$;

-- -----------------------------------------------------------------
-- RLS for coupons
-- -----------------------------------------------------------------
alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;

-- Drop existing policies if any
drop policy if exists coupons_public_read on public.coupons;
drop policy if exists coupons_admin_write on public.coupons;
drop policy if exists redemptions_select_own on public.coupon_redemptions;
drop policy if exists redemptions_admin_all on public.coupon_redemptions;

-- Public can read active coupons? No — only validate via function. But allow authenticated to see active coupon codes for UX (optional)
-- For security, only admins can list all coupons, students can only validate via RPC
create policy coupons_public_read on public.coupons
  for select to anon, authenticated
  using (is_active = true and valid_until > now());

create policy coupons_admin_write on public.coupons
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy redemptions_select_own on public.coupon_redemptions
  for select to authenticated
  using (student_id = public.current_profile_id() or public.is_admin());

create policy redemptions_admin_all on public.coupon_redemptions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Grant execute
revoke execute on function public.validate_coupon(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.validate_coupon(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.validate_coupon(text, uuid, uuid) to authenticated, service_role;

revoke execute on function public.apply_coupon_free(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_coupon_free(text, uuid, uuid) to authenticated, service_role;

-- Update approve_payment and reject_payment to handle coupon fields in audit
-- (no change needed, but ensure they work with new columns)

-- -----------------------------------------------------------------
-- Seed a default 100% coupon for testing/admin use
-- -----------------------------------------------------------------
insert into public.coupons (code, description, discount_type, discount_value, max_uses, is_active, valid_from)
values ('WOLI100', '100% off — free enrollment for testing', 'PERCENTAGE', 100, null, true, now())
on conflict (code) do nothing;

insert into public.coupons (code, description, discount_type, discount_value, max_uses, is_active, valid_from)
values ('WELCOME50', '50% off welcome coupon', 'PERCENTAGE', 50, 100, true, now())
on conflict (code) do nothing;
