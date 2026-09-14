# WOLI DAN TECH HUB — Production LMS Curriculum Engine

The backend/database work that turns course **previews** into a real, complete,
gated **classroom**. Nothing was rebuilt, Supabase was kept, no feature was
deleted, and no fake data was seeded.

Related code:

- `supabase/migrations/20260910000014_lms_curriculum_engine.sql` — schema
- `src/services/curriculum.service.js` — single source of truth (JS assembly)
- `src/controllers/classroom.controller.js` + `src/routes/classroom.routes.js`
- `src/controllers/admin-curriculum.controller.js` + `src/routes/admin-curriculum.routes.js`
- `scripts/check-classroom.js` — chain tracer (`npm run check:classroom`)

---

## 1. Database audit (requested chain vs reality)

Requested: `courses → course_modules → course_topics → course_lessons →
lesson_contents → lesson_resources → lesson_practicals → assignments →
assignment_submissions → quizzes → quiz_questions → quiz_options →
course_assessments → student_progress → certificates`

| Requested table | Before | Verdict | Action taken |
|---|---|---|---|
| `courses` | ✅ existed (`is_published`) | reuse | added `published`/`archived` mirrors + `learning_outcomes`, `prerequisites`, `learning_objectives`, `level`, `category`; sync triggers |
| `course_modules` | ✅ existed | reuse | unchanged (RLS updated for dual flags) |
| `course_topics` | ❌ missing | **created** | new table + RLS + reorder RPC |
| `course_lessons` | ⚠️ name drift (`lessons` in backend schema, `course_lessons` table on live) | reuse `lessons` | `lessons` canonical (+`topic_id`, `course_id`, `published`, `is_free_preview`); `course_lessons` VIEW when no table, else backfill + one-way mirror |
| `lesson_contents` | ⚠️ only `lesson_content` (RAG chunks) existed | **created** (different purpose) | new structured-blocks table; RAG table kept |
| `lesson_resources` | ⚠️ only `course_resources` existed | reuse | `lesson_resources` VIEW over `course_resources` (+`topic_id` column) |
| `lesson_practicals` | ✅ existed | reuse | +`topic_id` column |
| `assignments` | ✅ existed | reuse | +`topic_id`, `max_score`, `pass_score`, `due_date` |
| `assignment_submissions` | ❌ missing | **created** | new table + grading guard trigger + RLS + storage bucket |
| `quizzes` | ✅ existed | reuse | +`topic_id`, `scope`, `assessment_id`, `order_number` |
| `quiz_questions` | ✅ existed (options JSONB) | reuse | kept; JSONB now a display-only mirror |
| `quiz_options` | ❌ missing (JSONB only) | **created** | normalised table + backfill + sync trigger; `quiz_attempts` added |
| `course_assessments` | ❌ missing | **created** | new table; question banks reuse `quizzes` (`assessment_id`, `scope='FINAL'`) |
| `student_progress` | ⚠️ only `lesson_progress` existed | reuse | `student_progress` VIEW over `lesson_progress` + topic context |
| `certificates` | ✅ existed | reuse | issuance now honours `course_completion_rules` |

No table was created twice under two names. Every alias is a VIEW, and every
VIEW documents its canonical table in a SQL `COMMENT`.

---

## 2. Root-cause bug report — why previews worked but classrooms were empty

Traced: listing → details → enrollment → classroom → module → topic → lesson
→ content query. Five compounding causes were found; **all five** had to be
fixed (any single fix alone still leaves an empty classroom).

### Cause 1 — Schema drift: two table names for lessons (PRIMARY)

- The LMS backend queries `lessons` + `courses.is_published`.
- The AI gateway (`src/gateway/supabase.js`) queries `course_lessons` +
  `courses.published/archived`, embedding `course_modules(title)`,
  `course_content(body_markdown)`, `courses(level, category)`.
- The live project / frontend seeds reference `course_lessons`,
  `course_content`, and `published`/`position` columns.

Two halves of the same backend expected different schemas, so depending on
which database the code talked to, curriculum queries returned zero rows or
errored — while the course **preview** (simple `courses` select) worked.

**Fix:** migration 014 makes `lessons` canonical, adds a `course_lessons`
compatibility VIEW (or a guarded one-way mirror when a legacy TABLE exists),
adds a `course_content` VIEW, and the gateway gained a canonical-tables
fallback (`fetchLessonsByCourseFallback` / `searchLessonsFallback`).

### Cause 2 — Published-flag mismatch

Backend filters (`.eq('is_published', true)`) and RLS policies
(`courses_public_read`, `modules_read`) only understood `is_published`, while
live rows carried `published`/`archived`. Result: modules/lessons existed but
were invisible to every read path.

**Fix:** both flag columns now exist on courses/lessons/topics/contents with
BEFORE triggers keeping them in sync; RLS policies test the normalised state
(`is_published AND NOT archived`).

### Cause 3 — RLS gating vs direct-Supabase frontend

`lessons_read_gated` correctly returns 0 rows to unenrolled callers. The
frontend talks to Supabase directly for LMS data, so pre-enrollment curriculum
queries legitimately returned `[]` — indistinguishable from "no curriculum".

**Fix:**
- Public outline stays available through the backend (`GET
  /api/classroom/:slug/outline`, `GET /api/courses/:slug`) and through the
  `get_course_outline()` RPC (safe columns only, granted to anon).
- Full classroom is served gated (enrollment-checked) by the backend and by
  the `get_course_classroom()` RPC.
- Every outline/classroom response now carries `curriculum_status`
  (`complete`, counts, human message) so empty states are diagnosable.

### Cause 4 — Genuinely empty curriculum

Only one lesson was ever seeded (CapCut, module 1). All other courses had zero
modules/lessons, and endpoints returned bare `[]` with no explanation.

**Fix:** no fake content was generated. Instead: admin CRUD for the whole
chain, a one-click publish cascade (`POST
/api/admin/courses/:slug/publish`), per-course `curriculum-status`, extended
`GET /api/admin/diagnostics` (lists every course with an empty classroom and
its fix), and `npm run check:classroom` to trace the chain.

### Cause 5 — Fragmented classroom endpoints

Four shapes with different gating: `/api/courses/:id/lessons` (auth),
`/api/learning/courses/:id` (auth), `/api/courses/:id/content` (optional),
`/api/mobile/*`. Frontend stitching broke across them.

**Fix:** new unified surface `GET /api/classroom/:slug` (full gated payload)
+ `GET /api/classroom/:slug/outline` (public). Legacy endpoints are preserved
and now share the same `curriculum.service.js` assembly, so shapes agree.

---

## 3. Supported course structure

```
COURSE
├── metadata ............ title, slug, description, thumbnail, price,
│                         duration, difficulty/level, category,
│                         learning_outcomes[], prerequisites[],
│                         learning_objectives[]
├── modules[]
│   ├── topics[]
│   │   ├── lessons[]
│   │   │   ├── theory ........ lesson_contents (THEORY/TEXT/SUMMARY/KEY_CONCEPTS)
│   │   │   ├── examples ...... lesson_contents (EXAMPLE/CODE)
│   │   │   ├── videos ........ lesson.video_url + lesson_videos (signed URLs)
│   │   │   ├── PDFs .......... lesson_contents (PDF) + course_resources
│   │   │   ├── resources ..... course_resources (lesson_resources view)
│   │   │   ├── practical ..... lesson_practicals
│   │   │   ├── assignment .... assignments (+ my submissions + grades)
│   │   │   └── quiz .......... quizzes → questions → options (answers stripped)
│   │   └── (lessons may also sit directly under a module: topic_id NULL)
├── final assessment .... course_assessments + scope=FINAL quizzes → attempts
├── completion rules .... course_completion_rules (lesson %, quiz avg,
│                         assignment required, final score)
└── certificate ......... auto-issued when rules pass (verify_certificate)
```

---

## 4. API reference

### 4.1 Unified classroom (student)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/classroom/:idOrSlug/outline` | public (optional auth) | Safe outline: titles only + counts + `curriculum_status` + `has_access` |
| GET | `/api/classroom/:idOrSlug` | gated | **Full classroom**: chain + progress + continue + certificate + rules + assessments |
| GET | `/api/classroom/:idOrSlug/assessments` | gated | Final/module exams + my best attempts |
| GET | `/api/classroom/quizzes/:quizId` | gated | Quiz with questions/options, **answers stripped** |
| POST | `/api/classroom/quizzes/:quizId/attempts` | gated | `{answers:[{question_id, answer}]}` → graded `{score, passed, results[]}` |
| GET | `/api/classroom/quizzes/:quizId/attempts` | gated | My attempt history + best |
| GET | `/api/classroom/assignments/:assignmentId` | gated | Assignment + my submissions |
| POST | `/api/classroom/assignments/:assignmentId/submissions` | gated | multipart `file` and/or `submission_text` |

Gated = `ACTIVE`/`COMPLETED` enrollment, or admin, or the course instructor.
Otherwise `403 COURSE_ACCESS_DENIED`.

### 4.2 Admin curriculum (`/api/admin/*`, admin only)

Topics: `POST /modules/:id/topics`, `POST /modules/:id/topics/reorder`,
`GET|PATCH|DELETE /topics/:id`.

Lesson contents: `POST /lessons/:id/contents`, `POST
/lessons/:id/contents/reorder`, `PATCH|DELETE /contents/:id`.

Assignments: `POST /courses/:slug/assignments`,
`GET|PATCH|DELETE /assignments/:id`, `GET /assignments/:id/submissions`,
`POST /submissions/:id/grade {score, feedback, status}`.

Quizzes: `POST /courses/:slug/quizzes`, `GET|PATCH|DELETE /quizzes/:id`
(admin detail **includes** answers), `GET /quizzes/:id/attempts`,
`POST /quizzes/:id/questions`, `PATCH|DELETE /questions/:id`,
`POST /questions/:id/options`, `PATCH|DELETE /options/:id`.

Assessments: `POST /courses/:slug/assessments`,
`GET|PATCH|DELETE /assessments/:id`. Link question banks by creating quizzes
with `{assessment_id, scope: 'FINAL'}`.

Publishing & rules: `POST /courses/:slug/publish
{publish, include_quizzes?, include_assignments?, include_assessments?}`,
`GET|PUT /courses/:slug/completion-rules`, `PATCH /courses/:slug/meta
{learning_outcomes, prerequisites, learning_objectives}`,
`GET /courses/:slug/curriculum-status`.

Courses/modules/lessons CRUD stays in `admin-courses.controller.js`; lesson
create/update now also accept `topic_id` and `is_free_preview`.

### 4.3 Direct-Supabase frontends (no backend hop)

SECURITY DEFINER RPCs (safe to call with anon/authenticated keys):

- `get_course_outline(p_course_id)` — public outline JSON (anon OK).
- `get_course_classroom(p_course_id)` — full gated classroom JSON (auth; the
  function checks enrollment itself).
- `get_quiz_for_student(p_quiz_id)` — quiz minus answers (auth + enrollment).
- `submit_quiz_attempt(p_quiz_id, p_answers)` — server-side grading (auth).
- `get_course_classroom_for_student`, `get_quiz_for_student_for`,
  `submit_quiz_attempt_for` — service_role variants used by this backend.

Compat views: `course_lessons`, `course_content`, `lesson_resources`,
`student_progress`. Base-table RLS still applies through views.

### 4.4 Mobile additions

- `GET /api/mobile/courses/:slug/modules/:moduleId/topics` (paginated)
- `GET /api/mobile/courses/:slug/modules/:moduleId/lessons?topic_id=` filter;
  lesson payloads now include `topic_id` + `is_free_preview`
- `GET /api/courses/:id/content` accepts `include=topics,assessments` and
  returns `curriculum_status`; `GET /api/lessons/:id` accepts
  `include=contents,topic,submissions`

---

## 5. Completion, grading & certificates

1. Lesson completion writes to `lesson_progress` (existing endpoint `POST
   /api/learning/lessons/:id/progress`). The `trg_lesson_completion` trigger
   still sends module-milestone notifications.
2. Course completion is decided by `check_course_completion()`:
   - no `course_completion_rules` row → legacy behaviour: 100% of published
     lessons ⇒ `COMPLETED` + certificate (unchanged).
   - with rules → required lesson %, average best-quiz score, graded
     assignment pass, final-exam pass — all must hold.
3. The check runs automatically after lesson completion, after every quiz
   attempt, and after an assignment is graded.
4. Grading: quizzes auto-grade server-side (options preferred, legacy
   JSONB/`correct_answer` fallback). Assignments grade via
   `POST /api/admin/submissions/:id/grade`; students can never set
   score/feedback (trigger + RLS enforced).
5. Certificates: issued by the completion check with
   `next_certificate_number()`; verified publicly via `verify_certificate()`.

---

## 6. RLS matrix (new / changed)

| Table | anon | authenticated student | instructor | admin |
|---|---|---|---|---|
| `courses` | read iff visible | read iff visible | + own courses | all |
| `course_modules` | read iff course visible | read iff visible/enrolled | read | all |
| `course_topics` | read iff course visible | read iff visible/enrolled | read | all |
| `lessons` | free previews only | enrolled only | own courses | all |
| `lesson_contents` | — | enrolled only | own courses | all |
| `assignment_submissions` | — | own rows (submit while ungraded) | own courses (grade) | all |
| `quiz_options` | — | read iff quiz live | read | all |
| `quiz_attempts` | — | own rows (insert, immutable) | own courses | all |
| `course_assessments` | — | enrolled + live only | own courses | all |
| storage `assignment-submissions` | — | own folder | via backend | all |

`is_admin()`, `has_active_enrollment()`, `is_course_instructor()` are reused
unchanged. Views inherit base-table RLS.

---

## 7. Runbook

### Apply

```bash
npm run migrate              # applies 001…014 in order (DATABASE_URL)
# or: Supabase SQL Editor → paste supabase/migrations/20260910000014_lms_curriculum_engine.sql
npm run check:classroom      # trace listing → classroom, fix what it flags
```

The migration is idempotent and safe on: fresh DBs, backend-schema DBs, and
live DBs that already have `course_lessons`/`course_content` TABLES or
`published`/`archived` columns. Legacy `course_lessons` rows are backfilled
into `lessons` (same UUIDs) and kept fresh by a guarded mirror trigger.

### Verify a course end-to-end

```bash
GET /api/classroom/<slug>/outline            # curriculum_complete + counts
POST /api/admin/courses/<slug>/publish       # publish chain (admin)
GET /api/classroom/<slug>                    # full classroom (enrolled student)
GET /api/admin/diagnostics                   # curriculum section lists empty classrooms
```

### Rollback

Migration 014 only ADDS (tables, columns, views, triggers, policies, RPCs,
one bucket). To roll back: drop the added objects in reverse order
(RPCs → triggers → views → new tables → added columns), then restore the
three recreated policies (`courses_public_read`, `modules_read`,
`handle_lesson_completion`) from migrations 002/003. No pre-existing data is
deleted or rewritten except additive flag normalisation (`published` /
`archived` mirrors, `lessons.course_id`) which is itself harmless to keep.

---

## 8. Frontend integration (the fixed chain)

```
listing   GET /api/courses
details   GET /api/classroom/:slug/outline        # titles + curriculum_status
enroll    POST /api/enrollments → POST /api/payments (receipt) → admin approves
classroom GET /api/classroom/:slug                # everything, one call
progress  POST /api/learning/lessons/:id/progress {completed, last_position}
quiz      GET /api/classroom/quizzes/:id → POST .../attempts {answers}
assign    GET /api/classroom/assignments/:id → POST .../submissions (file/text)
final     GET /api/classroom/:slug/assessments
cert      classroom.certificate → /api/certificates/*
```

Empty-classroom UX: when `curriculum_complete === false`, show
`curriculum_status.message` ("no published lessons yet") instead of a blank
page; for admins, deep-link the curriculum builder + publish action.

---

## 9. Testing

- `npm run check` — every file parses; both Express apps construct.
- `npm run validate:sql` — all migrations parse (libpg_query).
- `npm run test:db` — full suite on embedded Postgres incl. RLS, payments,
  completion, certificates (migration 014 runs here too).
- `npm run test:gateway` — 64 checks incl. RAG published-filter assertions.
- `npm run check:classroom [slug]` — live chain trace against Supabase.

## 10. Pre-existing migration repairs (required to apply the chain)

While verifying migration 014 end-to-end, three latent defects that broke
fresh `npm run migrate` / `npm run test:db` runs were repaired. All are
minimal, idempotent, and behaviour-preserving on already-migrated databases:

1. **008 — `payments.coupon_id` ordering.** The `REFERENCES coupons` column
   (and its index) were added before the `coupons` table was created, so the
   migration could never succeed on a fresh database. Moved after table
   creation; removed a `REVOKE` targeting a non-existent
   `validate_coupon(uuid, uuid, uuid)` overload.
2. **010 — `vector` type assumed.** `lesson_content.embedding vector` was
   declared before `CREATE EXTENSION vector`, and the extension install was
   unguarded, so non-Supabase Postgres failed. The extension install now runs
   first inside an exception-guarded block and the column is added only when
   pgvector exists (Supabase cloud behaviour unchanged).
3. **014 (self-review via tests) — flag-sync trigger direction.** The first
   version of the publish-flag triggers could not distinguish "legacy flag
   explicitly set" from "stale mirror value", which undid unpublishes. All
   four sync triggers are now OLD/NEW-aware (canonical change wins, legacy
   change propagates, unrelated updates re-enforce the mirror), with
   regression tests in `scripts/test-db.mjs` §7.
