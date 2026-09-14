-- =====================================================================
-- STEP 6 (paste LAST, click Run): confirm Biology seeded completely.
-- Run AFTER Steps 1–5. Every row must show status 'OK'.
-- =====================================================================

with counts as (
  select (select count(*) from public.course_modules where seed_key like 'biology:%') as modules,
         (select count(*) from public.course_topics where seed_key like 'biology:%') as topics,
         (select count(*) from public.lessons where seed_key like 'biology:%') as lessons,
         (select count(*) from public.quiz_questions where seed_key like 'biology:%') as questions,
         (select count(*) from public.course_assessments where seed_key like 'biology:%') as assessments,
         (select is_published from public.courses where slug = 'biology') as published
)
select 'modules = 12'      as check, modules::text    as actual, case when modules = 12 then 'OK' else 'FAIL' end as status from counts
union all
select 'topics = 29',       topics::text,    case when topics = 29 then 'OK' else 'FAIL' end from counts
union all
select 'lessons = 56',      lessons::text,   case when lessons = 56 then 'OK' else 'FAIL' end from counts
union all
select 'questions = 166',   questions::text, case when questions = 166 then 'OK' else 'FAIL' end from counts
union all
select 'assessments = 13',  assessments::text, case when assessments = 13 then 'OK' else 'FAIL' end from counts
union all
select 'course published',  case when published then 'true' else 'false' end,
                            case when published then 'OK' else 'FAIL' end from counts;
