# Biology seed — Supabase SQL Editor paste order

Paste each file's **entire contents** into a **new query** in the Supabase
dashboard SQL Editor (SQL → New query → paste → Run), **in this order**.
Wait for each step to finish ("Success") before pasting the next.

> Do NOT run these with `npm` — the SQL Editor accepts only SQL.

| Step | File | Paste size | What it does | Expected result |
|------|------|-----------|--------------|-----------------|
| 0 | `precheck_014.sql` | ~1 KB | Read-only check: 014 tables exist? 015 applied? | 13 rows "present"; 015 "not applied" (first run) |
| 0.5 | `apply_migration_014.sql` | ~100 KB | **Only if Step 0 showed MISSING tables.** Creates the 014 curriculum tables; backfills `lessons` from legacy `course_lessons` table (same IDs, source untouched) | Success; `curriculum_tables_present = 8`. Notices about skipped orphan rows are informational |
| 1 | `apply_migration_015.sql` | ~7 KB | Adds `seed_key` + `metadata` columns, unique indexes, `_migrations` bookkeeping | Success; `seed_key_columns_added = 12` |
| 2 | `science_courses_part1.sql` | ~360 KB | Biology seed part 1 of 4 (course, modules 1–3…) | Success, no errors |
| 3 | `science_courses_part2.sql` | ~300 KB | Biology seed part 2 of 4 | Success, no errors |
| 4 | `science_courses_part3.sql` | ~360 KB | Biology seed part 3 of 4 | Success, no errors |
| 5 | `science_courses_part4.sql` | ~230 KB | Biology seed part 4 of 4 | Success, no errors |
| 6 | `verify_biology.sql` | ~2 KB | Confirms complete seed | 6 rows, all status `OK` |

**Everything is idempotent.** Re-running any step refreshes rows in place —
nothing is ever duplicated (upserts keyed on `seed_key` / `slug`).

## If something fails

1. Note which **step** failed and copy the **exact error message**.
2. Do NOT skip the failed step and continue — later parts depend on earlier ones.
3. Paste the step number + error back for help.

## Verification already performed (repo)

- `node scripts/verify-seed-sql.mjs` — **36/36 checks green**: parts reassemble
  byte-identical to the full export; migrations 001–015 + all 4 parts apply on
  real PostgreSQL; counts 12 modules / 29 topics / 56 lessons / 166 questions /
  13 assessments / published; re-apply duplicates nothing (idempotent);
  enrolled student reads the full chain through RLS while unenrolled users
  read nothing and answer keys stay hidden.
- Full paste sequence (Steps 0–6 above) replayed end-to-end on real
  PostgreSQL — green, all 6 verify rows `OK`.
