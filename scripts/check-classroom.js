#!/usr/bin/env node
/**
 * WOLI DAN TECH HUB — Classroom chain tracer.
 *
 * Traces the exact path a student takes and reports where it breaks:
 *
 *   Course listing → Course details → Outline → Classroom →
 *   Modules → Topics → Lessons → Contents → Quizzes/Assignments
 *
 * Public hops use the ANON key (what students see). Gated hops use the
 * SERVICE ROLE key (what the backend can assemble). A divergence between
 * the two pinpoints RLS/flag/join bugs instead of guessing.
 *
 * Usage: node scripts/check-classroom.js [course-slug-or-id]
 * Requires SUPABASE_URL + SUPABASE_ANON_KEY (+ SUPABASE_SERVICE_ROLE_KEY
 * for gated hops) in env or .env.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const envPath = join(root, '.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const courseArg = process.argv[2];

if (!url || !anonKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY (set in .env or env vars).');
  process.exit(1);
}

const results = [];
function report(hop, status, detail) {
  results.push({ hop, status, detail });
  const icon = status === 'PASS' ? '✓' : status === 'WARN' ? '!' : '✗';
  console.log(`  [${icon}] ${hop}: ${detail}`);
}

async function rest(path, key, { admin = false } = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, rows: Array.isArray(body) ? body : null };
}

console.log(`\nTracing classroom chain at ${url}\n`);

let courseId = null;
let courseSlug = null;

// ---- 1. Course listing (anon) ----
{
  const { status, rows, body } = await rest(
    'courses?select=id,title,slug,is_published&is_published=eq.true&limit=5',
    anonKey
  );
  if (status === 200 && rows && rows.length > 0) {
    report('Course listing (anon)', 'PASS', `${rows.length}+ published course(s); e.g. "${rows[0].title}"`);
    courseId = courseArg && /^[0-9a-f-]{36}$/i.test(courseArg) ? courseArg : rows[0].id;
    courseSlug = courseArg && !/^[0-9a-f-]{36}$/i.test(courseArg) ? courseArg : rows[0].slug;
  } else if (status === 200) {
    report('Course listing (anon)', 'FAIL', '0 published courses visible. Run publish_courses.sql / npm run migrate.');
  } else {
    report('Course listing (anon)', 'FAIL', `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
}

// ---- 2. Course details (anon) ----
if (courseSlug || courseId) {
  const filter = courseSlug && !/^[0-9a-f-]{36}$/i.test(courseArg || '')
    ? `slug=eq.${courseSlug}`
    : `id=eq.${courseId}`;
  const { status, rows, body } = await rest(`courses?select=*,course_categories(id,name)&${filter}`, anonKey);
  if (status === 200 && rows && rows.length > 0) {
    const c = rows[0];
    courseId = c.id;
    courseSlug = c.slug;
    const flags = `is_published=${c.is_published} published=${c.published} archived=${c.archived}`;
    report('Course details (anon)', 'PASS', `"${c.title}" (${flags})`);
    if (c.is_published === false && c.published === true) {
      report('Flag sync', 'WARN', 'published=true but is_published=false — run migration 014 to normalise flags.');
    }
  } else if (status === 200) {
    report('Course details (anon)', 'FAIL', 'Course hidden from anon — check is_published/published flags + RLS.');
  } else {
    report('Course details (anon)', 'FAIL', `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
}

if (!courseId) {
  console.log('\nCannot continue without a visible course. Fix listing/details first.\n');
  process.exit(1);
}

// ---- 3. Modules (anon outline vs service truth) ----
let moduleIds = [];
{
  const anon = await rest(`course_modules?select=id,title,order_number&course_id=eq.${courseId}&order=order_number`, anonKey);
  if (anon.status === 200 && anon.rows && anon.rows.length > 0) {
    moduleIds = anon.rows.map((m) => m.id);
    report('Modules outline (anon)', 'PASS', `${moduleIds.length} module(s) visible pre-enrollment.`);
  } else if (anon.status === 200) {
    report('Modules outline (anon)', 'WARN', '0 modules visible to anon (empty curriculum? or RLS flag mismatch?).');
  } else {
    report('Modules outline (anon)', 'FAIL', `HTTP ${anon.status}: ${JSON.stringify(anon.body).slice(0, 200)}`);
  }
  if (serviceKey) {
    const svc = await rest(`course_modules?select=id,title&course_id=eq.${courseId}`, serviceKey);
    if (svc.status === 200 && svc.rows) {
      moduleIds = svc.rows.map((m) => m.id);
      if (svc.rows.length > 0 && (anon.rows || []).length === 0) {
        report('Modules RLS gap', 'FAIL', `${svc.rows.length} module(s) exist but anon sees 0 — published-flag/RLS mismatch. Run migration 014.`);
      } else {
        report('Modules truth (service)', 'PASS', `${svc.rows.length} module(s) in database.`);
      }
    }
  }
}

// ---- 4. Topics ----
if (serviceKey) {
  const svc = await rest(`course_topics?select=id,title,module_id&course_id=eq.${courseId}`, serviceKey);
  if (svc.status === 200 && svc.rows) {
    report(
      'Topics (service)',
      svc.rows.length > 0 ? 'PASS' : 'WARN',
      svc.rows.length > 0 ? `${svc.rows.length} topic(s).` : '0 topics — lessons attach directly to modules (legacy layout, still supported).'
    );
  } else if (svc.status === 404 || JSON.stringify(svc.body).includes('schema cache')) {
    report('Topics (service)', 'WARN', 'course_topics table missing — run migration 014 for the topic layer.');
  } else {
    report('Topics (service)', 'FAIL', `HTTP ${svc.status}: ${JSON.stringify(svc.body).slice(0, 200)}`);
  }
}

// ---- 5. Lessons (anon should see 0 pre-enrollment; service must see rows) ----
{
  const anon = moduleIds.length
    ? await rest(`lessons?select=id,title&module_id=in.(${moduleIds.join(',')})&limit=5`, anonKey)
    : { status: 200, rows: [] };
  if (anon.status === 200 && (anon.rows || []).length === 0) {
    report('Lessons gate (anon)', 'PASS', '0 lesson rows pre-enrollment (correct — content is gated).');
  } else if (anon.status === 200) {
    report('Lessons gate (anon)', 'WARN', `${anon.rows.length} lesson(s) visible pre-enrollment — check is_free_preview / RLS.`);
  } else {
    report('Lessons gate (anon)', 'FAIL', `HTTP ${anon.status}`);
  }

  if (serviceKey && moduleIds.length) {
    const svc = await rest(
      `lessons?select=id,title,is_published,topic_id&module_id=in.(${moduleIds.join(',')})&limit=100`,
      serviceKey
    );
    if (svc.status === 200 && svc.rows) {
      const pub = svc.rows.filter((l) => l.is_published).length;
      report(
        'Lessons truth (service)',
        pub > 0 ? 'PASS' : 'FAIL',
        `${svc.rows.length} lesson(s), ${pub} published.`
      );
      if (svc.rows.length > 0 && pub === 0) {
        report('Publish state', 'FAIL', 'Lessons exist but ALL are drafts — POST /api/admin/courses/:slug/publish.');
      }
      if (svc.rows.length === 0) {
        report('Publish state', 'FAIL', 'Modules exist but contain NO lessons — build curriculum via /api/admin.');
      }
    }
  } else if (serviceKey && !moduleIds.length) {
    report('Lessons truth (service)', 'FAIL', 'No modules — nothing can hold lessons. Build curriculum via /api/admin.');
  }
}

// ---- 6. Contents / quizzes / assignments / assessments ----
if (serviceKey) {
  const checks = [
    { name: 'lesson_contents', path: `lesson_contents?select=id&course_id=eq.${courseId}&limit=1` },
    { name: 'quizzes (live)', path: `quizzes?select=id&course_id=eq.${courseId}&status=in.(APPROVED,PUBLISHED)&limit=1` },
    { name: 'assignments (live)', path: `assignments?select=id&course_id=eq.${courseId}&status=in.(APPROVED,PUBLISHED)&limit=1` },
    { name: 'course_assessments (live)', path: `course_assessments?select=id&course_id=eq.${courseId}&status=in.(APPROVED,PUBLISHED)&limit=1` },
  ];
  for (const c of checks) {
    const r = await rest(c.path, serviceKey);
    if (r.status === 200 && r.rows) {
      report(c.name, r.rows.length > 0 ? 'PASS' : 'WARN', r.rows.length > 0 ? 'present.' : 'none yet (optional layer).');
    } else if (r.status === 404 || JSON.stringify(r.body).includes('schema cache')) {
      report(c.name, 'WARN', 'table missing — run npm run migrate.');
    } else {
      report(c.name, 'FAIL', `HTTP ${r.status}`);
    }
  }
}

// ---- 7. Compat views ----
if (serviceKey) {
  for (const view of ['course_lessons', 'lesson_resources', 'student_progress']) {
    const r = await rest(`${view}?select=id&limit=1`, serviceKey);
    report(
      `Compat view ${view}`,
      r.status === 200 ? 'PASS' : 'WARN',
      r.status === 200 ? 'available.' : `unavailable (HTTP ${r.status}) — run migration 014.`
    );
  }
}

// ---- Summary ----
const fails = results.filter((r) => r.status === 'FAIL').length;
const warns = results.filter((r) => r.status === 'WARN').length;
console.log(`\nResult: ${fails} failure(s), ${warns} warning(s).`);
if (fails > 0) {
  console.log('Next step: apply the fix printed on each [✗] line above, then re-run.\n');
  process.exit(2);
}
console.log('Classroom chain is healthy.\n');
