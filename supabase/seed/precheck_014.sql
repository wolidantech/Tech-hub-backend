-- =====================================================================
-- STEP 0 (paste FIRST, click Run): pre-check before seeding Biology.
-- Run this in the Supabase dashboard SQL Editor. It only READS — it
-- changes nothing. Both queries must succeed; if anything shows
-- MISSING, stop and paste the output back for help.
-- =====================================================================

-- 1) Do the 014 curriculum tables exist? Expect 13 rows, all "present".
select t.tbl as table_name,
       case when to_regclass('public.' || t.tbl) is null then 'MISSING' else 'present' end as status
from (values ('courses'), ('course_modules'), ('course_topics'), ('lessons'),
             ('lesson_contents'), ('course_resources'), ('lesson_videos'),
             ('lesson_practicals'), ('assignments'), ('quizzes'),
             ('quiz_questions'), ('quiz_options'), ('course_assessments')) as t(tbl)
order by 1;

-- 2) Is migration 015 already applied? Expect "not applied" on first run.
select case when count(*) > 0 then 'already applied — safe to re-run anyway (idempotent)'
            else 'not applied — proceed to Step 1' end as migration_015_status
from information_schema.columns
where table_schema = 'public'
  and table_name = 'course_modules'
  and column_name = 'seed_key';
