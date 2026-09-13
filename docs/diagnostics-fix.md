# Why students saw backend diagnostics — and how we fixed it

**Reported:** 2026-09-13  
Origin: https://wolidantechhub.netlify.app  
Backend: https://vlfgnuxacprjeauqyvig.supabase.co

```
[FAIL] Course catalog
       The courses table is EMPTY, or every row is hidden from this key.
       Row-level security only exposes courses where published = true,
       so a visitor sees nothing.
[WARN] Admin account
       The signup trigger always creates accounts with role = student...
```

## Root cause

1. **Catalog empty for anon key**
   - RLS policy `courses_public_read` only allows `is_published = true`
   - Seed script `seed_12_courses.sql` (as described in diagnostics) inserts 12 courses as **drafts** (`is_published=false`)
   - If `publish_courses.sql` is never run, `GET /rest/v1/courses?is_published=eq.true` returns 0 rows for anon
   - Frontend code detected 0 courses and rendered the full `BackendDiagnostics` panel

2. **Diagnostics shown to students**
   - The diagnostics panel was rendered for **all users** when `courses.length === 0`
   - It contains admin setup instructions (`make_admin.sql`, `seed_*.sql`) that should be admin-only
   - Students should see a friendly empty state, not internal setup steps

3. **No admin account**
   - `handle_new_user()` trigger always creates `role='student'`
   - Without running `make_admin.sql`, no one can access `/admin/login` to publish courses

## Backend fixes (this repo)

### 1. Added `supabase/seed/` files expected by diagnostics

- `supabase/seed/seed_12_courses.sql` — 12 courses as drafts (idempotent)
- `supabase/seed/publish_courses.sql` — `UPDATE courses SET is_published=true`
- `supabase/seed/make_admin.sql` — promote a registered email to admin
- `supabase/seed/README.md` — step-by-step fix guide

### 2. Added migration `20260910000006_fix_empty_catalog.sql`

Auto-fixes live DB:
- Backfills `platform_settings` + `course_categories` if missing
- Seeds 12 courses if empty
- **Publishes all drafts** — the critical fix for `[FAIL] Course catalog`

Run via:
```bash
npm run migrate
# or manually in Supabase SQL Editor: paste the migration file
```

### 3. Added admin-only diagnostics endpoint

`GET /api/admin/diagnostics` (requires `profiles.role='admin'`)

Returns:
```json
{
  "catalog": { "status": "PASS|FAIL_EMPTY|FAIL_DRAFTS_ONLY", "total": 12, "published": 12, "fix": "..." },
  "admin": { "status": "PASS|FAIL_NO_ADMIN", "total_admins": 1, "fix": "..." }
}
```

Frontend should call this **only for admins** instead of running Supabase checks with anon key.

### 4. Added student-safe catalog status endpoint

`GET /api/catalog-status` — public, no auth, no admin hints

```json
{
  "has_published_courses": true,
  "total_published": 12,
  "message": "12 courses available"
}
```

Use this to show friendly empty state to students.

### 5. Added `scripts/check-catalog.js`

```bash
SUPABASE_URL=https://xxx.supabase.co SUPABASE_ANON_KEY=ey... npm run check:catalog
```

Checks what anon key sees — reproduces the diagnostic locally.

## Frontend fix required (separate repo `wolidantech/Tech-hub-frontend`)

The backend fix stops the symptom (catalog empty), but frontend should also gate diagnostics:

```jsx
// src/components/BackendDiagnostics.jsx or wherever it lives

// BEFORE (bad — shows to everyone)
if (courses.length === 0) return <BackendDiagnostics />

// AFTER (good — admin only)
function CatalogPage() {
  const { profile } = useAuth()
  const { data: courses } = useCourses()

  if (courses?.length === 0) {
    // Only admins or dev mode see full diagnostics
    if (profile?.role === 'admin' || import.meta.env.DEV) {
      return <BackendDiagnostics />
    }
    // Students see friendly empty state
    return (
      <div className="empty-catalog">
        <h2>No courses available yet</h2>
        <p>We're preparing new courses. Check back soon or contact support.</p>
      </div>
    )
  }
  return <CourseGrid courses={courses} />
}
```

Also replace direct Supabase anon checks with admin-only backend call:

```js
// Instead of fetching /rest/v1/courses with anon key in frontend,
// call admin diagnostics endpoint (which is already role-gated)
const res = await fetch(`${VITE_API_URL}/api/admin/diagnostics`, {
  headers: { Authorization: `Bearer ${session.access_token}` }
})
```

## Immediate action for live site

1. Open Supabase Dashboard → SQL Editor for project `vlfgnuxacprjeauqyvig`
2. Run `supabase/seed/publish_courses.sql` — this alone fixes student view
   - Verify: `select count(*) from courses where is_published=true` → should be 12
3. Register your admin email on https://wolidantechhub.netlify.app if not already
4. Run `supabase/seed/make_admin.sql` with your email edited
5. Deploy this backend repo (migration 06 auto-publishes if you use `npm run migrate`)
6. In frontend repo, gate `BackendDiagnostics` behind `role==='admin'`

After step 2, students will no longer see diagnostics — they'll see 12 courses.

## How to verify fix

```bash
# As anon (what students see)
curl -s "https://vlfgnuxacprjeauqyvig.supabase.co/rest/v1/courses?select=title&is_published=eq.true" \
  -H "apikey: <anon_key>" -H "Authorization: Bearer <anon_key>" | jq length
# Should be 12, not 0

# Backend catalog-status (student-safe)
curl https://your-backend.up.railway.app/api/catalog-status
# { "has_published_courses": true, "total_published": 12 }

# Admin diagnostics (admin token required)
curl https://your-backend.up.railway.app/api/admin/diagnostics \
  -H "Authorization: Bearer <admin_access_token>" | jq
```
