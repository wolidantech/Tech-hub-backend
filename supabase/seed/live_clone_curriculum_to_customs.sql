-- =====================================================================
-- WOLI DAN TECH HUB — Clone curriculum from seed courses into their
-- published custom twins (LIVE database, Supabase SQL Editor).
--
-- WHY: 5 seed courses were deleted and re-created under renamed slugs
-- ("-with-" versions). Students enrolled and paid on the renamed (empty)
-- courses. The seed restore brought back the originals WITH full
-- curriculum (16 lessons each) as drafts. This copies that curriculum
-- into the published twins so enrolled students see content.
-- Enrollments, payments, URLs and bookmarks are untouched.
--
-- PAIRS (source -> destination):
--   graphic-design-canva    -> graphic-design-with-canva
--   mobile-app-development  -> mobile-application-development
--   ui-ux-design-figma      -> ui-ux-design-with-figma
--   video-editing-capcut    -> video-editing-with-capcut   (has 1 paid enrollment)
--   web-design-wordpress    -> web-design-with-wordpress
--
-- COPIES: modules, lessons, lesson bodies, videos, quizzes + questions,
-- assignments, completion rules. lessons_count is maintained by the
-- existing trigger (migration 004).
--
-- SAFE TO RE-RUN: each destination is skipped if it already has modules.
-- Run as ONE query. Afterwards, archive the 5 seed duplicates (Step 2).
-- =====================================================================

DO $clone$
DECLARE
  pairs TEXT[][] := ARRAY[
    ['graphic-design-canva', 'graphic-design-with-canva'],
    ['mobile-app-development', 'mobile-application-development'],
    ['ui-ux-design-figma', 'ui-ux-design-with-figma'],
    ['video-editing-capcut', 'video-editing-with-capcut'],
    ['web-design-wordpress', 'web-design-with-wordpress']
  ];
  src_slug TEXT;
  dst_slug TEXT;
  src_id UUID;
  dst_id UUID;
  src_mod RECORD;
  src_les RECORD;
  src_quiz RECORD;
  new_mod_id UUID;
  new_les_id UUID;
  new_quiz_id UUID;
  mod_map JSONB;
  les_map JSONB;
  n_mod INT;
  n_les INT;
  n_vid INT;
BEGIN
  FOR i IN 1..array_length(pairs, 1) LOOP
    src_slug := pairs[i][1];
    dst_slug := pairs[i][2];

    SELECT id INTO src_id FROM public.courses WHERE slug = src_slug;
    SELECT id INTO dst_id FROM public.courses WHERE slug = dst_slug;

    IF src_id IS NULL THEN
      RAISE NOTICE 'SKIP %: source course missing', src_slug;
      CONTINUE;
    END IF;
    IF dst_id IS NULL THEN
      RAISE NOTICE 'SKIP %: destination course missing', dst_slug;
      CONTINUE;
    END IF;

    -- Idempotency: never double-clone into a course that has curriculum.
    PERFORM 1 FROM public.course_modules WHERE course_id = dst_id LIMIT 1;
    IF FOUND THEN
      RAISE NOTICE 'SKIP %: already has curriculum', dst_slug;
      CONTINUE;
    END IF;

    mod_map := '{}'::jsonb;
    les_map := '{}'::jsonb;

    -- ---- Modules + lessons + bodies + videos ----
    FOR src_mod IN
      SELECT * FROM public.course_modules WHERE course_id = src_id ORDER BY position
    LOOP
      INSERT INTO public.course_modules (course_id, title, position)
      VALUES (dst_id, src_mod.title, src_mod.position)
      RETURNING id INTO new_mod_id;
      mod_map := mod_map || jsonb_build_object(src_mod.id::text, new_mod_id::text);

      FOR src_les IN
        SELECT * FROM public.course_lessons WHERE module_id = src_mod.id ORDER BY position
      LOOP
        INSERT INTO public.course_lessons
          (module_id, course_id, title, type, duration, position, description, resources, sub_lessons)
        VALUES
          (new_mod_id, dst_id, src_les.title, src_les.type, src_les.duration,
           src_les.position, src_les.description, src_les.resources, src_les.sub_lessons)
        RETURNING id INTO new_les_id;
        les_map := les_map || jsonb_build_object(src_les.id::text, new_les_id::text);

        INSERT INTO public.course_content (lesson_id, body_markdown)
        SELECT new_les_id, body_markdown
        FROM public.course_content WHERE lesson_id = src_les.id;

        INSERT INTO public.course_videos
          (lesson_id, provider, url, storage_path, duration_seconds, subtitles_path, status)
        SELECT new_les_id, provider, url, storage_path, duration_seconds, subtitles_path, status
        FROM public.course_videos WHERE lesson_id = src_les.id;
      END LOOP;
    END LOOP;

    -- ---- Quizzes + questions (module/lesson links remapped to the clones) ----
    FOR src_quiz IN
      SELECT * FROM public.quizzes WHERE course_id = src_id
    LOOP
      INSERT INTO public.quizzes
        (course_id, module_id, lesson_id, title, description, passing_score,
         allow_retake, is_final, status, attempt_limit)
      VALUES
        (dst_id,
         CASE WHEN src_quiz.module_id IS NULL THEN NULL
              ELSE (mod_map ->> src_quiz.module_id::text)::uuid END,
         CASE WHEN src_quiz.lesson_id IS NULL THEN NULL
              ELSE (les_map ->> src_quiz.lesson_id::text)::uuid END,
         src_quiz.title, src_quiz.description, src_quiz.passing_score,
         src_quiz.allow_retake, src_quiz.is_final, src_quiz.status, src_quiz.attempt_limit)
      RETURNING id INTO new_quiz_id;

      INSERT INTO public.quiz_questions
        (quiz_id, type, question, options, correct_answer, correct_answers, explanation, accepted_answers)
      SELECT new_quiz_id, type, question, options, correct_answer,
             correct_answers, explanation, accepted_answers
      FROM public.quiz_questions WHERE quiz_id = src_quiz.id;
    END LOOP;

    -- ---- Assignments (links remapped) ----
    INSERT INTO public.assignments
      (course_id, module_id, lesson_id, title, description, instructions,
       required_output, max_score, is_final_project, status, deadline, submission_type)
    SELECT dst_id,
      CASE WHEN module_id IS NULL THEN NULL
           ELSE (mod_map ->> module_id::text)::uuid END,
      CASE WHEN lesson_id IS NULL THEN NULL
           ELSE (les_map ->> lesson_id::text)::uuid END,
      title, description, instructions, required_output, max_score,
      is_final_project, status, deadline, submission_type
    FROM public.assignments WHERE course_id = src_id;

    -- ---- Completion rules ----
    INSERT INTO public.course_completion_rules
      (course_id, require_lessons_pct, require_quiz_avg,
       require_assignments_approved, require_final_project)
    SELECT dst_id, require_lessons_pct, require_quiz_avg,
           require_assignments_approved, require_final_project
    FROM public.course_completion_rules WHERE course_id = src_id
    ON CONFLICT (course_id) DO UPDATE SET
      require_lessons_pct = excluded.require_lessons_pct,
      require_quiz_avg = excluded.require_quiz_avg,
      require_assignments_approved = excluded.require_assignments_approved,
      require_final_project = excluded.require_final_project,
      updated_at = now();

    SELECT count(*) INTO n_mod FROM public.course_modules WHERE course_id = dst_id;
    SELECT count(*) INTO n_les FROM public.course_lessons WHERE course_id = dst_id;
    SELECT count(*) INTO n_vid FROM public.course_videos v
      JOIN public.course_lessons l ON l.id = v.lesson_id WHERE l.course_id = dst_id;
    RAISE NOTICE '% <- %: cloned % modules, % lessons, % videos',
      dst_slug, src_slug, n_mod, n_les, n_vid;
  END LOOP;
END $clone$;

-- ---------- Verify: the 5 twins should now show 16 lessons ----------
select slug, lessons_count, published, archived
from public.courses
where slug in (
  'graphic-design-with-canva',
  'mobile-application-development',
  'ui-ux-design-with-figma',
  'video-editing-with-capcut',
  'web-design-with-wordpress'
)
order by slug;

-- =====================================================================
-- STEP 2 (run AFTER verifying Step 1): archive the 5 seed duplicates
-- + the junk placeholder course so the storefront never shows doubles.
-- Seeds have 0 enrollments; this is reversible (archived=false to undo).
-- =====================================================================
-- update public.courses set archived = true, updated_at = now()
-- where slug in (
--   'graphic-design-canva',
--   'mobile-app-development',
--   'ui-ux-design-figma',
--   'video-editing-capcut',
--   'web-design-wordpress',
--   'video-eiting'
-- );
