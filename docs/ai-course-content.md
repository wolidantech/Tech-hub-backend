# WOLI DAN TECH HUB — AI Course Content Generation & Delivery

Production-ready AI course content pipeline per 32-section spec.

## Architecture

```
COURSE CREATED → AI CURRICULUM → MODULE → LESSON → PRACTICAL → QUIZ → PROJECT → RESOURCE → VIDEO → QUALITY CHECK → DRAFT → ADMIN REVIEW → APPROVED → PUBLISHED
```

- Never auto-publish unreviewed content
- No fake video URLs
- No copyrighted copying, only open educational resources with attribution
- Server-only AI keys

## Pipeline

### 1. Generation Jobs (non-blocking)

All generation is async via `ai_generation_jobs` table:

- `job_type`: COURSE, MODULE, LESSON, LESSON_TEXT, VIDEO_SCRIPT, VIDEO, QUIZ, ASSIGNMENT, PRACTICAL, PROJECT, RESOURCE, BULK_MISSING...
- `status`: QUEUED → PROCESSING → COMPLETED / FAILED / CANCELLED
- Input JSON: courseName, category, level, targetAudience, duration, numberOfModules, learningObjectives, specialInstructions
- Output JSON: structured curriculum

**Endpoints (admin only, requireAuth+requireAdmin):**

- `POST /api/ai/courses/generate` → 202 queued, DRAFT
- `POST /api/ai/courses/:courseId/populate` → populate missing modules/lessons
- `POST /api/ai/lessons/generate` { courseId, moduleId?, title, level, ... }
- `POST /api/ai/quizzes/generate` { lessonId, count?, difficulty }
- `POST /api/ai/assignments/generate` { lessonId, difficulty }
- `POST /api/ai/practicals/generate` { lessonId, difficulty }
- `POST /api/ai/video/generate` { lessonId, script, duration, voice, language, teachingStyle, visualStyle }
- `GET /api/ai/jobs/:jobId` → status + output/error
- `GET /api/ai/jobs` → list with pagination, filters status/job_type
- `POST /api/ai/bulk/generate-missing` { courseId, modules?, lessons? } → identify missing and queue only missing, never overwrite APPROVED

Also mounted on legacy backend as `/api/ai/*` with same contracts.

### 2. Content Storage

Tables from migration `20260910000010_ai_course_content_system.sql`:

- `ai_generated_content` — versioned, status DRAFT/IN_REVIEW/APPROVED/PUBLISHED/UNPUBLISHED/ARCHIVED, quality_flags, quality_score, generated_by, approved_by
- `course_modules` / `course_lessons` / `lessons` — reused, no duplicate tables
- `lesson_content` — RAG chunks: course_id, module_id, lesson_id, content_type, content, chunk_index, embedding vector (optional pgvector), is_approved
- `lesson_videos` — provider-independent: script, video_url, storage_path, duration, thumbnail, captions, transcript, status QUEUED/PROCESSING/COMPLETED/FAILED/CANCELLED, provider, metadata, voice/language/teaching_style/visual_style, error
- `course_resources` — title, description, url, storage_path, source, license, resource_type VIDEO/PDF/ARTICLE/DOCUMENTATION/DATASET/CODE/TEMPLATE/WEBSITE/BOOK/EXERCISE, is_external, is_approved, quality_score, attribution
- `lesson_practicals` — title, objective, scenario, instructions, requirements, expected_output, difficulty, estimated_time, submission_type, evaluation_criteria
- `course_projects` — title, scenario, objective, requirements, deliverables, evaluation, submission, tools, difficulty, is_final
- `quizzes`, `quiz_questions`, `assignments`
- `course_completion_rules` — required_lesson %, min quiz score, assignment, final project, final score

Versioning: content unique (course, module, lesson, content_type, version). Preview/edit/regenerate/restore.

### 3. Teaching Standard (13 steps mandatory)

Every lesson content must include:

1. What you'll learn
2. Why it matters
3. Prerequisites
4. Simple explanation
5. Step-by-step breakdown (H3)
6. Real-world examples (2-3)
7. Demonstration
8. Common mistakes
9. Best practices
10. Practical exercise
11. Knowledge check
12. Summary
13. Further practice

Domain flows:
- Programming: Concept → Syntax → Example → Explanation → Exercise → Common errors → Best practices → Mini-project
- Design: Concept → Demonstration → Technique → Example → Practice → Project
- Business: Concept → Strategy → Real-world example → Implementation → Exercise → Case study

Substantial 800-2000 words, not shallow, no repetitive filler.

### 4. Video Generation (provider-independent)

Input: lessonId, script, duration, voice, language, teachingStyle, visualStyle
Output: video URL / storage path / duration / thumbnail / captions / transcript / provider metadata

- Never fake URLs
- FAILED requires error safely stored
- Allow retry / regenerate / replace / manual upload
- Service: `src/services/ai-video.service.js` `createVideoJob`, `updateVideoStatus`, `retryVideoJob`, `uploadManualVideo` to BUCKETS.lessonResources `course-videos/{course}/{lesson}/`

Storage: Supabase Storage private buckets + signed URLs (600s student, 3600s admin)

### 5. External Resources (legal only)

Allowed: open educational resources, public-domain, Creative Commons, official docs, university/open-course, government edu, open datasets, open-source, legally reusable videos

For every resource store: title, description, URL, source, license, access date, resourceType, attribution

Reject:
- Paid courses (Udemy paid, Skillshare, Coursera paid)
- Copyrighted PDFs/books without CC license
- Large copyrighted articles, videos, transcripts
- Spam

PDF handling:
- Store securely if license is CC BY / CC BY-SA / CC0 / Public Domain / MIT / Apache
- Else external URL + attribution only
- Never assume public = free to redistribute

Service: `src/services/ai-resource.service.js` `isTrustedSource`, `isSuspiciousUrl`, `validateResource`, `createResource` (is_approved=false, quality_score), `storePdfIfAllowed`

Trusted list: MDN, python.org, react.dev, developer.mozilla.org, nodejs.org, kubernetes.io, etc.
Blocked patterns: udemy.com/course, skillshare, /pdf with no license, etc.

### 6. Quality Checks

`runQualityChecks` in `ai-course.service.js`:

- Missing sections (objectives, summary)
- Insufficient content (<300 chars)
- Repetitive (<0.3 unique words)
- Unsafe (rm -rf, DROP TABLE, etc)
- Missing practical
- Insufficient assessment (<3 quiz)

Returns quality_flags, quality_score 0-100, passed bool, flagged for admin review

### 7. Admin Review Pipeline

`src/controllers/admin-content.controller.js`:

- `GET /api/admin/content` filters status/content_type/course_id
- `GET /api/admin/content/:id` detail
- `POST /:id/approve` DRAFT/IN_REVIEW → APPROVED (requires approved_by)
- `POST /:id/publish` APPROVED → PUBLISHED
- `POST /:id/unpublish` PUBLISHED → UNPUBLISHED
- `DELETE /:id` archive if APPROVED/PUBLISHED else hard delete
- `GET /:id/versions` list
- `POST /:id/restore` { version } creates new version copy
- `POST /:id/regenerate` queues new job
- `GET /api/admin/resources`, `POST /api/admin/resources/:id/approve`

All with audit logs.

### 8. Student Delivery (real school)

`GET /api/courses/:courseId/content`:
- Published course only
- Modules, lessons (is_published), ai_generated_content APPROVED/PUBLISHED, resources, practicals, projects, quizzes, completion_rules, has_access check
- `curriculum_complete` flag

`GET /api/courses/:courseId/modules`

`GET /api/lessons/:lessonId` (auth + ACTIVE enrollment):
- lesson, ai_content, video COMPLETED only, resources, practicals, quizzes, quiz_questions, assignments, rag chunks, teaching_standard flags

`POST /api/lessons/:lessonId/progress` (existing learning route)

Final completion per `course_completion_rules`:
- required lesson %
- min quiz score
- assignment
- final project
- final score
Only then COMPLETED

### 9. DanTECH AI Upgrade

`src/gateway/rag.js` course-aware:
- Boost moduleId +12, isApprovedContent +10, LESSON_TEXT +5
- fetch `fetchApprovedAiContent` (status APPROVED/PUBLISHED) + `fetchRagChunks` (lesson_content is_approved)
- Merge docs, retrieve RAG-ready
- Context: studentId, courseId, moduleId, lessonId

`chat.controller.js` schema: moduleId, studentId, courseId, lessonId, level

System prompts: no internal prompts/keys leaked, answers based on current lesson, supports Explain simply / Give example / Practice question / Help code / Quiz me / Summarize

RAG storage: `lesson_content` course_id, module_id, lesson_id, content_type, content_id, chunk, embedding ref (pgvector optional)

### 10. Security

- Keys server-only: OPENAI_API_KEY, SUPABASE_SERVICE_ROLE_KEY
- Students cannot: generate unlimited, publish, edit courses, modify lessons, approve, change prices, access unpublished, another student's submissions, admin endpoints
- RLS: students see APPROVED/PUBLISHED only, admin via `is_admin()`
- Private storage + signed URLs
- Never trust frontend price/reference (existing payment security)

### 11. Initial Population

Script `scripts/populate-ai-content.mjs` (to be run after migration):

- Loads 12 published courses
- For each, identifies missing via `identifyMissingContent`
- Queues jobs: COURSE outline → MODULE → LESSON_TEXT → PRACTICAL → QUIZ → PROJECT → RESOURCE → VIDEO_SCRIPT → VIDEO
- All DRAFT, admin must approve
- Uses actual courses, not fake hundreds

Run: `node scripts/populate-ai-content.mjs` or via API `POST /api/ai/bulk/generate-missing`

### 12. Testing

Per spec 31:

- Course/module/lesson/quiz/assignment/practical/video/resource storage
- External metadata (source/license/attribution)
- Admin approval/publishing/unpublishing
- Student access (enrollment gated)
- Progress tracking
- DanTECH AI context (course-aware RAG)
- RLS (unpublished not accessible)
- Storage security (private + signed URLs)

Scripts:
- `npm run check` — 55+ files parse
- `npm run test:gateway` — 64 checks
- `npm run test:payments` — 65 checks
- `npm run test:ai-content` — AI content pipeline (to be added)

### 13. International Quality

- Globally useful, examples different industries/regions
- Not Nigeria-specific unless required
- Internationally recognized tools/standards/terminology/best practices/docs

### 14. Storage Buckets

Existing:
- `payment-receipts` private
- `lesson-resources` / `course-videos` / `thumbnails` etc.

Add if not exists: `course-videos`, `course-resources`, `lesson-thumbnails`

Signed URLs: 600s student, 3600s admin

### 15. API Docs Summary

Student:
- `GET /api/courses/:courseId/content`
- `GET /api/courses/:courseId/modules`
- `GET /api/lessons/:lessonId`
- `POST /api/learning/lessons/:lessonId/progress` (existing)

Admin AI:
- `POST /api/ai/courses/generate`
- `POST /api/ai/courses/:courseId/populate`
- `POST /api/ai/lessons/generate`
- `POST /api/ai/quizzes/generate`
- `POST /api/ai/assignments/generate`
- `POST /api/ai/practicals/generate`
- `POST /api/ai/video/generate`
- `GET /api/ai/jobs/:jobId`
- `GET /api/ai/jobs`
- `POST /api/ai/bulk/generate-missing`

Admin review:
- `GET /api/admin/content`
- `GET /api/admin/content/:id`
- `POST /api/admin/content/:id/approve`
- `POST /api/admin/content/:id/publish`
- `POST /api/admin/content/:id/unpublish`
- `POST /api/admin/content/:id/regenerate`
- `POST /api/admin/content/:id/restore`
- `DELETE /api/admin/content/:id`
- `GET /api/admin/content/:id/versions`
- `GET /api/admin/resources`
- `POST /api/admin/resources/:id/approve`

DanTECH:
- `POST /api/dantech/chat` { message, courseId?, moduleId?, lessonId?, studentId?, level? }

All admin routes require `requireAuth+requireAdmin`, jobs list/get allow creator.
