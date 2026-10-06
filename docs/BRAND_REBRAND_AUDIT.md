# DANQEL DIGITAL INSTITUTE — rebrand audit and implementation boundary

**Audit date:** 2026-10-06

**Working branch:** `arena/01a10cb1-tech-hub-backend`

**Frontend snapshot reviewed read-only:** `wolidantech/Tech-hub-frontend`, branch `arena/01a10cb6-tech-hub-frontend`, commit `16b602ee6072cf9ce3c1002541a64befe8723c67`

**Deployment status:** no production database migration or deployment has occurred. The frontend application and its assets have not been changed in this backend checkout.

## Identity to apply

- Institution and formal public issuer: **DANQEL DIGITAL INSTITUTE**
- Compact brand: **DANQEL**
- Learning assistant: **DANQEL AI**
- Official tagline: **Technology • Science • Digital Learning**

## Backend changes prepared

The backend has shared brand constants (`src/config/brand.js`) and uses the identity and official tagline in public root/health metadata, startup output, registration copy, assistant prompts and fallbacks, certificate output, course-seed defaults, and active developer documentation. New reusable vector artwork is in `assets/brand/danqel-digital-institute.svg` and `assets/brand/danqel-mark.svg`; the backend apps expose them at `/brand/logo.svg` and `/brand/mark.svg`. The certificate PDF embeds the full logo lockup and identifies **Olowoake Daniel Ayomide, Director**; only the institutional affiliation changes. Existing certificate IDs, verification codes, holder/course links, issue dates, validity, and revocation state are retained. The PDF brand marker is now version 2, so a legacy or earlier rebrand PDF regenerates in place with the new lockup on its normal authenticated download path.

Two additive database updates are prepared:

- `supabase/migrations/20261006000019_danqel_brand_identity.sql` updates the backend platform name/tagline and brand-owned seeded text, preserves the verification response shape, and updates future welcome/certificate behavior. It does not replace support/admin contacts, payment settings, beneficiary data, personal identities, or already-applied migration history.
- `supabase/frontend-migrations/014_danqel_brand_identity.sql` and `scripts/migrate-frontend.mjs` prepare a frontend-schema migration for settings and official tagline, issuer presentation, system notification copy, and the existing certificate/payment/coupon RPCs. It preserves the bank beneficiary, support/WhatsApp contacts, `dantech_enabled`, identifiers, and certificate state. The migration runner and its isolated integration fixture are included in the backend checkout; this is not a production application record.

## Frontend audit — changes still outstanding

The following locations were found in the reviewed frontend snapshot. They are an implementation checklist, not evidence that frontend files have been edited.

### Public identity, metadata, and assets

- `index.html`: browser title, description/keywords/author, Apple web-app title, Open Graph site/title, and Twitter title.
- `public/logo.svg`, `public/favicon.svg`, `public/manifest.webmanifest`, and raster icons `apple-touch-icon.png`, `favicon-32.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`: use the supplied-style DANQEL vector lockup (`assets/brand/danqel-digital-institute.svg`) and compact mark (`assets/brand/danqel-mark.svg`) for the wordmark/artwork and new tagline. Update manifest full and short names.
- `public/sw.js`: update the stale branding comment and bump the offline cache version so installed clients fetch the new shell/assets. Treat `wdth-v3` as a cache-version key, not user-facing identity; preserve the service-worker cache invalidation behavior.
- `src/components/layout/Navbar.jsx`, `src/components/layout/Footer.jsx`, `src/pages/Home.jsx`, `About.jsx`, `Contact.jsx`, and `AdminLogin.jsx`: visible wordmarks, page copy, admin label, and copyright.
- `src/components/common/SetupGate.jsx`, `src/pages/Register.jsx`, `Enroll.jsx`, and `StudentPortfolio.jsx`: setup, registration/legal affiliation, payment-pending institution copy, portfolio/certification text.
- `src/components/student/StudentIdCard.jsx`: institutional label on the student card.
- `src/pages/CareerHub.jsx`: career-hub title/student-work affiliation. `src/pages/CourseDetails.jsx` has a legacy institution fallback for a missing instructor; make the fallback institutional, but do not overwrite actual instructor data.
- `src/lib/store.js`: update `DEFAULT_SITE_SETTINGS.siteName`, `tagline`, and `metaDescription` fallbacks. Preserve `supportEmail`, WhatsApp number, `accountName`, bank/account values, and `dantechEnabled` unless verified replacements are provided.
- `src/lib/mfa.js`: the default authenticator-app issuer label is old; update the issuer shown when enrolling a new TOTP device. Existing enrolled authenticator secrets/labels are not migration targets.

### Assistant identity and product copy

- `src/lib/dantech.js`: change the exported display name and visible offline/error/log copy to **DANQEL AI**; update assistant-facing copy in `src/components/dantech/DanTechAI.jsx`, `src/pages/AIPage.jsx`, `CVBuilder.jsx`, `CareerHub.jsx`, `Home.jsx`, `Learn.jsx`, and `src/pages/admin/SiteSettingsPanel.jsx`.
- `src/pages/admin/StudentControl.jsx`: manually sent certificate notification copy still uses the old institution.
- Keep the deployed `/api/dantech/*` routes, `VITE_DANTECH_ENDPOINT`, `dantech_enabled`, technical component/module/error identifiers, and CSS classes. Change displayed identity, not these compatibility interfaces.
- `src/lib/backendHealth.js` includes the old name in the admin-copyable diagnostics report; update the report heading.
- A Home-page testimonial mentions the old assistant name. Review it as quoted/testimonial copy before changing the quote itself; preserve attribution and claim integrity.

### Certificates and generated/shareable output

- `src/pages/Certificates.jsx`, `CertificateView.jsx`, `VerifyCertificate.jsx`, `src/lib/certImage.js`, `src/components/student/StudentIdCard.jsx`, and the certificate-ready text in `src/pages/Learn.jsx` contain visible old issuer/affiliation text, seal text, image alt text, or share/download titles and filenames. Change institutional presentation and issuer fallbacks to DANQEL DIGITAL INSTITUTE, and use the official tagline; use DANQEL where a compact mark fits.
- Preserve the named signer **Olowoake Daniel Ayomide** and title **Director**. Update only the institutional affiliation beside the signature. Do not substitute an institutional office such as “Registrar.”
- Retain `WDTH-...` certificate/student identifiers, verification codes, QR/verification URLs, validity/revocation, and holder/course/date fields. Update frontend certificate tests and filename expectations without changing those identifiers.

### Content, defaults, and existing identities

- `src/data/curriculum/ai-video-content-creation.js` contains a pronunciation example that names the former brand. Review and update that active course example; do not mechanically replace unrelated course prose.
- `src/lib/ids.js` defaults newly generated coupon codes to a `WOLI` prefix. Change the default for *newly generated* codes to the DANQEL prefix, while leaving already-issued codes such as `WOLI100` valid and unchanged.
- Values such as `Woli Dan`, `Woli Dan Tech Team`, and other instructor fields occur in `src/data/courses.js`, `src/data/catalog.js`, admin course defaults, and generated AI-course defaults. These are personal/team attribution data, not automatically institution display copy; retain them until the instructor roster is verified. Likewise preserve personal support copy unless the owner confirms a replacement.
- `src/pages/admin/PaymentsManager.jsx`, `src/pages/Enroll.jsx`, and `src/lib/store.js` show the existing bank beneficiary/account name **LUNA ENTRY SERVICES- WOLI DAN TECH HUB**. This is operational financial data, not a branding field; do not edit it without verified replacement account instructions. Keep current contact email addresses and WhatsApp number for the same reason.

### Tests and external configuration

- Update relevant frontend test fixtures/assertions in `src/tests/certificate.test.jsx`, `certificate-image.test.jsx`, `classroom.test.jsx`, `dantech-gateway.test.js`, and `mobile.test.jsx` for new visible copy/assets, while preserving technical IDs/routes/cache assertions and course-person identities.
- No checked-in frontend authentication email templates were found. Supabase Auth email templates may be configured in the external project dashboard and should be audited separately before sending rebranded messages.

## Legacy matches that should remain, with reasons

A repository-wide text search is not an appropriate completion criterion by itself. Classify remaining occurrences before changing them. In the backend checkout, residual old-name matches are confined to replacement predicates and test fixtures, the archived legacy guide and one-off live-project SQL, and the operational beneficiary name in seed configuration. Other old-looking matches are:

- `src/config/env.js`, `.env.example`, `scripts/create-admin.js`, and admin test fixtures: existing administrator/support identity and email; retain until verified replacement.
- `supabase/seed/seed_12_courses.sql`, frontend migration fixtures, and the archived guide: existing MONIEPOINT account number/beneficiary; retain unchanged as financial data.
- `supabase/migrations/20260910000001`–`20261005000018`, the old manual `supabase/seed/apply_migration_014.sql`, and old live-project repair scripts: historical migration or repair records; do not rewrite applied history or reuse blindly.
- `WOLI100` in payment migration/docs/tests: an existing coupon code, not institutional copy; keep redeemable. `WOLI_DAN_TAXONOMY` is a stored taxonomy provenance key; keep stable.
- `/api/dantech/*`, `VITE_DANTECH_ENDPOINT`, `dantech_enabled`, `WDTH-...`, and frontend repository references in active docs/comments: deployed routes, configuration/database/API contracts, ID formats, or repository paths; preserve for compatibility.
- Old production domains in diagnostic/repair material and the repository's GitHub organization path are deployment/ownership references, not display copy; verify replacements before editing.

### Frontend snapshot findings by classification

- **Compatibility identifiers:** `/api/dantech/*`, `VITE_DANTECH_ENDPOINT`, `dantech_enabled`, `wdth.*` local/session-storage and event keys, `WDTH` identifier formats, the frontend/backend repository names, and the service-worker cache namespace/version. Keep deployed interfaces stable; bump the cache version only to invalidate cached assets.
- **Existing commercial/operational data:** active `WOLI100` coupon code, bank beneficiary/account data, support/admin email addresses, phone/WhatsApp number, and the old live-site/repository URLs in deployment or diagnostic instructions. Preserve until verified replacements are supplied.
- **People and authored content:** the certificate signer/director, instructor/team names, personal support contacts, user-authored/testimonial copy, and third-party course/resource text. Do not treat a person's name as a brand string.
- **Historical/audit material:** already-applied migration files, the archived legacy backend guide, old one-off live-project repair scripts, migration tests that deliberately seed old values, and migration predicates that search for the exact old name in order to replace it. Keep historical evidence and test the intended upgrade path.
- **Implementation identifiers:** filenames/component names, CSS class names, API error types, test-only fixtures, and comments that document a compatibility contract. Update only where they are presented to users or cause a genuine product-name leak.

## Local validation (isolated only)

- `npm test`: backend syntax/assembly check plus gateway, payments, AI content, CV, mobile, JAMB validation, and ID-card suites passed.
- `npm run test:db`: **94 checks passed**, including additive backend migration 019 and retained certificate identifiers/state.
- `npm run test:seed`: **36 checks passed** against an isolated PostgreSQL database; exported seed parts still reproduce the full SQL export and remain idempotent.
- `npm run test:jamb:frontend`: **21 checks passed** against the isolated frontend-shaped schema, including migration 014, coupon phone matching, and its issuer/notification/RPC behavior.
- `npm run test:certificate`: passed, checking rendered PDF text for the new issuer/tagline, preserved named director, and unchanged IDs/codes.
- `npm run validate:sql`: all **21** backend/frontend migration files parsed cleanly.
- No frontend application tests/build were run because this backend checkout contains only a read-only snapshot for the frontend audit, not the frontend working tree.

## Change boundary and deployment notes

Only targeted runtime/content changes and additive migrations are in scope. No production data has been changed, and no live migration, frontend build, or deployment is claimed. Do not apply either migration to production until the target schema, backup/rollback procedure, and maintenance window are confirmed. Frontend implementation and its tests/build remain a separate-repository task; this backend branch contains the read-only audit, backend implementation, and migration/test preparation only.
