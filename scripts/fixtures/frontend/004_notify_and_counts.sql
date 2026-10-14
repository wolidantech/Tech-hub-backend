-- ============================================================
-- WOLI DAN TECH HUB LMS — 004 notify + denormalized counts
-- Run after 003. Additive only; destroys no data.
-- Adds: coupon-approved notification on FREE redemptions, and a
-- server-maintained courses.lessons_count (curriculum edits in the
-- admin UI never have to remember to update the counter).
-- ============================================================

-- ---------- 1. Notify students when a FREE coupon activates enrollment ----------
-- (Partial coupons notify at payment approval instead — see approve_payment.)
create or replace function public.redeem_coupon(p_code text, p_course_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.coupons%rowtype;
  course_price int;
  uses int;
  discount int;
  due int;
  me uuid := auth.uid();
  my_email text; my_phone text;
  course_title text;
begin
  select * into c from public.coupons where code = upper(trim(p_code)) for update;
  if not found then return jsonb_build_object('valid', false, 'reason', 'Invalid coupon code'); end if;
  if not c.active then return jsonb_build_object('valid', false, 'reason', 'This coupon is inactive'); end if;
  if c.expires_at is not null and c.expires_at < now() then return jsonb_build_object('valid', false, 'reason', 'This coupon has expired'); end if;
  if c.course_id is not null and c.course_id != p_course_id then return jsonb_build_object('valid', false, 'reason', 'This coupon is not valid for this course'); end if;
  select count(*) into uses from public.coupon_redemptions where coupon_id = c.id;
  if c.max_uses is not null and uses >= c.max_uses then return jsonb_build_object('valid', false, 'reason', 'This coupon has reached its usage limit'); end if;
  select email, phone into my_email, my_phone from public.profiles where id = me;
  if c.restricted_user_id is not null and c.restricted_user_id != me then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  if c.restricted_email is not null and lower(c.restricted_email) != lower(coalesce(my_email,'')) then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  if c.restricted_phone is not null and right(regexp_replace(c.restricted_phone, '\D', '', 'g'), 10) != right(regexp_replace(coalesce(my_phone,''), '\D', '', 'g'), 10) then return jsonb_build_object('valid', false, 'reason', 'This coupon was issued to another student'); end if;
  select price, title into course_price, course_title from public.courses where id = p_course_id;
  if course_price is null then return jsonb_build_object('valid', false, 'reason', 'Course not found'); end if;
  if c.min_purchase > 0 and course_price < c.min_purchase then return jsonb_build_object('valid', false, 'reason', 'Minimum purchase not met'); end if;
  if c.discount_type = 'free' or (c.discount_type = 'percentage' and c.discount_value >= 100) then discount := course_price;
  elsif c.discount_type = 'percentage' then discount := round(course_price * c.discount_value / 100.0);
  else discount := least(c.discount_value, course_price); end if;
  due := greatest(0, course_price - discount);
  -- Resubmission-safe: an identical redemption returns the same math without a duplicate row.
  if exists (select 1 from public.coupon_redemptions r
             where r.coupon_id = c.id and r.user_id = me and r.course_id = p_course_id) then
    return jsonb_build_object('valid', true, 'discount', discount, 'amountDue', due, 'isFree', due = 0, 'duplicate', true);
  end if;
  insert into public.coupon_redemptions (coupon_id, coupon_code, user_id, course_id, discount, amount_due)
  values (c.id, c.code, me, p_course_id, discount, due);
  update public.coupons set used_count = used_count + 1 where id = c.id;
  if due = 0 then
    insert into public.enrollments (user_id, course_id, method, coupon_code)
    values (me, p_course_id, 'coupon', c.code)
    on conflict (user_id, course_id) do update set status = 'active', method = 'coupon', coupon_code = c.code;
    insert into public.student_notifications (user_id, type, title, message, course_id)
    values (me, 'coupon_approved', 'Enrollment Activated! 🎉',
      'Your coupon ' || c.code || ' was approved. You now have FULL access to ' || course_title || '. WOLI DAN TECH HUB - Learn • Build • Grow',
      p_course_id);
  end if;
  return jsonb_build_object('valid', true, 'discount', discount, 'amountDue', due, 'isFree', due = 0);
end $$;

-- ---------- 2. Server-maintained lessons_count ----------
create or replace function public.sync_lessons_count()
returns trigger language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if TG_OP = 'DELETE' then cid := old.course_id; else cid := new.course_id; end if;
  update public.courses
  set lessons_count = (select count(*) from public.course_lessons where course_id = cid)
  where id = cid;
  if TG_OP = 'DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists trg_lessons_count on public.course_lessons;
create trigger trg_lessons_count after insert or delete on public.course_lessons
  for each row execute function public.sync_lessons_count();
-- Backfill (idempotent)
update public.courses c set lessons_count = (
  select count(*) from public.course_lessons l where l.course_id = c.id
);
