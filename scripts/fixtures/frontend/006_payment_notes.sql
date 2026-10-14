-- ============================================================
-- WOLI DAN TECH HUB LMS — 006 payment submission notes
-- Run after 005. Additive only; destroys no data.
--
-- The checkout payment-submission form collects an OPTIONAL note
-- from the student (e.g. "paid from my father's account"). The
-- column is nullable and never affects verification: approval and
-- rejection still flow exclusively through approve_payment() and
-- reject_payment(), and students still cannot update any payment
-- row after submission (no student UPDATE policy exists).
-- ============================================================

alter table public.manual_payments add column if not exists note text;
