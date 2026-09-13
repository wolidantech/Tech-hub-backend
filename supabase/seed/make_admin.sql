-- =====================================================================
-- WOLI DAN TECH HUB
-- Promote a user to admin
-- Run this in Supabase SQL Editor AFTER the user has registered
-- normally on the site (so auth.users + profiles row exists).
--
-- The signup trigger ALWAYS creates role = 'student', so no one can
-- reach /admin/login until a row is promoted by hand. Without an admin
-- you cannot publish courses, approve payments or issue certificates.
--
-- This script is IDEMPOTENT and only touches the profiles row for
-- the given email.
-- =====================================================================

-- -----------------------------------------------------------------
-- CONFIGURE THIS: replace with the real admin email
-- -----------------------------------------------------------------
-- Option 1: single email (recommended for first admin)
-- -----------------------------------------------------------------
-- Replace 'wolidantech@gmail.com' with the email you registered with
-- on https://wolidantechhub.netlify.app

-- Example for wolidantech@gmail.com:
update public.profiles
set role = 'admin',
    updated_at = now()
where email = 'wolidantech@gmail.com'
returning id, email, role, full_name;

-- -----------------------------------------------------------------
-- Option 2: promote any email — uncomment and edit below
-- -----------------------------------------------------------------
-- To promote a different user, run:
-- update public.profiles set role = 'admin' where email = 'YOUR_EMAIL_HERE';
--
-- Or to promote by auth user id:
-- update public.profiles set role = 'admin' where user_id = 'AUTH_USER_UUID';

-- -----------------------------------------------------------------
-- Option 3: promote multiple admins at once (if needed)
-- -----------------------------------------------------------------
-- update public.profiles set role = 'admin' where email in (
--   'wolidantech@gmail.com',
--   'second.admin@example.com'
-- );

-- -----------------------------------------------------------------
-- Verification — list all admins
-- -----------------------------------------------------------------
select id, email, full_name, role, created_at
from public.profiles
where role = 'admin'
order by created_at;

-- -----------------------------------------------------------------
-- Safety: ensure at least one admin exists
-- -----------------------------------------------------------------
-- If this returns 0, no one can access /admin/login
-- select count(*) as admin_count from public.profiles where role = 'admin';
