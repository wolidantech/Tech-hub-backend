/**
 * Verifies the SQL-Editor path for production seeding:
 *   1. parts reassemble to the full export (minus part headers)
 *   2. migrations 001-015 + parts apply cleanly on real PostgreSQL
 *   3. seeded counts match expectations; re-applying changes nothing
 *   4. an enrolled student can read the full chain (RLS); unenrolled cannot
 *
 * Usage: node scripts/verify-seed-sql.mjs
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { countSeeded } from './seed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const FULL_SQL = join(ROOT, 'supabase', 'seed', 'science_courses.sql');
const PARTS = [1, 2, 3, 4].map((i) => join(ROOT, 'supabase', 'seed', `science_courses_part${i}.sql`));
const DATA_DIR = join(ROOT, '.tmp-pg-verify');

let passed = 0;
function ok(name, cond = true) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const SUPABASE_STUB_SQL = `
create schema if not exists auth;
create schema if not exists storage;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create or replace function auth.uid()
returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to anon, authenticated, service_role;
create table if not exists storage.buckets (
  id text primary key, name text, public boolean default false, owner uuid,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text)
returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name,'/'),1)-1]
$$;
grant usage on schema storage to anon, authenticated, service_role;
grant all on all tables in schema storage to authenticated, service_role;
grant all on storage.buckets to postgres;
grant all on storage.objects to postgres;
grant all on auth.users to postgres;
`;

async function asUser(client, authUserId, sql, params = []) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query(`set local request.jwt.claims = '${JSON.stringify({ sub: authUserId, role: 'authenticated' })}'`);
    const r = await client.query(sql, params);
    await client.query('commit');
    return r;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  }
}

async function main() {
  console.log('\n[1/4] Parts reassemble to the full export...');
  const full = readFileSync(FULL_SQL, 'utf8');
  const reassembled = PARTS.map((p) => readFileSync(p, 'utf8').replace(/^-- Part \d+ of \d+.*\n/, '')).join('');
  ok('part1+part2+part3+part4 == science_courses.sql', reassembled.trimEnd() === full.trimEnd());

  console.log('\n[2/4] Booting PostgreSQL, applying migrations 001-015 + seed parts...');
  rmSync(DATA_DIR, { recursive: true, force: true });
  const ep = new EmbeddedPostgres({
    databaseDir: DATA_DIR, user: 'postgres', password: 'postgres', port: 5501, persistent: false,
  });
  await ep.initialise();
  await ep.start();
  await ep.createDatabase('wdth');
  const client = new pg.Client({
    host: '127.0.0.1', port: 5501, user: 'postgres', password: 'postgres', database: 'wdth',
  });
  await client.connect();
  try {
    await client.query(SUPABASE_STUB_SQL);
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    ok('all migrations applied (incl. 015 seed_key/metadata)', true);
    for (const [i, p] of PARTS.entries()) {
      await client.query(readFileSync(p, 'utf8'));
      console.log(`  ✓ applied science_courses_part${i + 1}.sql`);
      passed += 1;
    }

    console.log('\n[3/4] Seeded counts + idempotency...');
    const c1 = await countSeeded(client, 'biology');
    console.log('  counts:', JSON.stringify(c1));
    ok('12 modules seeded', c1.modules === 12);
    ok('29 topics seeded', c1.topics === 29);
    ok('56 lessons seeded', c1.lessons === 56);
    ok('questions seeded (166)', c1.questions === 166);
    ok('13 assessments (12 module + final)', c1.assessments === 13);
    ok('course published', c1.published === true);
    const { rows: [fin] } = await client.query(
      `select count(*)::int as n from quiz_questions q
       join quizzes z on z.id = q.quiz_id where z.seed_key = 'biology:final-exam:quiz'`
    );
    ok('final exam has 30 questions', fin.n === 30);
    // Re-apply everything: counts must be identical (idempotent).
    for (const p of PARTS) await client.query(readFileSync(p, 'utf8'));
    const c2 = await countSeeded(client, 'biology');
    ok('re-apply changes nothing (idempotent)', JSON.stringify(c1) === JSON.stringify(c2));

    console.log('\n[4/4] Enrolled student reads full chain (RLS), unenrolled reads nothing...');
    const { rows: [sAuth] } = await client.query(
      `insert into auth.users (email, raw_user_meta_data) values ('bio-student@example.com', '{"full_name":"Bio Student"}') returning id`
    );
    const { rows: [student] } = await client.query(`select * from profiles where user_id = $1`, [sAuth.id]);
    const { rows: [course] } = await client.query(`select * from courses where slug = 'biology'`);
    await client.query(
      `insert into enrollments (student_id, course_id, status) values ($1, $2, 'ACTIVE')`,
      [student.id, course.id]
    );
    const { rows: [oAuth] } = await client.query(`insert into auth.users (email) values ('outsider@example.com') returning id`);
    // [table, label, expectedEnrolledCount|null(>0), enrollmentGated?]
    // Gating truth table (existing RLS, verified by reading 003/010/014):
    // - lessons + lesson_contents + assessments: enrolled/instructor/admin only
    // - modules/topics: public on published courses (even anon)
    // - resources/videos/practicals/assignments/quizzes: any logged-in user
    //   once live (status/is_approved). Videos are public YouTube embeds, so
    //   status-gating (not enrollment-gating) is the intended design.
    const chain = [
      ['course_modules', 'modules', 12, false],
      ['course_topics', 'topics', 29, false],
      ['lessons', 'lessons', 56, true],
      ['lesson_contents', 'contents', null, true],
      ['course_resources', 'resources', null, false],
      ['lesson_videos', 'videos', null, false],
      ['lesson_practicals', 'practicals', 12, false],
      ['assignments', 'assignments', 12, false],
      ['quizzes', 'quizzes', null, false],
      ['course_assessments', 'assessments', 13, true],
    ];
    for (const [table, label, expected, gated] of chain) {
      const r = await asUser(client, sAuth.id, `select count(*)::int as n from ${table} where course_id = $1`, [course.id]);
      ok(`enrolled reads ${label} (${r.rows[0].n})`, expected === null ? r.rows[0].n > 0 : r.rows[0].n === expected);
      const r2 = await asUser(client, oAuth.id, `select count(*)::int as n from ${table} where course_id = $1`, [course.id]);
      if (gated) ok(`unenrolled reads 0 ${label}`, r2.rows[0].n === 0);
      else ok(`unenrolled/authenticated sees live ${label}`, r2.rows[0].n > 0);
    }
    // Student quiz RPC strips answers.
    const { rows: [quiz] } = await client.query(`select id from quizzes where seed_key = 'biology:mod01:quiz'`);
    const rq = await asUser(client, sAuth.id, `select * from get_quiz_for_student($1)`, [quiz.id]);
    ok('get_quiz_for_student works for enrolled', rq.rows.length === 1);
    ok('answers stripped from student quiz', !JSON.stringify(rq.rows[0]).includes('"is_correct":true'));

    console.log(`\nAll ${passed} seed-SQL verification checks passed.`);
  } finally {
    await client.end();
    await ep.stop();
  }
}

main().catch((err) => {
  console.error('\nVERIFY FAILED:', err.message);
  if (process.env.SEED_DEBUG) console.error(err);
  process.exit(1);
});
