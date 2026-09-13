# WOLI DAN TECH HUB — Mobile/API Compatibility

Per spec 33: backend must fully support mobile clients (Android, iPhone) over mobile networks, 4G/5G, slower/intermittent connections.

## API Response Size

Do not return unnecessarily large payloads. Use pagination, field selection, lazy loading, cursor pagination.

- **Course listings**: `GET /api/mobile/courses?limit=20&page=1&fields=id,title,slug,price` returns only requested fields, paginated, minimal mode strips description to 100 chars
- **Course metadata separate from detailed**: `GET /api/mobile/courses/:idOrSlug` returns metadata only (id, title, slug, description, price, thumbnail, duration, difficulty, modules_count, lessons_count) with `_links` to paginated modules
- **Modules paginated**: `GET /api/mobile/courses/:id/modules?limit=20&page=1` returns modules with lessons_count (batch query, not N+1), pagination total/total_pages/has_more/next_cursor
- **Lessons per module paginated**: `GET /api/mobile/courses/:id/modules/:moduleId/lessons?limit=20&page=1` metadata only (id, title, description, lesson_type, duration, order_number)
- **Individual lesson**: `GET /api/mobile/lessons/:lessonId` returns lesson metadata + progress, not heavy relations unless `?include=video,resources,practicals,quizzes`
- **Course content legacy**: `GET /api/courses/:courseId/content?include=modules,lessons&minimal=true` — mobile returns metadata only with links if no include, supports ?include= param to avoid huge payload, pagination for modules, limits 50 lessons for mobile vs 100 desktop

## Mobile Course Delivery

Supports: Course → Modules → Lessons → Individual lesson, do not send thousands in one response.

```
GET /api/mobile/courses → list paginated
GET /api/mobile/courses/:id → metadata + modules_count
GET /api/mobile/courses/:id/modules → paginated modules
GET /api/mobile/courses/:id/modules/:moduleId/lessons → paginated lessons
GET /api/mobile/lessons/:lessonId → individual lesson + progress
GET /api/mobile/lessons/:lessonId/video → signed URL with range support
GET /api/mobile/lessons/:lessonId/resources → paginated resources with signed URLs
```

- Field selection: `?fields=id,title,slug` validated against allowed list, 400 INVALID_FIELDS if invalid
- Lazy loading: `?include=video,resources,practicals,quizzes,assignments,ai_content,rag` in lesson detail, only loads requested
- Cursor pagination: `next_cursor` base64 offset, `has_more` flag

## Video Delivery

Efficient video delivery, do not download entire video unnecessarily, use streaming, range requests, signed URLs, CDN-compatible.

- `GET /api/mobile/lessons/:lessonId/video?quality=auto` returns:
```json
{
  "video": {
    "id": "uuid",
    "duration": 600,
    "thumbnail_url": "https://...",
    "url": "https://...supabase.co/storage/v1/object/sign/course-videos/...?token=...",
    "expires_in": 3600,
    "quality": "auto",
    "streaming": true,
    "range_supported": true
  }
}
```
- Private course videos protected: enrollment ACTIVE/COMPLETED check, admin bypass, signed URL 3600s, Supabase storage supports Range requests natively, CDN-compatible URL (supabase.co/storage/v1/object/sign/...)
- Legacy `lessons.video_url` fallback if no `lesson_videos` entry

## PDF Delivery

Return secure URLs for PDFs, signed URLs for private resources, do not expose private storage credentials.

- `course_resources` with storage_path → `createSignedUrl(..., 3600)` → signed_url + expires_in
- `cv_exports` → signed URL 600s guest / 3600s user
- `certificates` → signed URL via existing `getReceiptUrl`
- No storage credentials exposed, only signed URLs

## File Uploads

Mobile users upload receipts, assignments, CV-related files, learning documents.

Support upload progress, reasonable file limits, resume/retry, timeout handling, clear errors, server-side validation.

### Single upload (small files)

`POST /api/mobile/uploads/single` multipart `file` + `bucket` (receipts/assignments/cv/learning/general) → validates MIME per bucket, file size, 60s timeout AbortController, returns filePath, signedUrl

Limits:
- payment-receipts: 5MB jpg/png/pdf
- lesson-resources: 20MB pdf/jpg/png/zip/doc/docx
- cv-exports: 10MB pdf/jpg/png
- ai-uploads: 20MB pdf/txt/csv/doc/docx/jpg/png/md

### Resumable chunked upload (large files, slow/intermittent)

For mobile networks, 4G/5G, slower, intermittent:

1. `POST /api/mobile/uploads/init` { fileName, fileType, fileSize, totalChunks, bucket } → 201 { sessionId, bucket, chunkSize: 1MB, expiresIn: 1800 }
2. `POST /api/mobile/uploads/chunk` multipart `chunk` + { sessionId, chunkIndex, totalChunks } → stores chunk in memory map, returns { receivedChunks, progress% }, supports retry (idempotent chunk index), when all chunks received assembles Buffer.concat and uploads to Supabase storage
3. `GET /api/mobile/uploads/session/:sessionId` → { received, missing, progress, expiresIn } for resume after interruption
4. `DELETE /api/mobile/uploads/session/:sessionId` → cancel

- MIME validation per bucket, file size ≤50MB total
- Timeout 60s per upload, AbortController
- Progress tracking, missing chunks list for resume
- Cleanup old sessions every 10 min, 30 min expiry, unref interval so check.js doesn't hang
- Clear errors: SESSION_NOT_FOUND, MISSING_CHUNK, FILE_TOO_LARGE, UNSUPPORTED_TYPE, STORAGE_ERROR

Client can show upload progress via XHR progress events for single upload, or chunk progress for resumable.

## DanTECH AI Mobile Performance

Optimize for mobile connections: streaming responses, request cancellation, timeouts, retry handling, rate limiting, connection interruption.

- **Streaming**: `POST /api/dantech/chat/stream` SSE, `POST /api/dantech/chat` non-streaming, gateway `POST /api/dantech/chat/stream` SSE
- **Request cancellation**: AbortController in `ai-chat.controller.js` chat and chatStream, req.on('close') aborts fetch if client disconnects, prevents wasted provider calls
- **Timeouts**: 30s timeout for AI provider calls via setTimeout abort, 30s timeout middleware for gateway and mobile routes returns 504 REQUEST_TIMEOUT with retry hint
- **Retry handling**: Client can retry with same X-Request-Id / X-Idempotency-Key header, requestIdMiddleware captures, rate limiter allows retry after window
- **Rate limiting**: per-user 30/min chat, 20/min stream, 10/min research, 429 with Retry-After, X-Cache HIT/MISS
- **Connection interruption**: res.on('close') logs connection_interrupted, does not corrupt conversation — user message saved before AI call, assistant message saved only after completion, so interruption leaves conversation in valid state (user message without assistant reply, can retry)
- **Mobile detection**: User-Agent Mobile|Android|iPhone|iPad or X-Mobile header, logs mobile flag, minimal mode via ?minimal=true or X-Minimal header

## API Error Format

Consistent machine-readable errors, no stack traces.

```json
{
  "success": false,
  "error": {
    "code": "PAYMENT_ALREADY_REVIEWED",
    "message": "This payment has already been reviewed."
  }
}
```

Implemented in `errorHandler.js` and gateway `app.js`:

- Returns { success: false, error: { code, message, details? } }
- Details only in non-production
- Multer file too large → FILE_TOO_LARGE
- Timeout → REQUEST_TIMEOUT 504
- No stack traces, logs server-side only

## Performance

Avoid N+1 queries, unnecessary joins, huge JSON, unbounded queries, duplicate DB calls. Use indexes, pagination, caching, connection pooling, query optimization.

- **N+1 avoided**: `withInstructors` batch fetch profiles via `in(id)`, `lessonsCountMap` batch counts per module, modules/lessons fetched via `in(module_id)` not per-module queries
- **Unnecessary joins avoided**: course listings select only needed fields, field selection, minimal mode, include param conditional fetching
- **Huge JSON avoided**: course content returns metadata only for mobile unless include, limits 10-50 for resources/practicals/quizzes for mobile vs 20-50 desktop, lessons limit 50 mobile
- **Unbounded queries avoided**: all list endpoints have limit max 50-100, default 20, pagination required, count exact with head:true for counts without data
- **Duplicate DB calls avoided**: enrollment check once per request, course/module fetched once
- **Indexes**: existing idx_courses_published, idx_modules_course, idx_lessons_module, idx_occupations_title_trgm, idx_subjects_field, plus new pagination indexes via order_number
- **Caching**: `cacheMiddleware` 60s for public GET no auth, X-Cache HIT/MISS header, prunes oldest when >200 entries, safe no PII
- **Connection pooling**: Supabase client uses pooling, fetch reuse
- **Query optimization**: select specific columns not *, range pagination, head:true for counts

## Security

Mobile compatibility never weakens authentication, RLS, authorization, private storage, signed URLs, payment security, student data protection.

- All mobile routes require authenticate except public catalog (optionalAuth)
- RLS: students APPROVED/PUBLISHED only, CV owner, ai files owner, enrollments ACTIVE/COMPLETED check for lesson/video/resources
- Private storage: course-videos, course-resources, cv-exports, ai-uploads private, signed URLs 600s-3600s
- Payment security: server-side amount validation, RLS, private receipts, no frontend trust
- No credentials exposed

## Testing

Test API behavior under normal, slow, timeout, interrupted upload, repeated request, expired auth, large file, invalid file, unauthorized.

- **Normal**: all endpoints return success with pagination
- **Slow**: timeoutMiddleware 30s returns 504 with retry hint, client can retry
- **Request timeout**: AbortController aborts provider calls after 30s, returns AI_ERROR or 504
- **Interrupted upload**: chunked upload session tracks received/missing, GET /session/:id returns progress for resume, DELETE cancels, connection close aborts and does not corrupt
- **Repeated request**: idempotency via X-Request-Id / X-Idempotency-Key, rate limiting 429 with Retry-After
- **Expired auth**: authenticate middleware returns 401 UNAUTHORIZED, consistent error format
- **Large but permitted file**: 20-50MB limits enforced, FILE_TOO_LARGE 400 with clear message
- **Invalid file**: MIME validation per bucket, UNSUPPORTED_TYPE 400 with allowed list
- **Unauthorized**: 403 FORBIDDEN, 401 UNAUTHORIZED, RLS blocks

Script `test-mobile.mjs` validates all above: pagination, field selection, mobile optimize, cache, timeout, request ID, course→modules→lessons→individual, video signed URL range support, resources signed URLs, resumable uploads init/chunk/progress/cancel, MIME/size limits, error format, N+1 avoidance, AbortController.

## Endpoints Summary (Mobile)

```
GET  /api/mobile/courses?limit=&page=&fields=&minimal=&category=&search=
GET  /api/mobile/courses/:idOrSlug?fields=&minimal=
GET  /api/mobile/courses/:idOrSlug/modules?limit=&page=
GET  /api/mobile/courses/:idOrSlug/modules/:moduleId/lessons?limit=&page=
GET  /api/mobile/lessons/:lessonId?include=video,resources,practicals,quizzes
GET  /api/mobile/lessons/:lessonId/video?quality=
GET  /api/mobile/lessons/:lessonId/resources?limit=&page=

POST /api/mobile/uploads/single (multipart file)
POST /api/mobile/uploads/init { fileName, fileType, fileSize, totalChunks, bucket }
POST /api/mobile/uploads/chunk (multipart chunk + sessionId, chunkIndex)
GET  /api/mobile/uploads/session/:sessionId
DELETE /api/mobile/uploads/session/:sessionId
```

All mobile routes support `X-Mobile: true`, `X-Minimal: true`, `X-Request-Id` headers for mobile clients.
