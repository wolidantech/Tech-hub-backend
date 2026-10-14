/**
 * Functional test of the lecturer workflow migration (015) against a REAL
 * PostgreSQL (embedded), with the frontend/live schema loaded from the
 * upstream frontend migrations 001-011 (pinned snapshot) + local 012 + 014,
 * exactly like production. Exercises RLS, course scoping and the full
 * draft → review → publish / grade-release flows, including XP/certificate
 * timing.
 *
 * Usage: node scripts/test-frontend-lecturer-schema.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'node_modules/@embedded-postgres/linux-x64/native/lib');
if (existsSync(LIB) && !(process.env.LD_LIBRARY_PATH || '').includes(LIB)) {
  process.env.LD_LIBRARY_PATH = `${LIB}${delimiter}${process.env.LD_LIBRARY_PATH || ''}`;
}
const { default: EmbeddedPostgres } = await import('embedded-postgres');
const { default: pg } = await import('pg');

const DATA_DIR = join(ROOT, '.tmp-pg-frontend-lecturer');
const PORT = 5502;
const DATA_URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/frontend_lms`;
const FIXTURES_DIR = join(ROOT, 'scripts/fixtures/frontend');

let passed = 0;
function ok(name, cond = true) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
async function expectError(fn, fragment, name) {
  try {
    await fn();
  } catch (error) {
    assert.ok(String(error.message).includes(fragment), `${name} — wrong error: ${error.message}`);
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  assert.fail(`${name} — expected error "${fragment}"`);
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
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key, name text, public boolean default false,
  owner uuid, file_size_limit bigint, allowed_mime_types text[],
  created_at timestamptz default now()
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

grant all on all tables in schema storage to authenticated, service_role;
grant all on auth.users to postgres;

-- Supabase cloud applies these defaults in every public project; without
-- them the frontend migrations would leave tables inaccessible to the
-- browser roles this test needs to exercise.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema storage grant all on tables to authenticated, service_role;
`;

async function asUser(client, authUserId, sql, params = []) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query(`set local request.jwt.claims = '${JSON.stringify({ sub: authUserId, role: 'authenticated' })}'`);
    const result = await client.query(sql, params);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

function runLecturerMigrationRunner() {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/migrate-frontend-lecturer.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: DATA_URL, DATABASE_SSL: 'disable' },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const postgres = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('frontend_lms');
  await postgres.createDatabase('not_lms'); // empty — the migration-runner guard target
  const client = new pg.Client({
    host: '127.0.0.1',
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    database: 'frontend_lms',
  });
  await client.connect();

  let admin; let instructor; let outsider; let student;
  let course1; let course2; let module1; let lesson1; let quiz1; let assignment1; let submission1;

  try {
    console.log('\n[1/9] Loading the real frontend schema (001-011 snapshot + 012 + 014)...');
    await client.query(SUPABASE_STUB_SQL);
    for (const file of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
      console.log(`  ✓ applied snapshot ${file}`);
    }
    for (const file of ['012_catalogue_expansion.sql', '014_danqel_brand_identity.sql']) {
      await client.query(readFileSync(join(ROOT, 'supabase/frontend-migrations', file), 'utf8'));
      console.log(`  ✓ applied local ${file}`);
    }
    // The remaining runner steps (their tracking table is required by the
    // lecturer runner's preflight) — applied through the real runner too.
    await client.query(`
      create table if not exists public._techhub_frontend_feature_migrations (
        name text primary key, executed_at timestamptz not null default now()
      );
      alter table public._techhub_frontend_feature_migrations enable row level security;
    `);

    console.log('\n[2/9] Migration 015 applies through its runner, idempotently...');
    const first = runLecturerMigrationRunner();
    ok('lecturer runner applies migration 015',
      first.status === 0 && first.output.includes('applying frontend-015_lecturer_workflow.sql')
        && first.output.includes('✓ frontend-015_lecturer_workflow.sql'));
    const second = runLecturerMigrationRunner();
    ok('a second run is a safe no-op', second.status === 0 && second.output.includes('already applied'));
    const { rows: helpers } = await client.query(
      `select to_regprocedure('public.is_instructor()') is not null as i,
              to_regprocedure('public.teaches(uuid)') is not null as t,
              to_regclass('public.lecturer_course_assignments') is not null as a,
              to_regclass('public.lecturer_content_revisions') is not null as c,
              to_regclass('public.lecturer_grade_reviews') is not null as g`
    );
    ok('helpers and moderation tables exist',
      helpers[0].i && helpers[0].t && helpers[0].a && helpers[0].c && helpers[0].g);
    const { rows: columns } = await client.query(
      `select count(*)::int as n from information_schema.columns
       where table_schema='public' and table_name='course_lessons'
         and column_name in ('status','archived','created_by','approved_revision_id')`
    );
    ok('live lesson rows carry draft/publish columns', columns[0].n === 4);

    console.log('\n[3/9] Fixtures: admin, lecturers, student, course content...');
    ({ rows: [admin] } = await client.query(
      `insert into auth.users (email, raw_user_meta_data) values ('admin@danqel.test', '{"full_name":"Site Admin"}') returning id`));
    ({ rows: [instructor] } = await client.query(
      `insert into auth.users (email, raw_user_meta_data) values ('lee@danqel.test', '{"full_name":"Lee Lecturer"}') returning id`));
    ({ rows: [outsider] } = await client.query(
      `insert into auth.users (email, raw_user_meta_data) values ('out@danqel.test', '{"full_name":"Outsider Lecturer"}') returning id`));
    ({ rows: [student] } = await client.query(
      `insert into auth.users (email, raw_user_meta_data) values ('ada@danqel.test', '{"full_name":"Ada Student"}') returning id`));
    await client.query(
      `update profiles set role = case
         when id = $1 then 'admin'
         when id in ($2, $3) then 'instructor'
         else 'student' end
       where id in ($1, $2, $3, $4)`,
      [admin.id, instructor.id, outsider.id, student.id]);

    ({ rows: [course1] } = await client.query(
      `insert into courses (slug, title, category, price, published) values ('web-dev', 'Web Development', 'Web Development', 5000, true) returning id, title`));
    ({ rows: [course2] } = await client.query(
      `insert into courses (slug, title, category, price, published) values ('secret-course', 'Secret Course', 'General', 5000, false) returning id, title`));
    ({ rows: [module1] } = await client.query(
      `insert into course_modules (course_id, title, position) values ($1, 'Module 1', 0) returning id, title`, [course1.id]));
    ({ rows: [lesson1] } = await client.query(
      `insert into course_lessons (module_id, course_id, title, type, position, description) values ($1, $2, 'Welcome', 'text', 0, 'intro') returning id`, [module1.id, course1.id]));
    await client.query(`insert into course_content (lesson_id, body_markdown) values ($1, '# Welcome')`, [lesson1.id]);
    ({ rows: [quiz1] } = await client.query(
      `insert into quizzes (course_id, module_id, title, passing_score, status) values ($1, $2, 'Starter quiz', 70, 'published') returning id`, [course1.id, module1.id]));
    await client.query(
      `insert into quiz_questions (quiz_id, type, question, options, correct_answer) values ($1, 'multiple_choice', '2+2?', '["3","4"]'::jsonb, 1)`,
      [quiz1.id]);
    ({ rows: [assignment1] } = await client.query(
      `insert into assignments (course_id, module_id, title, description, max_score, status) values ($1, $2, 'Build a page', 'desc', 100, 'published') returning id`, [course1.id, module1.id]));
    await client.query(`insert into enrollments (user_id, course_id, status) values ($1, $2, 'active')`, [student.id, course1.id]);
    // Completion requires an approved assignment, so the certificate can only
    // appear when an admin releases the lecturer's grade. The rule must exist
    // before the lesson completion trigger evaluates.
    await client.query(
      `insert into course_completion_rules (course_id, require_lessons_pct, require_assignments_approved)
       values ($1, 100, 1)`, [course1.id]);
    await client.query(`insert into lesson_progress (user_id, course_id, lesson_id) values ($1, $2, $3)`, [student.id, course1.id, lesson1.id]);
    {
      const { rows: earlyCerts } = await client.query(
        `select count(*)::int as n from certificate_issues where user_id = $1 and course_id = $2`, [student.id, course1.id]);
      ok('no certificate before the assignment requirement is met', earlyCerts[0].n === 0);
    }
    ({ rows: [submission1] } = await client.query(
      `insert into assignment_submissions (assignment_id, course_id, user_id, kind, link_url, status)
       values ($1, $2, $3, 'link', 'https://example.com/work', 'submitted') returning id`, [assignment1.id, course1.id, student.id]));
    ok('fixtures ready', true);

    console.log('\n[4/9] Admin assigns the course; access is scoped...');
    {
      const { rows: [result] } = await asUser(
        client, admin.id,
        `select public.admin_upsert_lecturer_assignment($1, $2) as value`,
        [instructor.id, course1.id]
      );
      ok('admin assigns course to lecturer', !!result.value.id && result.value.courseId === course1.id);
    }
    {
      const { rows } = await asUser(client, instructor.id, `select public.teaches($1) as value`, [course1.id]);
      ok('teaches() true for assigned course', rows[0].value === true);
      const out = await asUser(client, outsider.id, `select public.teaches($1) as value`, [course1.id]);
      ok('teaches() false for other lecturers', out.rows[0].value === false);
      const own = await asUser(client, instructor.id, `select lecturer_id from lecturer_course_assignments`);
      ok('lecturer reads only their own assignments', own.rows.length === 1 && own.rows[0].lecturer_id === instructor.id);
    }
    {
      const { rows } = await asUser(client, instructor.id, `select id, title from courses where id = $1`, [course2.id]);
      ok('lecturer cannot see an unassigned unpublished course', rows.length === 0);
      const visible = await asUser(client, instructor.id, `select id from courses where id = $1`, [course1.id]);
      ok('lecturer sees their assigned course', visible.rows.length === 1);
      const questions = await asUser(client, instructor.id, `select correct_answer from quiz_questions where quiz_id = $1`, [quiz1.id]);
      ok('lecturer can review quiz answers for an assigned course', questions.rows.length === 1 && questions.rows[0].correct_answer === 1);
      {
        // RLS hides the answer table entirely (no student-facing policy).
        const blocked = await asUser(client, student.id, `select correct_answer from quiz_questions where quiz_id = $1`, [quiz1.id]);
        ok('students cannot read quiz answer keys directly', blocked.rows.length === 0);
      }
      const studentsInCourse = await asUser(
        client, instructor.id,
        `select full_name from profiles where id = $1`, [student.id]
      );
      ok('lecturer reads enrolled student profiles for marking', studentsInCourse.rows.length === 1);
      const stranger = await asUser(client, outsider.id, `select full_name from profiles where id = $1`, [student.id]);
      ok('unassigned lecturers cannot read those students', stranger.rows.length === 0);
    }

    console.log('\n[5/9] Module: draft → review → admin publish');
    let revisionId;
    {
      const { rows: [result] } = await asUser(
        client, instructor.id,
        `select public.lecturer_save_content_draft(null, 'module_create', $1, null, null, null, 'Module 2: React', '{"title":"Module 2: React"}'::jsonb) as value`,
        [course1.id]
      );
      ok('lecturer saves a private draft', result.value.status === 'draft');
      revisionId = result.value.id;
    }
    {
      const { rows } = await asUser(client, student.id, `select title from course_modules where course_id = $1`, [course1.id]);
      ok('students cannot see the draft module', !rows.some((r) => r.title === 'Module 2: React'));
      const update = await asUser(client, instructor.id, `update course_modules set title = 'hijacked' where id = $1`, [module1.id]);
      ok('lecturer cannot update live content directly (RLS rows: 0)', update.rowCount === 0);
      await expectError(
        () => asUser(client, student.id,
          `insert into lecturer_content_revisions (kind, course_id, lecturer_id, title, payload, status)
           values ('module_create', $1, $2, 'x', '{}'::jsonb, 'draft')`,
          [course1.id, student.id]),
        'row-level security',
        'students cannot create lecturer drafts'
      );
    }
    {
      const { rows: [result] } = await asUser(
        client, instructor.id,
        `select public.lecturer_submit_content_for_review($1) as value`,
        [revisionId]
      );
      ok('lecturer submits the draft for review', result.value.status === 'pending_approval');
      await expectError(
        () => asUser(client, instructor.id,
          `select public.lecturer_submit_content_for_review($1) as value`, [revisionId]),
        'Only drafts or requested changes',
        'resubmission without admin feedback is refused'
      );
    }
    {
      const pending = await asUser(client, instructor.id, `select status from lecturer_content_revisions where id = $1`, [revisionId]);
      ok('lecturer tracks their own review state', pending.rows[0].status === 'pending_approval');
      const hidden = await asUser(client, student.id, `select count(*)::int as n from lecturer_content_revisions`);
      ok('students cannot read the moderation table', hidden.rows[0].n === 0);
    }
    {
      const { rows: [result] } = await asUser(
        client, admin.id,
        `select public.admin_review_content_approval($1, 'approved', '') as value`,
        [revisionId]
      );
      ok('admin approves and the module is published', result.value.targetTable === 'course_modules' && !!result.value.targetId);
      const { rows } = await asUser(client, student.id, `select title, status, created_by from course_modules where course_id = $1`, [course1.id]);
      const live = rows.find((r) => r.title === 'Module 2: React');
      ok('the module is now visible to students', !!live && live.status === 'published' && live.created_by === instructor.id);
      const { rows: audits } = await client.query(
        `select action, details from audit_logs where entity_id = $1`, [revisionId]);
      ok('approval wrote an audit record',
        audits.length === 1 && audits[0].action === 'lecturer_content.approved'
          && audits[0].details.lecturerId === instructor.id);
      const { rows: notes } = await client.query(
        `select type, title from student_notifications where user_id = $1 order by created_at`, [instructor.id]);
      ok('lecturer was notified of assignment and approval',
        notes.some((n) => n.type === 'lecturer_assignment') && notes.some((n) => n.type === 'content_approved'));
      await expectError(
        () => asUser(client, admin.id, `select public.admin_review_content_approval($1, 'approved', '') as value`, [revisionId]),
        'already been reviewed',
        'a reviewed item cannot be approved twice'
      );
    }

    console.log('\n[6/9] Grades are proposed by lecturers, released by admins');
    let gradeId;
    {
      const { rows: [result] } = await asUser(
        client, instructor.id,
        `select public.lecturer_submit_grade_for_review($1, null, null, 'approved', 95, 'Great work') as value`,
        [submission1.id]
      );
      ok('lecturer proposes a grade', result.value.status === 'pending_approval' && result.value.version === 1);
      gradeId = result.value.id;
      const { rows } = await asUser(client, student.id,
        `select status, score from assignment_submissions where id = $1`, [submission1.id]);
      ok('pending grades never touch the student view', rows[0].status === 'submitted' && rows[0].score === null);
      const { rows: certs } = await client.query(
        `select count(*)::int as n from certificate_issues where user_id = $1 and course_id = $2`, [student.id, course1.id]);
      ok('no certificate is issued while the grade is pending', certs[0].n === 0);
    }
    {
      await expectError(
        () => asUser(client, instructor.id,
          `select public.lecturer_submit_grade_for_review($1, null, null, 'approved', null, '') as value`, [submission1.id]),
        'A score is required',
        'approving without a score is refused'
      );
      const { rows: [rejected] } = await asUser(
        client, admin.id,
        `select public.admin_review_grade_approval($1, 'rejected', 'Fantastic — but please use whole marks') as value`,
        [gradeId]
      );
      ok('admin can reject a grade without releasing it', rejected.value.released === false);
      const { rows } = await asUser(client, student.id,
        `select status, score from assignment_submissions where id = $1`, [submission1.id]);
      ok('rejection keeps the student view untouched', rows[0].status === 'submitted' && rows[0].score === null);
    }
    {
      const { rows: [resubmitted] } = await asUser(
        client, instructor.id,
        `select public.lecturer_submit_grade_for_review($1, null, null, 'approved', 90, 'Strong structure, neat layout') as value`,
        [submission1.id]
      );
      ok('lecturer resubmits after rejection (version bumps)',
        resubmitted.value.status === 'pending_approval' && resubmitted.value.version === 2);
      const { rows: [released] } = await asUser(
        client, admin.id,
        `select public.admin_review_grade_approval($1, 'approved', '') as value`,
        [gradeId]
      );
      ok('admin releases the resubmitted grade', released.value.released === true);
      const { rows } = await asUser(client, student.id,
        `select status, score, feedback, reviewed_by from assignment_submissions where id = $1`, [submission1.id]);
      ok('the released grade reaches the student exactly as reviewed',
        rows[0].status === 'approved' && rows[0].score === 90
          && rows[0].feedback === 'Strong structure, neat layout'
          && rows[0].reviewed_by === 'admin@danqel.test');
    }
    {
      const { rows: xp } = await client.query(
        `select rule, xp from xp_events where user_id = $1 and rule = 'assignment_approved'`, [student.id]);
      ok('XP is awarded only at release time', xp.length === 1 && xp[0].xp === 30);
      const { rows: certs } = await client.query(
        `select status, course_name from certificate_issues where user_id = $1 and course_id = $2`, [student.id, course1.id]);
      ok('certificate eligibility is evaluated at release (course already complete)',
        certs.length === 1 && certs[0].status === 'valid');
      const { rows: notes } = await client.query(
        `select type from student_notifications where user_id = $1`, [student.id]);
      ok('student was notified of the released grade', notes.some((n) => n.type === 'grade_released'));
    }
    {
      await expectError(
        () => asUser(client, outsider.id,
          `select public.lecturer_submit_grade_for_review($1, null, null, 'approved', 10, '') as value`, [submission1.id]),
        'not assigned',
        'other lecturers cannot grade this course'
      );
      await expectError(
        () => asUser(client, student.id,
          `select public.lecturer_submit_grade_for_review($1, null, null, 'approved', 100, '') as value`, [submission1.id]),
        'Lecturers only',
        'students cannot use the grading RPC'
      );
    }

    console.log('\n[7/9] Lesson + quiz flows; answer keys stay protected');
    {
      const { rows: [module2] } = await client.query(
        `select id from course_modules where course_id = $1 and title = 'Module 2: React'`, [course1.id]);
      const { rows: [draft] } = await asUser(
        client, instructor.id,
        `select public.lecturer_save_content_draft(null, 'lesson_create', $1, $2, null, null, 'JSX deep dive',
          '{"type":"text","description":"d","content":"# JSX","resources":[{"label":"Docs","url":"https://example.com"}]}'::jsonb) as value`,
        [course1.id, module2.id]
      );
      const { rows: [submitted] } = await asUser(client, instructor.id,
        `select public.lecturer_submit_content_for_review($1) as value`, [draft.value.id]);
      ok('lesson drafted and submitted', submitted.value.status === 'pending_approval');
      const { rows: [approved] } = await asUser(client, admin.id,
        `select public.admin_review_content_approval($1, 'approved', '') as value`, [draft.value.id]);
      ok('admin publishes the lesson', approved.value.targetTable === 'course_lessons');
      const { rows: contents } = await asUser(
        client, student.id,
        `select c.body_markdown from course_content c join course_lessons l on l.id = c.lesson_id where l.id = $1`,
        [approved.value.targetId]
      );
      ok('enrolled students read the published lesson body', contents.length === 1 && contents[0].body_markdown === '# JSX');
      await expectError(
        () => asUser(client, instructor.id,
          `select public.lecturer_save_content_draft(null, 'lesson_create', $1, $2, null, null, 'bad', '{}'::jsonb) as value`,
          [course2.id, module2.id]),
        'not assigned',
        'unassigned courses refuse new drafts at the database layer'
      );
    }
    {
      const { rows: [draft] } = await asUser(
        client, instructor.id,
        `select public.lecturer_save_content_draft(null, 'quiz_create', $1, $2, null, null, 'Hooks quiz',
          '{"passing_score":80,"allow_retake":false,"questions":[
             {"type":"multiple_choice","question":"useState returns?","options":["value+setter","node"],"correct_answer":0,"explanation":"tuple"},
             {"type":"short_answer","question":"setter name?","accepted_answers":["setter","setState"]}
           ]}'::jsonb) as value`,
        [course1.id, module1.id]
      );
      await asUser(client, instructor.id, `select public.lecturer_submit_content_for_review($1) as value`, [draft.value.id]);
      const { rows: [approved] } = await asUser(client, admin.id,
        `select public.admin_review_content_approval($1, 'approved', '') as value`, [draft.value.id]);
      ok('admin publishes the quiz', approved.value.targetTable === 'quizzes');
      const liveQuizId = approved.value.targetId;

      const { rows: [qsStudent] } = await asUser(client, student.id,
        `select public.get_quiz_questions($1) as value`, [liveQuizId]);
      ok('students get questions WITHOUT answers',
        qsStudent.value.length === 2
          && !Object.keys(qsStudent.value[0]).join(',').includes('correct')
          && !Object.keys(qsStudent.value[1]).join(',').includes('accepted'));
      await expectError(
        () => asUser(client, student.id, `select public.get_quiz_review($1) as value`, [liveQuizId]),
        'Attempt the quiz first',
        'students cannot reveal answers before attempting'
      );
      const { rows: [qsInstructor] } = await asUser(client, instructor.id,
        `select public.get_quiz_review($1) as value`, [liveQuizId]);
      ok('the assigned lecturer can review the answer key',
        qsInstructor.value.length === 2
          && qsInstructor.value.some((q) => q.correctAnswer === 0)
          && qsInstructor.value.some((q) => Array.isArray(q.acceptedAnswers) && q.acceptedAnswers.includes('setter')));
      await expectError(
        () => asUser(client, outsider.id, `select public.get_quiz_review($1) as value`, [liveQuizId]),
        'Attempt the quiz first',
        'unassigned lecturers cannot see another course\'s answers'
      );
    }

    console.log('\n[8/9] Removals are moderated and revoking access is immediate');
    {
      const { rows: [module2] } = await client.query(
        `select id from course_modules where course_id = $1 and title = 'Module 2: React'`, [course1.id]);
      const { rows: [draft] } = await asUser(
        client, instructor.id,
        `select public.lecturer_save_content_draft(null, 'module_remove', $1, null, null, $2, 'Remove Module 2', '{}'::jsonb) as value`,
        [course1.id, module2.id]
      );
      await asUser(client, instructor.id, `select public.lecturer_submit_content_for_review($1) as value`, [draft.value.id]);
      await asUser(client, admin.id,
        `select public.admin_review_content_approval($1, 'approved', '') as value`, [draft.value.id]);
      const { rows } = await asUser(client, student.id,
        `select title from course_modules where course_id = $1 and archived = false`, [course1.id]);
      ok('removal hides the module from students only after approval', !rows.some((r) => r.title === 'Module 2: React'));
    }
    {
      const { rows: [removed] } = await asUser(
        client, admin.id,
        `select public.admin_remove_lecturer_assignment($1, $2) as value`,
        [instructor.id, course1.id]
      );
      ok('admin revokes the course assignment', removed.value.removed === 1);
      await expectError(
        () => asUser(client, instructor.id,
          `select public.lecturer_save_content_draft(null, 'module_create', $1, null, null, null, 'late module', '{}'::jsonb) as value`,
          [course1.id]),
        'not assigned',
        'a revoked lecturer cannot draft any more'
      );
      const { rows: auditRows } = await client.query(
        `select action from audit_logs where action like 'lecturer.%' order by created_at`);
      ok('assignment lifecycle is audited', auditRows.some((r) => r.action === 'lecturer.assign_course') && auditRows.some((r) => r.action === 'lecturer.remove_course'));
    }

    console.log('\n[9/9] Migration guards');
    {
      const bad = spawnSync(process.execPath, [join(ROOT, 'scripts/migrate-frontend-lecturer.mjs')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PORT}/not_lms`, DATABASE_SSL: 'disable' },
      });
      const guardOutput = `${bad.stdout || ''}\n${bad.stderr || ''}`;
      ok('runner refuses a database without the frontend LMS schema',
        bad.status !== 0 && guardOutput.includes('Schema preflight failed'));
    }

    console.log(`\n✓ frontend lecturer schema workflow: ${passed} checks passed`);
  } finally {
    await client.end();
    await postgres.stop();
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\nFrontend lecturer schema test failed:', error);
  process.exit(1);
});
