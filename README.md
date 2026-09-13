# WOLI DAN TECH HUB — Secure AI Gateway (Railway backend)

The backend service behind **AI Studio** and **DanTECH AI** for the WOLI DAN
TECH HUB LMS. It holds every AI API key server-side, verifies Supabase
sessions, grounds the student assistant in published course content, and
enforces academic integrity where the frontend cannot.

```
WOLI DAN TECH HUB FRONTEND (Vite / React, talks to Supabase directly for LMS data)
        │  HTTPS  +  Authorization: Bearer <supabase access token>
        ▼
RAILWAY  ── this service ──────────────────────────────
   GET  /health              public, Railway healthcheck
   POST /api/ai/generate     admin only      → AI Studio "Generate"
   POST /api/dantech/chat    authenticated   → DanTECH AI assistant
        │
        ├──► LLM provider (OpenAI | Anthropic | Gemini)
        └──► SUPABASE (service role, server-side only)
               ├── Auth        verifies the caller's JWT + profiles.role
               ├── PostgreSQL  published lessons for RAG
               └── Storage     untouched by this service
```

> The service **never writes to Supabase**. Every AI result goes back to the
> frontend, which stores it as a `draft` row in `ai_generated_content` for
> admin review.

---

## 1. Quick start (local)

```bash
git clone https://github.com/wolidantech/Tech-hub-backend.git
cd Tech-hub-backend
npm install
cp .env.example .env      # then fill in the real values

npm start                 # http://localhost:5000
npm run check             # parse + assemble sanity check
npm run test:gateway      # 64 offline end-to-end checks
curl http://localhost:5000/health
```

`npm run dev` runs the same service with `--watch`.

## 2. Environment variables

Secrets live **only** in Railway Variables (or your local `.env`, which is
git-ignored). Nothing here is ever returned to a client or written to a log.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AI_PROVIDER` | ✅ | — | `openai` \| `anthropic` \| `gemini` |
| `AI_MODEL` | | per provider | e.g. `gpt-4o-mini`, `claude-3-5-haiku-latest`, `gemini-1.5-flash` |
| `OPENAI_API_KEY` | ✅¹ | — | Required when `AI_PROVIDER=openai` |
| `ANTHROPIC_API_KEY` | ✅¹ | — | Required when `AI_PROVIDER=anthropic` |
| `GEMINI_API_KEY` | ✅¹ | — | Required when `AI_PROVIDER=gemini` |
| `AI_BASE_URL` | | provider default | OpenAI-compatible base URL (proxies) |
| `AI_MAX_TOKENS` | | `4000` | Completion budget |
| `AI_TEMPERATURE` | | `0.7` | Sampling temperature |
| `AI_TIMEOUT_MS` | | `25000` | **Must stay < 30000** — the frontend aborts at 30s |
| `AI_MAX_RETRIES` | | `2` | Repairs/retries before returning 502 |
| `SUPABASE_URL` | ✅ | — | Project URL (Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — | **SECRET.** Server-side only, bypasses RLS for reads |
| `ALLOWED_ORIGINS` | ✅ | — | Comma-separated CORS allow-list of frontend origins |
| `PORT` | Railway-set | `5000` | Injected by Railway — do not set it there |
| `NODE_ENV` | | `development` | `production` on Railway |
| `CHAT_RATE_LIMIT` | | `30` | DanTECH requests per user per window |
| `GENERATE_RATE_LIMIT` | | `10` | AI Studio generations per admin per window |
| `RATE_WINDOW_MS` | | `60000` | Rate-limit window |
| `MAX_MESSAGE_CHARS` | | `4000` | Chat message cap |
| `MAX_HISTORY` | | `12` | Chat history turns accepted |
| `RAG_MAX_DOCS` | | `6` | Lessons retrieved per chat turn |
| `RAG_MAX_CHARS_PER_DOC` | | `2000` | Per-lesson context budget |

¹ Only the key for the selected `AI_PROVIDER` is required.

## 3. Deploy to Railway

1. **New Project → Deploy from GitHub repo** → `wolidantech/Tech-hub-backend`,
   branch `main`. Region: **Europe West** (closest to Nigeria).
2. **Variables** → add every required variable from the table above.
   Adding a variable triggers a redeploy automatically.
3. `railway.json` already sets the start command (`npm start`), the
   `/health` healthcheck, and caps crash restarts at 5 so a
   misconfiguration fails the deploy instead of looping.
4. **Settings → Networking → Generate Domain** to get the public URL.
5. Verify:

   ```bash
   curl https://<your-app>.up.railway.app/health
   # {"ok":true,"service":"woli-dan-tech-hub-ai-gateway", ...}
   ```
6. Put the public origin into `ALLOWED_ORIGINS` (comma-separated with any
   other frontend domain), then redeploy.

## 4. Point the frontend at it

Two variables in the **frontend** project:

```
VITE_AI_ENDPOINT=https://<your-app>.up.railway.app/api/ai/generate
VITE_DANTECH_ENDPOINT=https://<your-app>.up.railway.app/api/dantech/chat
```

Until they are set, the frontend keeps using its offline template provider
and on-device DanTECH tutor — nothing breaks in the meantime.

### Required frontend change (auth header)

`src/lib/ai.js` already forwards `opts.headers`, but `src/lib/dantech.js`
currently sends only `Content-Type`. Both calls must include the caller's
Supabase session token:

```
Authorization: Bearer <supabase access token>
```

Without it every request returns **401**. This is the only frontend change
needed — the response shapes are already what the frontend parses.

## 5. API contract

### `POST /api/ai/generate` — admin only

```jsonc
// request
{ "kind": "quiz", "input": { "topic": "useState", "numQuestions": 5 }, "options": {} }

// response
{ "output": { /* kind-shaped data */ }, "provider": "openai" }
```

Supported `kind` values (all 10 the AI Studio offers):

| kind | `output` shape |
| --- | --- |
| `course_outline` | `{ title, description, category?, duration?, level?, learningObjectives[], modules[{ title, summary?, practical?, lessons[{ title, description?, duration?, keyConcepts[] }], quiz?{ passingScore? } }], finalProject? }` |
| `quiz` | `{ title?, passingScore?, questions[{ type, question, options[], correctAnswer?, correctAnswers?, acceptedAnswers?, explanation? }] }` |
| `assignment` | `{ title, description, instructions, requiredOutput }` |
| `lesson_text` / `summary` / `notes` | `{ markdown }` |
| `exercise` | `{ title, steps[], deliverable, estimatedMinutes?, level? }` |
| `flashcards` | `{ title, cards[{ front, back }] }` |
| `video_script` / `voiceover` | `{ title, voice?{ gender, language, speed, style }, estimatedWords?, scenes[{ time, visual, narration }], subtitles? }` |

`lesson_script` is accepted as an alias of `video_script`. Output is validated
against these shapes with zod and repaired/retried up to `AI_MAX_RETRIES`
times; a persistent failure returns **502** with a friendly message.

### `POST /api/dantech/chat` — any authenticated user

```jsonc
// request
{ "message": "Explain useEffect", "context": { "courseId": "…", "lessonId": "…", "level": "Beginner" },
  "history": [{ "role": "user", "text": "…" }, { "role": "assistant", "text": "…" }] }

// response
{ "reply": "## useEffect\n\n…markdown…", "sources": [{ "courseTitle": "…", "lessonTitle": "…", "moduleTitle": "…", "courseId": "…", "lessonId": "…" }], "provider": "openai" }
```

- Grounded in **published, non-archived** lessons only, retrieved server-side
  with the service-role key (`courses.published = true AND courses.archived = false`).
- With `context.courseId` it retrieves that course's lessons; otherwise it
  keyword-searches published lessons.
- `sources` never contains lesson bodies — only titles/ids for citation.
- Replies are markdown, beginner-friendly and cite the course.

### Status codes

| Code | Meaning |
| --- | --- |
| `200` | Success (an academic-integrity refusal is also a `200` with a helpful `reply`) |
| `400` | Unknown `kind`, malformed body, empty or over-long message |
| `401` | Missing/invalid/expired Supabase token |
| `403` | Valid token but `profiles.role !== 'admin'` on `/api/ai/generate`, or blocked CORS origin |
| `429` | Rate limit exceeded (`Retry-After` header is set) |
| `502` | Provider error or unusable output after retries |
| `503` | Supabase Auth unreachable |

## 6. curl examples

`TOKEN` is a Supabase access token (`supabase.auth.getSession()`); the admin
account must have `profiles.role = 'admin'`.

```bash
API=https://<your-app>.up.railway.app

# health — no auth
curl -s $API/health
# {"ok":true,"service":"woli-dan-tech-hub-ai-gateway","time":"…","provider":"openai"}

# 401 without a token
curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/api/ai/generate \
  -H 'Content-Type: application/json' -d '{"kind":"quiz","input":{}}'
# 401

# 403 for a signed-in student (role checked server-side, never trusted from the client)
curl -s -X POST $API/api/ai/generate -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STUDENT_TOKEN" -d '{"kind":"quiz","input":{"topic":"useState"}}'
# {"error":"Forbidden","message":"AI Studio generation is restricted to administrators."}

# admin generation — course_outline
curl -s -X POST $API/api/ai/generate -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"kind":"course_outline","input":{"courseName":"React for Nigerian Freelancers","category":"Web Development","level":"Beginner","duration":"8 weeks","numModules":6},"options":{}}'
# {"output":{"title":"…","learningObjectives":[…],"modules":[{"title":"…","lessons":[…]}]},"provider":"openai"}

# admin generation — quiz
curl -s -X POST $API/api/ai/generate -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"kind":"quiz","input":{"topic":"useState","numQuestions":5},"options":{}}'
# {"output":{"passingScore":70,"questions":[{"type":"multiple_choice","question":"…","options":[…],"correctAnswer":0,"explanation":"…"}]},"provider":"openai"}

# admin generation — lesson_text
curl -s -X POST $API/api/ai/generate -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"kind":"lesson_text","input":{"topic":"useState","objective":"Use state safely","level":"Beginner"},"options":{}}'
# {"output":{"markdown":"# useState\n\n…"},"provider":"openai"}

# DanTECH AI chat turn with sources
curl -s -X POST $API/api/dantech/chat -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STUDENT_TOKEN" \
  -d '{"message":"Explain useState like I am a beginner","context":{"courseId":"<uuid>","lessonId":"<uuid>","level":"Beginner"},"history":[]}'
# {"reply":"## Understanding useState\n\n…\n\n📚 Based on your course: **Understanding useState**",
#  "sources":[{"courseTitle":"React for Nigerian Freelancers","lessonTitle":"Understanding useState","moduleTitle":"Module 1: React Foundations"}],"provider":"openai"}

# academic-integrity refusal (200, not an error)
curl -s -X POST $API/api/dantech/chat -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STUDENT_TOKEN" \
  -d '{"message":"write my assignment for me","context":{},"history":[]}'
# {"reply":"I can't complete assessed work *for* you — … I can help you finish it strong: …","sources":[],"provider":"guardrail"}

# 429 after 30 chat requests in a minute
curl -s -i -X POST $API/api/dantech/chat -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STUDENT_TOKEN" -d '{"message":"explain props"}'
# HTTP/1.1 429 … Retry-After: 41
```

> Every one of these behaviours — health, 401, 403, CORS, 400s, all 10 kinds,
> 502 handling, sources, the integrity refusal and both 429 limits — is
> asserted by `npm run test:gateway` (64 checks) against the real code with
> only the network stubbed. Run it before deploying.

## 7. Security model

- **Secrets**: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` exist only as Railway Variables. They are never
  committed, logged, proxied or returned. Error responses never contain stack
  traces or upstream bodies.
- **Auth**: tokens are verified against the **Supabase Auth API**
  (`/auth/v1/user`) — no hand-rolled JWT parsing, so key rotation and
  revocation are handled by Supabase. Verified results are cached for 60s.
- **Authorisation**: `profiles.role` is read from Postgres on every
  `/api/ai/generate` call. Claims inside the token are never trusted.
- **CORS**: only origins listed in `ALLOWED_ORIGINS`; everything else (including
  preflight) is rejected with 403.
- **Rate limiting**: per **authenticated user id**, not IP (Railway sits behind
  a proxy). 30/min chat, 10/min generation by default, `Retry-After` set.
- **Academic integrity**: enforced server-side *before* any model call
  (`src/gateway/integrity.js`) and repeated in the chat system prompt. A
  client-side check alone would be trivially bypassed.
- **RLS**: never disabled, never bypassed for user-facing reads. The service
  role is used only to read published content for grounding.
- **Logging**: method, path, status, duration and a hashed user id. No bodies,
  tokens, keys or PII.

## 8. Provider swapping

Change `AI_PROVIDER` (and `AI_MODEL`) and redeploy — no code change. The
abstraction lives in `src/gateway/providers/index.js`; adding a vendor means
adding one factory that implements `complete()` (strict JSON) and `chat()`
(markdown).

| `AI_PROVIDER` | Endpoint used | JSON mode |
| --- | --- | --- |
| `openai` | `POST /v1/chat/completions` | `response_format: json_object` |
| `anthropic` | `POST /v1/messages` | system prompt + JSON instruction |
| `gemini` | `POST /v1beta/models/{model}:generateContent` | `responseMimeType: application/json` |

## 9. Repository layout

```
src/gateway/            the deployed service
  server.js             entry point (npm start)
  app.js                Express app, CORS, logging, routes, error handling
  config.js             env validation (fails fast with an actionable message)
  auth.js               Supabase Auth API verification + admin role check
  supabase.js           PostgREST access (service role)
  rag.js                retrieval over published lessons
  integrity.js          server-side academic-integrity guard
  kinds.js              zod contracts for all 10 AI kinds
  prompts.js            per-kind system prompts + DanTECH chat prompt
  json.js               JSON extract/repair + validate-and-retry loop
  ratelimit.js          per-user fixed-window limiter
  providers/index.js    OpenAI | Anthropic | Gemini abstraction
scripts/
  test-gateway.mjs      64 offline end-to-end checks (npm run test:gateway)
  check.js              parse + assemble sanity check (npm run check)
  test-db.mjs           legacy LMS schema test (embedded Postgres)
docs/
  legacy-lms-backend.md documentation for the dormant LMS backend
```

### About the dormant LMS backend

This repository previously contained a full Express LMS API (`src/app.js`,
controllers, routes) written against an **earlier, different schema** — its
migrations define `lessons`, `payments`, `payment_receipts` and
`certificates`, whereas the live Supabase project (created from
`wolidantech/Tech-hub-frontend`'s `supabase/migrations/001–005`) uses
`course_lessons`, `course_content`, `manual_payments` and
`certificate_issues`.

That code is **not deployed** and is not reachable from `npm start`. It is
kept for reference and still parse-checked by `npm run check`. Do not point
Railway at it: its endpoints do not match the live tables. Its docs live in
[`docs/legacy-lms-backend.md`](docs/legacy-lms-backend.md) and it can still be
run locally with `npm run start:lms`.
