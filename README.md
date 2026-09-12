# WOLI DAN TECH HUB — Backend API

**LEARN • BUILD • GROW**

Production-ready backend for the WOLI DAN TECH HUB online learning platform.

- **Supabase PostgreSQL** — the real database (tables, constraints, triggers, functions)
- **Supabase Auth** — email/password authentication (no plain-text passwords anywhere)
- **Supabase Storage** — private buckets for receipts, certificates & lesson resources (signed URLs)
- **Row Level Security (RLS)** — enforced in PostgreSQL on every user table
- **Express API** — secure server-side operations, role-based access control (student / admin / instructor)
- **Manual bank-transfer payments** — students pay to a bank account, upload a receipt, an admin approves/rejects, and course access activates **automatically and atomically**

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Project structure](#2-project-structure)
3. [Setup guide (from zero)](#3-setup-guide-from-zero)
4. [Environment variables](#4-environment-variables)
5. [Running the server](#5-running-the-server)
6. [Creating the admin account](#6-creating-the-admin-account)
7. [Security model](#7-security-model)
8. [API reference](#8-api-reference)
9. [Payment flow (bank transfer)](#9-payment-flow-bank-transfer)
10. [Certificates](#10-certificates)
11. [Error codes](#11-error-codes)
12. [Frontend integration](#12-frontend-integration)

---

## 1. Architecture

```
┌────────────────┐        HTTPS + Bearer JWT         ┌───────────────────────────┐
│  WDTH Frontend │  ───────────────────────────────► │  Express API (this repo)  │
│  (React etc.)  │                                   │  • auth/role middleware   │
└────────────────┘                                   │  • validation (zod)       │
                                                     │  • uploads (multer)       │
                                                     └───────┬───────────────────┘
                                                             │ @supabase/supabase-js
                             ┌───────────────────────────────┼─────────────────────────────────┐
                             ▼                               ▼                                 ▼
                    ┌─────────────────┐          ┌────────────────────┐           ┌────────────────────┐
                    │  Supabase Auth  │          │  PostgreSQL + RLS  │           │  Supabase Storage  │
                    │  (students,     │          │  tables, triggers, │           │  • payment-receipts│ (private)
                    │   admin,        │          │  functions         │           │  • certificates    │ (private)
                    │   instructors)  │          │  approve_payment() │           │  • lesson-resources│ (private)
                    └─────────────────┘          │  atomic + auditable│           │  • avatars         │ (public)
                                                 └────────────────────┘           │  • thumbnails      │ (public)
                                                                                  └────────────────────┘
```

**The database is the source of truth.** The frontend never decides whether a
payment is approved or a course unlocked — enrollment only flips to `ACTIVE`
inside the `approve_payment()` database function, after an admin decision.

## 2. Project structure

```
.
├── supabase/
│   └── migrations/
│       ├── 20260910000001_initial_schema.sql        — enums, tables, constraints, indexes
│       ├── 20260910000002_functions_and_triggers.sql — auth sync, atomic payment
│       │                                                approval/rejection, course
│       │                                                completion, certificates
│       ├── 20260910000003_rls_policies.sql          — Row Level Security everywhere
│       ├── 20260910000004_storage.sql               — private/public buckets + policies
│       └── 20260910000005_seed.sql                  — categories, bank details, 12 courses
├── src/
│   ├── config/          env.js, supabase.js (anon / service-role / per-user clients)
│   ├── middleware/      auth+roles, zod validate, multer uploads, rate limiters, errors
│   ├── controllers/     auth, catalog, payments, learning, certificates, notifications,
│   │                    admin-payments, admin-courses, admin-students, admin-dashboard
│   ├── services/        storage (signed URLs), audit log, learning progress, PDF certificates
│   ├── routes/          REST route definitions
│   ├── validation/      zod schemas for every endpoint
│   ├── app.js           express app assembly
│   └── server.js        entrypoint
├── scripts/
│   ├── migrate.js       applies supabase/migrations/*.sql via DATABASE_URL
│   ├── create-admin.js  creates the initial admin (wolidantech@gmail.com)
│   ├── setup-storage.js idempotent bucket (re)creation helper
│   ├── check.js         syntax/assembly sanity check
│   └── validate-sql.mjs PostgreSQL grammar check for the SQL files (dev)
└── .env.example
```

## 3. Setup guide (from zero)

### 3.1 Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project** (choose a region close to your users, set a strong DB password).
2. When the project is ready, open **Project Settings → API** and copy:
   - Project URL
   - `anon public` key
   - `service_role` key *(secret — server only)*
3. Open **Project Settings → Database → Connection string** and copy the **URI** (this is your `DATABASE_URL`).

### 3.2 Configure the environment

```bash
cp .env.example .env
# then fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
# DATABASE_URL, FRONTEND_URL, ADMIN_INITIAL_PASSWORD
```

### 3.3 Install dependencies & apply the database migrations

```bash
npm install
npm run migrate
```

The migration script creates **all tables, constraints, indexes, functions,
triggers, RLS policies, storage buckets, storage policies** and seeds the
categories, platform settings (bank details) and the 12 initial courses
at **₦5,000.00** each.

> Prefer the Supabase CLI? `supabase link --project-ref <ref>` then
> `supabase db push` applies the same files.

### 3.4 (Optional, only if not using migrate.js) create buckets manually

```bash
npm run storage:setup
```

### 3.5 Create the administrator

```bash
npm run create:admin
# uses ADMIN_EMAIL (default wolidantech@gmail.com) and ADMIN_INITIAL_PASSWORD
# from .env — or asks interactively if the password is not set.
```

### 3.6 Start the API

```bash
npm run dev      # development (auto-reload)
npm start        # production
```

# 4. Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `SUPABASE_URL` | ✅ | Project URL (Settings → API). Also accepted: `SUPABASE_PROJECT_URL`, `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | ✅ | Public anon key (safe for browser too). Also accepted: `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | **SECRET — server only.** Bypasses RLS for trusted operations. Also accepted: `SUPABASE_SERVICE_KEY`, `SUPABASE_SECRET_KEY` |
| `PORT` | | API port (default `5000`) |
| `NODE_ENV` | | `development` / `production` |
| `FRONTEND_URL` | ✅ | Comma-separated allowed CORS origins of the frontend |
| `DATABASE_URL` | scripts | Postgres URI used by `npm run migrate` only |
| `ADMIN_EMAIL` | | Default `wolidantech@gmail.com` |
| `ADMIN_INITIAL_PASSWORD` | scripts | Initial admin password (server-side secret, used once) |
| `AUTO_CONFIRM_EMAIL` | | `true` to skip email confirmation during development |
| `MAX_RECEIPT_SIZE_MB` | | Receipt upload cap (default `5`) |
| `MAX_RESOURCE_SIZE_MB` | | Lesson resource upload cap (default `20`) |

**Never** put the service role key in frontend code. Supabase stores
passwords hashed — the database never contains plain-text passwords.

### Verifying your configuration

```bash
npm run check:env
```

Prints every variable the API resolved (secrets masked), where each value came
from, and exits non-zero with a full report if something is missing or wrong —
for example when the anon key was pasted into the service-role slot. On
Railway: `railway run npm run check:env`.

Missing or invalid variables are reported **all at once** before the server
starts, so one deploy log tells you everything that needs fixing.

## 5. Running the server

```bash
npm run check   # parse + assemble sanity check
npm run dev     # http://0.0.0.0:5000 with --watch
curl http://localhost:5000/health
```

## 6. Creating the admin account

The initial administrator is **wolidantech@gmail.com**:

```bash
ADMIN_INITIAL_PASSWORD='choose-a-strong-password' npm run create:admin
```

- The password is passed through a **server-side environment variable** — it is
  never hard-coded and never reaches the frontend.
- Re-running the script promotes the existing account back to `admin` and resets
  its password — a safe recovery path.
- Additional admins/instructors are created later from the admin dashboard
  (`POST /api/admin/instructors`, `POST /api/admin/users/:id/role`).
- Admins change their own password via `POST /api/auth/change-password`.

## 7. Security model

### Roles

| Role | How it is assigned |
| --- | --- |
| `student` | Default on every public registration (DB trigger hard-codes it) |
| `admin` | Only by `scripts/create-admin.js` or an existing admin |
| `instructor` | Only by an admin |

The `profiles` table is the role source of truth. A database **trigger**
(`trg_profiles_role_guard`) makes role changes by non-admins impossible — even
if the frontend is tampered with.

### Row Level Security (enabled on every table)

| Table | Students | Admins |
| --- | --- | --- |
| `profiles` | read/update **only their own** row (role immutable) | full |
| `course_categories`, `courses` | read **published** only | full CRUD |
| `course_modules` | read published-course outlines | full CRUD |
| `lessons` | read **only when enrolled & course paid (ACTIVE/COMPLETED)** | full CRUD |
| `payments` | insert `PENDING` for themselves; read own | full — approve/reject |
| `payment_receipts` | insert for their **own PENDING** payment; read own | full |
| `enrollments` | read own (mutations are service-role only) | read |
| `lesson_progress` | read/upsert own, only for enrolled courses | read |
| `certificates` | read own | read/revoke |
| `notifications` | read own + mark read | read |
| `audit_logs` | — | read |
| `platform_settings` | read `is_public` rows (bank details) | full |

### Storage buckets

| Bucket | Privacy | Access |
| --- | --- | --- |
| `payment-receipts` | **private** | Owner + admin only, via short-lived **signed URLs** (10 min student / 60 min admin) |
| `certificates` | **private** | Owner + admin, signed URLs |
| `lesson-resources` | **private** | Enrolled students, signed URLs issued by the API |
| `avatars` | public read | owner writes to their own folder only |
| `course-thumbnails` | public read | admin writes only |

### Server-side safeguards

- JWT verified on every request; role checked **from the DB**, not the token payload.
- **Atomicity**: `approve_payment()` / `reject_payment()` run as a single
  PostgreSQL transaction (payment status + enrollment + notifications + audit).
  If any step fails, everything rolls back — no inconsistent states.
- Only **one PENDING payment per student/course** (partial unique index);
  transaction references are globally unique.
- File uploads: MIME allowlist + size cap in multer, bucket-level MIME/size
  enforcement, and **magic-byte verification** for receipts.
- Rate limiting on auth (`30/15min`) and payment submission (`20/10min`) endpoints.
- Helmet security headers, strict CORS whitelist, 1 MB JSON body cap.
- Errors never expose SQL, stack traces or server internals.

## 8. API reference

Base URL: `/api` — all responses are JSON: `{ success, message?, data? }` or
`{ success: false, error: { code, message } }`.

Protected endpoints need `Authorization: Bearer <access_token>`.

### Auth & profile

| Method | Endpoint | Role | Description |
| --- | --- | --- | --- |
| POST | `/auth/register` | public | Register student (JSON or multipart with `photo`) |
| POST | `/auth/login` | public | Login → `{ profile, session }` |
| POST | `/auth/logout` | user | Logout |
| POST | `/auth/forgot-password` | public | Email a reset link |
| POST | `/auth/reset-password` | recovery token | Set new password from reset link |
| POST | `/auth/change-password` | user | Change password (requires current password) |
| GET | `/profiles/me` | user | `get-profile` |
| PUT | `/profiles/me` | user | `update-profile` (multipart `photo` optional) |

### Catalog (public)

| Method | Endpoint | Note |
| --- | --- | --- |
| GET | `/course-categories` | all categories |
| GET | `/courses?category=&search=&difficulty=&page=&limit=` | published courses |
| GET | `/courses/:idOrSlug` | detail + curriculum **outline** (no gated content) |
| GET | `/courses/:idOrSlug/lessons` | 🔒 students: only when enrolled & paid |

### Enrollment & payments (student)

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/enrollments` `{course_id}` | `enroll-course` → returns bank details + exact amount |
| POST | `/payments` | `submit-payment` — multipart: `receipt` file + `course_id`, `transaction_reference`, `transaction_date` |
| GET | `/payments/me` | `get-my-payments` + summary (Total Paid counts APPROVED only) |
| GET | `/payments/:id/receipt-url` | signed URL for own receipt |
| GET | `/enrollments/me` | `get-my-courses` with progress & continue-learning |

### Learning (student, enrollment-gated)

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/learning/my-courses` | My Courses dashboard data |
| GET | `/learning/courses/:id` | Full course player payload (🔒 access server-verified) |
| GET | `/learning/courses/:id/progress` | `get-course-progress` (e.g. 13/20 → 65%) |
| GET | `/learning/lessons/:lessonId` | Single gated lesson + signed resource URL |
| POST | `/learning/lessons/:lessonId/progress` | `mark-lesson-complete` / save `last_position` (continue learning) |

### Certificates

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/certificates/me` | my certificates |
| GET | `/certificates/:id` | metadata + signed PDF download URL |
| GET | `/public/verify-certificate/:identifier` | **public** verification (cert number `WDTH-2026-000001` or code) |

### Notifications

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/notifications` | my notifications + unread count |
| POST | `/notifications/read-all` | mark all read |
| POST | `/notifications/:id/read` | mark one read |

### Admin (all require `role = admin`)

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/admin/statistics` | students, courses, enrollments, payments & revenue (APPROVED only) |
| GET | `/admin/payments?status=PENDING` | `get-pending-payments` review queue |
| GET | `/admin/payments/:id` | detail + signed receipt URL + history |
| POST | `/admin/payments/:id/approve` | **atomic** approve → enrollment ACTIVE + notifications |
| POST | `/admin/payments/:id/reject` `{rejection_reason}` | atomic reject + notification |
| GET/POST | `/admin/courses` | list all / `create-course` |
| GET/PATCH/DELETE | `/admin/courses/:idOrSlug` | read / `update-course` (incl. **price**) / delete-or-unpublish |
| POST | `/admin/courses/:idOrSlug/thumbnail` | upload thumbnail (multipart `file`) |
| POST/PATCH/DELETE | `/admin/categories…` | manage categories |
| POST | `/admin/courses/:idOrSlug/modules` | create module |
| POST | `/admin/courses/:idOrSlug/modules/reorder` | `{ids:[...]}` atomic reorder |
| PATCH/DELETE | `/admin/modules/:id` | edit / delete module |
| POST | `/admin/modules/:id/lessons` + `/reorder` | create / reorder lessons |
| PATCH/DELETE | `/admin/lessons/:id` | edit (publish/unpublish, video_url…) / delete |
| POST | `/admin/lessons/:id/resource` | upload lesson file (private bucket) |
| GET | `/admin/enrollments?status=` | all enrollments |
| PATCH | `/admin/enrollments/:id` | cancel/activate enrollment (audited) |
| GET | `/admin/students?search=` | search students (never passwords) |
| GET | `/admin/students/:id` | profile + courses + payments + progress + certificates |
| PATCH | `/admin/students/:id` | update student (audited) |
| GET/POST | `/admin/instructors` | list / create instructor accounts |
| POST | `/admin/users/:id/role` | change role (`student`/`admin`/`instructor`) |
| GET/PATCH | `/admin/certificates…` | list / revoke / reactivate |
| GET/PUT | `/admin/settings` | view / update settings (e.g. `bank_details`) |
| GET | `/admin/audit-logs` | full admin action history |

## 9. Payment flow (bank transfer)

```
STUDENT                                   ADMIN
  │                                         │
  │ POST /api/enrollments ─► bank details:  │
  │   MONIEPOINT                            │
  │   69852663361                           │
  │   LUNA ENTRY SERVICES- WOLI DAN TECH HUB│
  │                                         │
  │── transfers NGN 5,000.00 ──────────────►│
  │                                         │
  │ POST /api/payments (receipt + ref)      │
  │   → payment.status = PENDING            │
  │   → enrollment NOT activated            │
  │   "Payment submitted successfully       │
  │    and is awaiting admin verification." │
  │                                         │
  │                              GET /api/admin/payments
  │                              POST .../approve or .../reject
  │                                         │
  │ ◄── APPROVED  → enrollment ACTIVE       │
  │     notifications + audit log           │
  │     course appears in "My Courses"      │
  │                                         │
  │ ◄── REJECTED (reason)  → notified,      │
  │     may submit a new payment            │
```

Bank details live in `platform_settings.bank_details` — the admin changes them
from the dashboard (`PUT /api/admin/settings/bank_details`), no code changes.

## 10. Certificates

- Issued automatically by the database trigger when **all published lessons**
  of a course are completed (`13/20 → 65%` … `20/20 → 100%`).
- Number format: `WDTH-YYYY-NNNNNN` (sequential per year).
- A branded PDF is generated on first view and stored in the **private**
  `certificates` bucket; students download via a signed URL.
- Public verification at `/api/public/verify-certificate/:identifier` returns
  only: validity, student name, course name, dates, certificate ID and
  `WOLI DAN TECH HUB`. No emails, phones or other private data.

## 11. Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | missing/invalid input (field list included) |
| `INVALID_FILE_TYPE` / `FILE_TOO_LARGE` | 400 | upload rejected |
| `RECEIPT_REQUIRED` / `INVALID_RECEIPT` | 400 | missing/corrupt receipt |
| `AMOUNT_MISMATCH` | 400 | paid amount ≠ course price |
| `MISSING_TOKEN` / `INVALID_TOKEN` / `INVALID_CREDENTIALS` | 401 | authentication problems |
| `FORBIDDEN` / `UNAUTHORIZED_ADMIN_ACTION` / `COURSE_ACCESS_DENIED` | 403 | authorization problems |
| `COURSE_NOT_FOUND` / `PAYMENT_NOT_FOUND` / … | 404 | not found |
| `EMAIL_TAKEN` / `ALREADY_ENROLLED` / `PAYMENT_ALREADY_PENDING` | 409 | conflicts |
| `DUPLICATE_TRANSACTION_REFERENCE` | 409 | reference already submitted |
| `PAYMENT_ALREADY_REVIEWED` | 409 | approve/reject ran twice |
| `RATE_LIMITED` | 429 | slow down |
| `INTERNAL_ERROR` | 500 | generic, sanitized server error |

## 12. Frontend integration

```js
const API = 'https://your-api.example.com/api';
let token = null; // access_token from login – keep in memory, not localStorage

async function api(path, { method = 'GET', body, formData } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData ? formData : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Request failed');
  return json.data;
}

// Register / login
await api('/auth/register', { method: 'POST', body: { full_name, email, phone, password } });
const { session } = await api('/auth/login', { method: 'POST', body: { email, password } });
token = session.access_token;

// Catalog + enrollment
const { courses } = await api('/courses');
await api('/enrollments', { method: 'POST', body: { course_id } }); // → bank details

// Submit payment with receipt
const fd = new FormData();
fd.append('course_id', courseId);
fd.append('transaction_reference', ref);
fd.append('transaction_date', '2026-09-10');
fd.append('receipt', fileInput.files[0]);
await api('/payments', { method: 'POST', formData: fd });

// My courses + progress
const { enrollments } = await api('/learning/my-courses');
await api(`/learning/lessons/${lessonId}/progress`, {
  method: 'POST',
  body: { completed: true, last_position: 245 },
});
```

The frontend must always trust the API/database for access decisions:
`has_access` / `enrollment_status` / progress come straight from PostgreSQL.

---

## 13. Deploying to Railway

The service ships with [`railway.json`](./railway.json) (Nixpacks build,
`npm start`, health check on `/health`, restart-on-failure capped at 10
attempts so a bad config stops spamming the log instead of looping forever).

### 13.1 The crash you will hit if variables are missing

```
Error: Missing required environment variable: SUPABASE_URL
```

That means the three Supabase variables were never set on the **service**.
Fix: Railway → your backend service → **Variables** → add:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret key (**server only**) |
| `FRONTEND_URL` | your deployed frontend origin, e.g. `https://hub.example.com` |
| `NODE_ENV` | `production` |

Railway redeploys on save. `PORT` is injected by Railway automatically — do
**not** hard-code it.

### 13.2 Common mistakes

- **Variables set on the wrong thing.** They must be on the *backend service*
  (or in Shared Variables), not only in the project settings or in a local
  `.env` — `.env` is git-ignored and is **never** uploaded to Railway.
- **Values pasted with quotes.** Use Railway's **Raw Editor**
  (`KEY=value`, one per line) or the form without surrounding quotes; quotes
  become part of the value. (The API now strips and warns about them.)
- **`.env.example` placeholders shipped to production** (`your-project-ref`,
  `your-anon-public-key`) — the API refuses to start and tells you which ones.
- **Anon key in `SUPABASE_SERVICE_ROLE_KEY`.** The server boots but every
  admin/payment/storage call fails on RLS. The key's JWT role is checked at
  startup and reported.
- **`FRONTEND_URL` left as `http://localhost:5173`.** The API starts, but the
  browser gets `CORS_BLOCKED`. Set it to the real frontend origin(s).
- **`npm warn config production`** in Railway's build log is harmless (it comes
  from Nixpacks' `--omit=dev` install).

### 13.3 Debugging a deployment

```bash
railway run npm run check:env   # masked config dump, exit 1 + report if broken
railway logs                    # startup report now lists every problem at once
curl https://<your-service>.up.railway.app/health
```

---

© WOLI DAN TECH HUB — LEARN • BUILD • GROW
