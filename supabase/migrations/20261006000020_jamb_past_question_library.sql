-- =====================================================================
-- DANQEL DIGITAL INSTITUTE — JAMB past-question study library
-- Migration 020
--
-- Adds one explicit, admin-controlled release flag so an already-published
-- question can be browsed by entitled students outside a timed attempt.
--
-- This does NOT loosen the migration-017 privacy model:
--   * direct browser reads of jamb_questions / jamb_question_options /
--     jamb_exam_attempt_items stay revoked (anon + authenticated);
--   * the library API never selects is_correct, correct_option_id_snapshot
--     or explanation — answer keys remain server-side only;
--   * nothing is released by default, so an unreviewed bank stays invisible.
--
-- Idempotent: safe for both `npm run migrate` (legacy chain) and
-- `npm run migrate:frontend` (live frontend schema).
-- =====================================================================

alter table public.jamb_questions
  add column if not exists study_visible boolean not null default false;

-- The library lists only released, published questions, newest paper first.
create index if not exists idx_jamb_questions_study_library
  on public.jamb_questions (subject_id, exam_year desc, created_at desc)
  where status = 'PUBLISHED' and study_visible;

comment on column public.jamb_questions.study_visible is
  'Admin release flag: entitled students may browse this PUBLISHED question in the past-question library. Answer keys, correct options and explanations are never served.';
