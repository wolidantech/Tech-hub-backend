# WOLI DAN TECH HUB — Supabase Seed & Fix Scripts

These three SQL files fix the `[FAIL] Course catalog` and `[WARN] Admin account`
diagnostics that students were seeing on https://wolidantechhub.netlify.app

## Why students saw diagnostics

The frontend has a **backend diagnostics** panel that runs live checks against
`https://vlfgnuxacprjeauqyvig.supabase.co` using the anon publishable key:

- It checks `courses` table via REST: `GET /rest/v1/courses?select=*&is_published=eq.true`
- RLS policy `courses_public_read` only exposes rows where `is_published = true`
- If the table is empty **or every row is `is_published = false`**, the anon key sees 0 rows
- The diagnostics component then shows `[FAIL] Course catalog — The courses table is EMPTY...`
- It also shows admin setup instructions (`make_admin.sql`) — which should **never** be visible to students

**Root cause:** The seed file `seed_12_courses.sql` deliberately inserts courses as **drafts**
(`is_published = false`) so admins can review them. If you run only that file and forget
`publish_courses.sql`, the storefront stays empty and every visitor (including students)
triggers the diagnostic panel.

## Fix — run in Supabase SQL Editor (in order)

1. **Seed drafts (if table is empty)**
   ```sql
   -- Copy/paste content of supabase/seed/seed_12_courses.sql
   -- This creates categories + 12 courses at ₦5,000 each as drafts
   ```

2. **Publish (makes them visible to students)**
   ```sql
   -- Copy/paste content of supabase/seed/publish_courses.sql
   -- UPDATE courses SET is_published = true
   ```

3. **Make first admin**
   ```sql
   -- First register normally on the site with your email
   -- Then in SQL Editor:
   -- Copy/paste supabase/seed/make_admin.sql
   -- Edit the email to your admin email and run
   ```

4. **Verify**
   ```sql
   select count(*) as total, count(*) filter (where is_published) as published from courses;
   -- Should be: total=12, published=12

   select email, role from profiles where role='admin';
   -- Should show your admin email
   ```

   Then test as anon (no auth) via API:
   ```
   https://vlfgnuxacprjeauqyvig.supabase.co/rest/v1/courses?select=title,is_published&is_published=eq.true
   Header: apikey: <your anon publishable key>
   ```
   Should return 12 rows.

## Automatic fix via migrations

If you use `npm run migrate` (which applies `supabase/migrations/*.sql` via DATABASE_URL),
migration `20260910000006_fix_empty_catalog.sql` does all of the above automatically:

- Backfills platform_settings and categories if missing
- Seeds 12 courses if table empty
- **Publishes all drafts** (`is_published=false` → `true`)

Run:
```bash
npm run migrate
```

## Preventing diagnostics from showing to students (frontend fix required)

The diagnostics panel should be **admin-only**. In the frontend repo (`wolidantech/Tech-hub-frontend`):

```jsx
// BAD — shows to everyone when catalog empty
if (courses.length === 0) return <BackendDiagnostics />

// GOOD — only admins or dev mode
if (courses.length === 0) {
  if (profile?.role === 'admin' || import.meta.env.DEV) {
    return <BackendDiagnostics />
  }
  return <EmptyCatalogMessage /> // friendly "No courses yet, check back soon"
}
```

And `BackendDiagnostics` itself should fetch `/api/admin/diagnostics` (admin-only)
instead of running Supabase checks directly with the anon key.

Until frontend is fixed, the fastest way to stop students seeing diagnostics is
to **ensure the catalog is not empty** (run publish_courses.sql).

## Related backend changes in this repo

- `supabase/migrations/20260910000006_fix_empty_catalog.sql` — auto-publishes drafts
- `supabase/seed/` — the three files mentioned in the diagnostic's `fix:` hint
- `src/controllers/catalog.controller.js` — already correctly filters `is_published=true`
  using anon client, so students only see published courses (no code change needed)
