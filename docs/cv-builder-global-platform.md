# WOLI DAN TECH HUB — Global Knowledge Platform + CV Builder + Advanced DanTECH AI

## Overview

Scalable global learning platform: GLOBAL COURSE LIBRARY + PROFESSIONAL CV BUILDER + CAREER TOOLS + COMPLETE LMS + DANTECH AI + AI COURSE GENERATOR + AI LESSON GENERATOR + PRACTICAL TRAINING + QUIZZES + PROJECTS + CERTIFICATES + GLOBAL EDUCATIONAL RESOURCES

## 1. Public CV Builder API (Unauthenticated)

**Per spec:** Visitors must be able to Create/Edit/Preview/AI-improve/Export PDF without account.

### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/cv/create` | optionalAuth (guest allowed) | Create CV |
| GET | `/api/cv/:id` | optionalAuth + guest session | Get CV with sections |
| PUT | `/api/cv/:id` | optionalAuth + guest session | Update CV |
| DELETE | `/api/cv/:id` | authenticate | Delete (owner only) |
| POST | `/api/cv/preview` | optionalAuth | Preview structured data |
| POST | `/api/cv/export` | optionalAuth | Generate A4 PDF, returns signed URL |
| GET | `/api/cv/export/:id/download` | optionalAuth | Secure download reference |
| POST | `/api/cv/ai/improve` | optionalAuth | AI-assisted wording, never fabricate |
| GET | `/api/cv/templates` | public | List templates |
| GET | `/api/cv/occupations/search?q=&category=&featured=&limit=` | public | Search occupations |
| GET | `/api/cv/occupations/categories` | public | List occupation categories |
| GET | `/api/cv/my` | authenticate | List user's CVs |

**Guest handling:** Client sends `X-Guest-Session` header or `guestSessionId` in body/query. If not provided, backend generates `guest_{uuid}` and returns it. Guest CVs have `guest_session_id` not `user_id`. No unnecessary PII stored for anonymous beyond what they provide in `personal_info`.

**Request examples:**

```json
POST /api/cv/create
{
  "templateCode": "professional",
  "title": "Software Engineer CV",
  "occupationId": "uuid",
  "personalInfo": {
    "fullName": "John Doe",
    "email": "john@example.com",
    "phone": "+123...",
    "city": "Lagos",
    "linkedin": "linkedin.com/in/johndoe",
    "title": "Senior Software Engineer"
  },
  "summary": "Experienced engineer...",
  "sections": [
    {
      "type": "experience",
      "title": "Work Experience",
      "content": {
        "items": [
          {
            "title": "Senior Developer",
            "company": "Tech Corp",
            "startDate": "2020-01",
            "endDate": "Present",
            "description": "Built...",
            "achievements": ["Improved performance 30%"]
          }
        ]
      }
    }
  ]
}
Response 201: { success: true, data: { cv, guestSessionId } }
```

```json
POST /api/cv/export
{
  "cvId": "uuid",
  "templateCode": "modern"
}
Response: { success: true, data: { export, downloadUrl, filePath, expiresAt } }
```

```json
POST /api/cv/ai/improve
{
  "cvId": "uuid",
  "sectionType": "experience",
  "content": "I worked on building apps...",
  "occupationId": "uuid"
}
Response: { success: true, data: { improved, original, sectionType } }
```

**PDF Generation:**

- A4, 50pt margins, professional typography (Helvetica/Inter/Merriweather/Poppins/JetBrains Mono per template)
- No overlapping, correct pagination (adds page when y>700)
- Header: name, title, contact line
- Sections: summary, experience (title at company, duration, description, achievements bullets), education, skills, projects
- Footer: "Generated via WOLI DAN TECH HUB"
- Stored in `cv-exports` bucket private, guest expires 24h, signed URL 600s guest / 3600s user, download_count tracked, temporary cleanup via expires_at

**AI CV Writing — No Fabrication:**

System prompt:
```
You are a professional CV writing assistant for WOLI DAN TECH HUB.
CRITICAL RULES — NEVER FABRICATE:
- Do NOT invent degrees, employment, certifications, job titles, companies, achievements, skills, or dates
- Only transform, rephrase, and improve the information the user has already provided
- If information is missing, do NOT invent it — suggest what could be added but do not fabricate
...
```

Transforms supplied info: summary, experience, projects, achievements, skills descriptions, career objective. Never invents credentials.

## 2. Occupation Taxonomy

**Scalable, thousands support, ESCO/O*NET inspired, legally usable.**

Table `occupations`: code, title, normalized_title, description, category, subcategory, skills jsonb, is_featured, is_active, source.

Seed: 50 occupations across Technology, Healthcare, Finance, Business, Engineering, Education, Creative, Legal, Trades, Science. Examples: Software Engineer, Data Scientist, Doctor, Nurse, Accountant, Architect, Teacher, Lawyer, Graphic Designer, Electrician, Mechanic, Journalist, Marketing Manager, Project Manager, Research Scientist, etc.

**Admin can add/edit:**

- `POST /api/occupations` { title, description, category, subcategory, skills, is_featured } → admin only
- `PUT /api/occupations/:id`
- `DELETE /api/occupations/:id`
- Search via trigram GIN index on title, normalized_title, category

**Endpoints:**

- `GET /api/occupations/search?q=software&category=Technology&limit=20&featured=true`
- `GET /api/occupations/categories` → distinct categories
- `GET /api/cv/occupations/search` alias for CV builder

**Do NOT manually hardcode thousands duplicated:** Use taxonomy with code, normalized_title for search, skills jsonb, category hierarchy. Admin can bulk import via SQL or API. System supports millions via indexes.

## 3. Global Subject Taxonomy

**Hierarchical: FIELD → SUBJECT → SPECIALIZATION → COURSE → MODULE → LESSON**

Tables:

- `subject_fields` (code, name, description, icon, color, is_active) — e.g. Computer Science, AI, Mathematics, Physics, Chemistry, Biology, Medicine, Engineering, Business, Finance, Accounting, Economics, Law, Psychology, Education, Architecture, Design, Media, Marketing, Agriculture, Languages, Vocational Skills
- `subjects` (field_id, code, name, description, level)
- `subject_specializations` (subject_id, code, name, description)
- `courses` extended with field_id, subject_id, specialization_id

Seed: 23 fields, 7 subjects (Programming, Web Development, Mobile Development, Cloud, ML, DL, NLP), 6 CV templates.

**Endpoints:**

- `GET /api/subjects/fields` → list fields
- `GET /api/subjects/fields/:fieldId/subjects` → subjects per field
- `GET /api/subjects/taxonomy` → full hierarchical tree
- `POST /api/subjects/fields` admin
- `POST /api/subjects` admin
- `POST /api/subjects/specializations` admin

Supports virtually any legitimate academic, scientific, technical, vocational, business or professional field.

## 4. Do NOT Generate Thousands Fake Courses

Engine built, not fake data. `ai_generation_jobs` + `ai_generated_content` pipeline with DRAFT→REVIEW→APPROVE→PUBLISH. Admin requests "Create a course on Python for Beginners" via `POST /api/ai/courses/generate` → system generates Course, Modules, Lessons, Examples, Practicals, Assignments, Quizzes, Final project, Resources, Video scripts → DRAFT → REVIEW → APPROVE → PUBLISH.

## 5. Global Course Generator

Already implemented per previous spec, enhanced with subject taxonomy.

`POST /api/ai/courses/generate` input: subject, courseTitle, level, targetAudience, duration, numberOfModules, learningObjectives, specialInstructions

Generates deep structured curriculum with 13-step teaching standard per lesson.

## 6. Professional Educational Quality

Per `prompts.js`: each lesson includes learning objectives, prerequisites, introduction, concept explanation, step-by-step teaching, examples, real-world applications, demonstration, common mistakes, best practices, practical activity, knowledge check, summary, further study. Clear, accurate, structured, progressive, beginner-friendly where appropriate, technically detailed at advanced levels. Avoids repetition, filler, generic AI prose, unsupported claims.

## 7. Global Resource Research

System may find: official docs, open educational resources, public-domain, Creative Commons, university open courses, government edu, open datasets, open-source, legally reusable videos, official technical references.

Stores: title, description, URL, source, resourceType, license, attribution, accessedAt.

**IMPORTANT:** Do not copy copyrighted paid courses/books/PDFs/videos. Publicly accessible ≠ freely reusable. When uncertain, store link/reference rather than copying.

Tables: `course_resources` (url/storage_path, source/license/resource_type/is_external/is_approved/quality_score/attribution), `resource_sources` (name, base_url, type OFFICIAL_DOCS/OPEN_EDU/UNIVERSITY/GOVERNMENT/OPEN_DATASET/OPEN_SOURCE/VIDEO, is_trusted)

Seed: MDN, Python.org, React.dev, Node.js, Kubernetes, MIT OCW, Stanford, Khan Academy, W3Schools, GitHub, ArXiv, Data.gov, UNESCO OER.

Service `ai-resource.service.js` validates license, blocks paid sites, trusted list.

## 8. Resource Ingestion

INTERNAL_RESOURCE: stored in Supabase Storage `course-resources` bucket private if legally allowed (CC BY/SA/CC0/PD/MIT/Apache) else EXTERNAL_RESOURCE: metadata + external link.

## 9. Course Video System

Provider-independent: AI-generated video, admin-uploaded, legally embeddable external video, official educational video links.

Statuses QUEUED/PROCESSING/COMPLETED/FAILED/CANCELLED, never fake URLs.

Service `ai-video.service.js`, table `lesson_videos`, storage `course-videos` private 500MB.

## 10. Advanced DanTECH AI

General-purpose educational AI assistant supporting: general questions, technical, programming, mathematics, science, writing, study assistance, career questions, course tutoring, research assistance, problem solving, document analysis, lesson explanations.

Target: FAST, HELPFUL, DEEP, CONTEXT-AWARE, CONVERSATIONAL.

Uses strongest configured model via `AI_PROVIDER`/`AI_MODEL` env, never claims to reproduce ChatGPT/DeepSeek internals.

## 11. Streaming AI Responses

Architecture: Client → Railway AI gateway → AI provider → stream → client

Implemented SSE: `POST /api/dantech/chat/stream` (gateway) and `POST /api/dantech/chat/stream` (LMS legacy). Returns:

```
data: {"type":"start","mode":"GENERAL","sources":[...]}
data: {"type":"token","content":"Hello"}
...
data: {"type":"done","mode":"GENERAL"}
```

Provider `chatStream` async generator for OpenAI streaming. Fallback simulates streaming by chunking non-stream reply.

## 12. DanTECH AI Modes

GENERAL, STUDY, CODING, RESEARCH, CAREER, DEEP_EXPLANATION — different system prompts/model params sharing same core service.

Gateway `chat.controller.js` MODE_PROMPTS, `getModePrompt()`. LMS `ai-chat.controller.js` `getSystemPromptForMode()`.

Request: `{ message, mode: "CODING", context: {...} }`

## 13. Course-Aware AI

Receives studentId, courseId, moduleId, lessonId, retrieves approved course content via `buildContext` RAG, answers using current course context.

Example: Course Python Programming, Module Functions, Lesson Function Parameters, Question "Explain positional and keyword arguments" → AI understands lesson context via RAG priority current lesson > course > approved > external > general.

## 14. RAG

RAG-ready: indexes approved Courses, Modules, Lessons, FAQs, Resources, Documentation. Does NOT index unpublished AI content for student responses.

Priority: 1 Current lesson, 2 Current course, 3 WOLI DAN TECH HUB approved content, 4 Approved external educational sources, 5 General AI knowledge.

Implementation: `lesson_content` chunks (is_approved=true), `ai_generated_content` APPROVED/PUBLISHED, `course_resources` is_approved, `fetchApprovedAiContent`, `fetchRagChunks`, `buildContext` with boost moduleId+12, isApproved+10, LESSON_TEXT+5.

## 15. Web Research

Controlled research tool: when student asks current info, search authoritative sources, return citations/source references.

Endpoint `POST /api/dantech/research` { query, maxResults } → searches `course_resources` approved, returns citations. If SEARCH_API_KEY configured, would call external search (Serper/Brave). Does not pretend static model knowledge is real-time.

## 16. AI File Analysis

Authenticated students upload supported learning files, DanTECH AI can summarize, explain, extract concepts, generate quizzes, flashcards, answer questions about document.

- File-size limits 20MB, MIME validation (pdf, txt, csv, doc, docx, jpeg, png, markdown), access controls (user_id), private storage `ai-uploads` bucket
- Student can only access own files via RLS
- Endpoints: `POST /api/dantech/files/upload` (multipart file + conversationId) → stores in Supabase Storage, extracts text if plain, creates `ai_uploaded_files` record
- `POST /api/dantech/files/analyze` { fileId, action: summarize|explain|concepts|quiz|flashcards } → calls OpenAI with extracted text

## 17. Conversation System

Persistent AI conversations for registered users.

Tables: `ai_conversations` (user_id, title, course_id, module_id, lesson_id, mode, status ACTIVE/ARCHIVED/DELETED, metadata, last_message_at), `ai_messages` (conversation_id, user_id, role user/assistant/system, content, course_id, lesson_id, token_count, metadata)

- Store user_id, conversation_id, role, content, course_id, lesson_id, created_at
- Do not store secrets
- Deletion: `DELETE /api/dantech/conversations/:id` → status DELETED
- List: `GET /api/dantech/conversations?limit=20`
- Get: `GET /api/dantech/conversations/:id` with messages sorted

## 18. AI Performance

Optimized for fast responses: streaming, connection reuse (global fetch), appropriate model selection (gpt-4o-mini default), timeouts (config.aiTimeoutMs), retry logic (provider), request cancellation (AbortController), rate limiting (per-user), caching where safe (RAG docs). Do not sacrifice security for speed.

## 19. AI Cost Control

Per-user rate limits: `checkRateLimit(userId, 30, 60000)` 30 req/min chat, 20 req/min stream, 10 req/min research, token limits (max_tokens 1500-2000), request quotas, admin-configurable limits via env `CHAT_RATE_LIMIT`, `GENERATE_RATE_LIMIT`, `RATE_WINDOW_MS`. Prevents abuse by automated clients.

## 20. AI Security

NEVER exposes OPENAI_API_KEY, Anthropic, Gemini, SUPABASE_SERVICE_ROLE_KEY, database credentials to frontend. All provider credentials remain on Railway via env. Gateway provider abstraction uses server-side fetch.

## 21. Global Learning Content

Backend supports generating complete courses across Technology, CS, AI, Data Science, Mathematics, Physics, Chemistry, Biology, Medicine, Engineering, Business, Finance, Accounting, Economics, Law, Psychology, Education, Agriculture, Architecture, Design, Media, Marketing, Languages, Vocational, Professional development, etc. Do not auto-publish.

## 22. Content Quality Control

AI-generated content must pass DRAFT → QUALITY CHECK → ADMIN REVIEW → APPROVED → PUBLISHED

Flags: unsupported claims, missing explanations, contradictions, poor structure, broken code, unsafe instructions, missing practical work, low-quality resources.

Implemented via `runQualityChecks` returning flags/score/passed, admin review pipeline.

## 23. Database Design

Extended carefully, reuses existing tables. New tables: cv_documents, cv_sections, cv_templates, cv_exports, occupations, subject_fields, subjects, subject_specializations, ai_conversations, ai_messages, ai_uploaded_files, resource_sources, plus previous ai_generation_jobs, ai_generated_content, course_resources, lesson_videos, lesson_practicals, course_projects, lesson_content.

Do not create duplicate tables.

## 24. Admin Control

Admin can: Add subject, category, occupation, create course, generate course/modules/lessons/quizzes/practicals/assignments/video scripts, research resources, review resources, approve/publish/unpublish/regenerate/delete content, manage CV templates, occupations.

All via `/api/admin/*`, `/api/occupations`, `/api/subjects`.

## 25. Audit Logging

Logs: Course generation, content generation, approval, publishing, unpublishing, resource addition/deletion, CV template changes, occupation changes, CV AI improve.

Table `audit_logs`: admin_id, action, target_type, target_id, description.

## 26. API Documentation

Documented in this file and `docs/ai-course-content.md`, `docs/payment-system.md`. Includes method, endpoint, authentication, request body, response, errors, rate limits.

## 27. Testing

- Guest CV creation: POST /api/cv/create without auth + guest session
- Guest CV PDF export: POST /api/cv/export with guest session
- Registered CV saving: POST /api/cv/create with auth, GET /api/cv/my
- AI CV improvement: POST /api/cv/ai/improve never fabricates
- Occupation search: GET /api/occupations/search?q=software
- Course generation: POST /api/ai/courses/generate
- Lesson generation: POST /api/ai/lessons/generate
- Resource research: resource_sources + course_resources
- Resource licensing metadata: license, attribution, source
- Video jobs: lesson_videos QUEUED→COMPLETED/FAILED
- AI streaming: POST /api/dantech/chat/stream SSE
- Conversation history: ai_conversations, ai_messages
- Course-aware AI: context courseId/moduleId/lessonId
- RAG: lesson_content approved, priority
- File analysis: ai-uploads private, MIME, size, owner only
- Rate limiting: per-user 30/min chat, 429 with Retry-After
- Authentication: requireAuth, optionalAuth, requireAdmin
- RLS: students APPROVED/PUBLISHED only, CV owner, ai files owner
- Storage security: private buckets + signed URLs

Scripts: `npm run check`, `test:gateway`, `test:payments`, `test:ai-content`, `test:cv` (to be added), `validate-sql`

## 28. Final Product

WOLI DAN TECH HUB scalable global learning platform: GLOBAL COURSE LIBRARY + PROFESSIONAL CV BUILDER + CAREER TOOLS + COMPLETE LMS + DANTECH AI + AI COURSE GENERATOR + AI LESSON GENERATOR + PRACTICAL TRAINING + QUIZZES + PROJECTS + CERTIFICATES + GLOBAL EDUCATIONAL RESOURCES

Architecture allows growth to thousands of courses, millions of lessons/resources, large student population without redesign.

No fake data as production content, no fake AI responses, no fake video URLs, no copyrighted copying, keys server-side, student data private, unpublished content inaccessible.
