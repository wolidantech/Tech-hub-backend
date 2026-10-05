# Digital-school upgrade handoff

This branch contains the legacy LMS catalogue/JAMB/ID-card features plus a separate frontend-schema JAMB adapter and safe migration path. The legacy chain and the frontend add-on have both been exercised against disposable PostgreSQL fixtures. **No live Supabase connection, production migration, or deployment was run**; production `DATABASE_URL` and Supabase credentials are unavailable. **Production deployment is not complete:** `npm start` launches the AI gateway, while Express LMS routes are in the separate `src/app.js` app (`npm run start:lms`). The 19 frontend course offerings and JAMB pass are draft shells, not launch-ready learning content or a question bank. Do not publish them until course materials, price, syllabus and licensed question content have been reviewed.

## Database and deployment preflight

1. Back up the target and verify its migration history. The frontend project uses `categories`, `courses.published` with a text category, `enrollments.user_id` with lowercase statuses, `course_modules`/`course_lessons`, `manual_payments`, and `profiles.id`/`avatar_url`; it does not match this repository's legacy migration baseline.
2. **Never run the full `npm run migrate` chain on the frontend project.** It now stops on a schema mismatch, but the explicit live-compatible path is `npm run migrate:frontend`. That runner preflights migrations 001–011, then applies only `supabase/frontend-migrations/012_catalogue_expansion.sql` and the bundle-compatible JAMB engine in `20261005000017_jamb_cbt_engine.sql`. It does not apply legacy migrations 016 or 018.
3. The frontend migration 011 owns the live student-ID schema (`issue_student_id_card()` and its `student_id_cards` shape). Do **not** apply backend migration 018 there; it defines a conflicting table. Keep that migration for the legacy backend target only.
4. Run `npm run validate:sql`, `npm run test:db`, and `npm run test:jamb:frontend` before deployment. The last test applies the catalogue/JAMB migrations to a disposable frontend-schema fixture, including the `exam_access` payment gate.
5. On the API deployment set `JAMB_ACCESS_MODE=bundle` and `JAMB_ACCESS_BUNDLE_TITLE=JAMB CBT pass`; configure Supabase server-side variables securely. Set `REQUIRE_ADMIN_MFA=true` only after all administrators have enrolled and verified TOTP.
6. The frontend-compatible catalogue creates 19 unpublished course shells and one unpublished JAMB pass at NGN 5,000. Review pricing and add real, rights-cleared lessons/media before publishing. An exam cannot publish until every configured section has enough reviewed questions and its paid pass is published.

### Validation run (2026-10-05)

- `npm test` — passed (project syntax/assembly checks plus gateway, payments, AI content, CV, mobile, JAMB and student-ID suites).
- `npm run validate:sql` — parses both legacy migrations and `supabase/frontend-migrations`.
- `LD_LIBRARY_PATH="$PWD/node_modules/@embedded-postgres/linux-x64/native/lib" npm run test:db` — legacy migration chain applied to disposable PostgreSQL; all 91 database checks passed, including paid CBT access, server-side scoring, answer privacy and student-ID behavior.
- `LD_LIBRARY_PATH="$PWD/node_modules/@embedded-postgres/linux-x64/native/lib" npm run test:jamb:frontend` — all 15 checks passed against a disposable frontend-shaped PostgreSQL fixture, including runner preflight/idempotency, legacy-runner rejection, catalogue seeding, unpublished paid pass, mock publishing, payment enforcement and private question/answer data.
- `npm run test:jamb` — schema/contract checks and pure frontend template/result tests passed.
- `git diff --check` — passed.

The disposable tests validate the stated schemas and features, not the live frontend Supabase project. No live migration or deployment has occurred.

### Frontend/backend integration status

The backend adapter and a disposable frontend-schema test are now in place. The supported JAMB endpoints (paths relative to `/api`) are `GET /jamb/subjects`, `POST /jamb/attempts`, `POST /jamb/attempts/:attemptId/submit`, and `GET /jamb/attempts`. Start accepts `{ subject_ids, mode, question_count }`; it resolves a published template on the server and returns a timed paper with `expires_at` and option IDs/text only. Submit accepts `{ answers: [{ question_id, option_id }] }` and returns score/result metadata without correct-option IDs. An optional local-save endpoint remains available at `PUT /jamb/attempts/:attemptId/answers` with `{ answers: [{ attempt_item_id, option_id }] }`.

Configure the frontend's four API paths as `/jamb/subjects`, `/jamb/attempts`, `/jamb/attempts/:attemptId/submit`, and `/jamb/attempts` (the frontend API base should add `/api`). The backend runtime must use `JAMB_ACCESS_MODE=bundle` and `JAMB_ACCESS_BUNDLE_TITLE=JAMB CBT pass`. The server rechecks for an approved `manual_payments` record against a published `bundles.kind='exam_access'` product before issuing an attempt; the client purchase-page gate alone is not authorization. The seeded pass is deliberately unpublished until an administrator reviews its price and publishes it.

The server resolves a requested paper only when a published, reviewed template matches the selected subjects and question count; an absent or mismatched template returns `409 JAMB_PAPER_TEMPLATE_UNAVAILABLE` (not a missing-route 404). Before launch, administrators still need to configure/publish those templates, add reviewed questions, and ensure the pass bundle is published. Frontend follow-up: the current JAMB screen keeps history in browser storage and does not call its existing `fetchJambAttemptHistory()` helper; wire history to the API so it syncs across devices. The exam page currently saves active answers locally and submits them at the end; use the optional backend `PUT /jamb/attempts/:attemptId/answers` for server autosave or describe persistence as device-local. JAMB subject names and 2026 syllabus references are a starting catalogue, not a claim of complete/current official coverage; reconcile yearly subjects, topics and prescribed literature against the official JAMB IBASS. No past-paper text is seeded. Import only original questions or content for which redistribution rights have been documented and verified.

Frontend migration 011 is the canonical student-ID implementation for the frontend project: it uses `profiles.avatar_url`, `student_id_cards.user_id` and `issue_student_id_card()`. Do not apply backend migration 018 there; the legacy ID-card service/schema is separate. The frontend safe migration runner checks for migration-011 markers and applies only the new unpublished course catalogue and JAMB engine. The runner and full deployment are not yet validated against a live project because production database credentials are unavailable.

## Frontend handoff prompt

> Build the WOLI DAN TECH HUB digital-school frontend against this existing Express/Supabase backend. Keep every new course and CBT exam hidden unless its API status is `PUBLISHED`. Use only the Supabase anon key in browser code; never use the service-role key. Attach the signed-in Supabase access token as `Authorization: Bearer <access_token>` to protected `/api/*` requests.
>
> **Catalogue and learning:** render categories and course pages from the frontend Supabase schema. Migration `supabase/frontend-migrations/012_catalogue_expansion.sql` adds 19 unpublished Science & Laboratory, Art & Industrial Design, and Business/Commercial shells. These are not yet complete courses: do not publish them until administrators add reviewed lessons, real videos/PDFs, and rights-cleared learning materials. Do not invent media URLs. Keep new content hidden while `published=false`; render private course files only through the existing signed-resource flow.
>
> **Paid JAMB CBT:** use the backend API adapter (base path `/api`): subjects `GET /jamb/subjects`; start `POST /jamb/attempts` with `{ "subject_ids": ["<subject UUID>"], "mode": "practice", "question_count": 20 }` or the selected mock subjects/count; submit `POST /jamb/attempts/:attemptId/submit` with `{ "answers": [{ "question_id": "<attempt item UUID>", "option_id": "<option UUID>" }] }`; history `GET /jamb/attempts`. Set all four frontend build variables together:
>
> ```dotenv
> VITE_EXAM_API_SUBJECTS_PATH=/jamb/subjects
> VITE_EXAM_API_ATTEMPTS_PATH=/jamb/attempts
> VITE_EXAM_API_SUBMIT_PATH=/jamb/attempts/:attemptId/submit
> VITE_EXAM_API_HISTORY_PATH=/jamb/attempts
> ```
>
> Use only the server's `expires_at` for the countdown. The API resolves a matching published template and checks approved payment for the published `JAMB CBT pass` exam-access bundle; the browser gate is not authorization. Render only returned question/option text. Do not query question-bank or answer-key tables from the browser. Submission returns score and per-question verdicts/explanations, never correct-option IDs. Handle `409 JAMB_PAPER_TEMPLATE_UNAVAILABLE` as a content-not-ready state. Wire `fetchJambAttemptHistory()` to the history endpoint so attempts sync across devices. The current exam page saves active answers locally; if claiming server autosave, debounce `PUT /jamb/attempts/:attemptId/answers` with `{ "answers": [{ "attempt_item_id": "<question UUID>", "option_id": "<option UUID>" }] }`. Administrators must publish reviewed, licensed question content before launch.
>
> **Student ID:** frontend migration 011 is the schema owner. Add a required portrait upload to registration to meet the requested signup flow (the current registration form does not collect one). After Supabase Auth has established a signed-in session, upload the photo via the existing avatar-storage helper, update `profiles.avatar_url`, then call `issue_student_id_card()` through the signed-in Supabase client; the function requires `auth.uid()` and a stored photo. If email confirmation is enabled and signup returns no session, issue the card immediately after the user's first confirmed sign-in instead. Display the server-created card number/status and frontend card row; migration 011 records the photo reference and the UI renders the card, but it does not generate a downloadable PDF. Review the existing avatar bucket's public-read behavior and obtain clear photo-use consent before launch. Do not call legacy backend `/api/profiles/me/id-card` against this frontend schema or apply backend migration 018; it defines a conflicting table. Never expose service-role keys or make a separate ID-card storage bucket public.
>
> **Authentication:** support email/password plus Supabase passkeys and optional Google Authenticator enrollment. Passkeys can use Face ID/Touch ID, Windows Hello, a device PIN or a security key depending on the platform; biometric data stays with the device authenticator. For passkey login use Supabase Auth directly. Handle MFA `aal1`→`aal2` before entering protected admin features. Use mobile-first, accessible UI, loading/error/empty states, Nigerian naira formatting and server-authoritative attempt timers. Keep all question-answer keys and private card/video URLs out of logs and analytics.

## Admin CBT content workflow

All routes below require a verified admin profile (and, when `REQUIRE_ADMIN_MFA=true`, an `aal2` token):

- `GET/POST /api/admin/jamb/subjects`; `PATCH /api/admin/jamb/subjects/:subjectId` maintains the subject selector.
- `GET/POST /api/admin/jamb/syllabuses` creates year-versioned syllabus references/topics.
- `GET/POST /api/admin/jamb/exams`; `PATCH /api/admin/jamb/exams/:examId` manages templates and lifecycle status.
- `GET /api/admin/jamb/questions?status=DRAFT&page=1&limit=25`; `POST /api/admin/jamb/questions/import` accepts up to 100 JSON questions per batch, storing them as `DRAFT`.
- `PATCH /api/admin/jamb/questions/:questionId` reviews a question. Review transitions are `DRAFT → IN_REVIEW → APPROVED → PUBLISHED`; questions need four options, one correct answer, a matching syllabus version and verified reuse rights for licensed content. Content changes to a reviewed item send it back to `DRAFT`.
- Create exams with sections matching those subjects and question counts, then publish them only after every section has its required number of reviewed questions and the `JAMB CBT pass` exam-access bundle is published. In bundle mode, payment authorization is an approved row in `manual_payments` for that bundle.

No historical question bank, syllabus-topic corpus, video files or course PDFs were supplied or inserted. The import APIs and existing course-media pipeline are ready to receive reviewed assets; do not fill missing fields with invented paper text, fake media URLs or unverified licensing claims.

## Supabase Auth setup: passkeys / Face ID and Google Authenticator

### Passkeys (WebAuthn)

Supabase documents passkeys as experimental and requires `@supabase/supabase-js` 2.105.0 or later plus an explicit client opt-in. The backend dependency minimum has been raised to 2.105.0. Configure **Authentication → Passkeys** in the Supabase project:

- Enable passkey authentication.
- Set a stable RP display name such as `WOLI DAN TECH HUB`.
- Set RP ID to the production frontend's bare domain (no scheme, port or path).
- Set RP origins to the exact HTTPS production frontend origins (up to five). Add localhost only for local development. An RP-ID change invalidates existing passkeys.

Browser client setup (anon key only):

```js
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      experimental: { passkey: true },
    },
  }
);

// User must already be signed in with a confirmed account to register.
await supabase.auth.registerPasskey();

// Discoverable passkey sign-in; platform UI may offer face, fingerprint,
// device PIN, security key, or password-manager verification.
const { data, error } = await supabase.auth.signInWithPasskey();
if (error) throw error;
const accessToken = data.session.access_token;
```

Use WebAuthn only over HTTPS in production. The API accepts this Supabase session token through its existing bearer authentication middleware.

### TOTP / Google Authenticator

Supabase Auth TOTP works with Google Authenticator and other compatible authenticator apps. Enroll only after the user has signed in:

```js
const { data, error } = await supabase.auth.mfa.enroll({
  factorType: 'totp',
  friendlyName: 'Google Authenticator',
});
if (error) throw error;
// Display data.totp.qr_code as an image and let the user scan it.
// Treat data.totp.secret as a secret; never log it or send it to this API.

const challenge = await supabase.auth.mfa.challenge({ factorId: data.id });
if (challenge.error) throw challenge.error;
await supabase.auth.mfa.verify({
  factorId: data.id,
  challengeId: challenge.data.id,
  code: codeEnteredByUser,
});
```

After password/passkey sign-in, call `supabase.auth.mfa.getAuthenticatorAssuranceLevel()`. If `currentLevel === 'aal1'` and `nextLevel === 'aal2'`, list the user's TOTP factors, create a challenge, and verify the entered code before rendering protected application screens. The SDK refreshes the session after successful verification. Set `REQUIRE_ADMIN_MFA=true` on the API only after every administrator has enrolled TOTP; the admin middleware then rejects non-`aal2` tokens. Encourage users to store a secure backup factor because Supabase does not provide recovery codes.

Official references:

- [Supabase passkeys](https://supabase.com/docs/guides/auth/passkeys)
- [Supabase TOTP MFA](https://supabase.com/docs/guides/auth/auth-mfa/totp)
- [JAMB IBASS e-syllabus](https://ibass.jamb.gov.ng/e-syllabus)
