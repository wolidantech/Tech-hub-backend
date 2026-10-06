/**
 * Exercises the frontend migration runner and bundle-compatible JAMB engine
 * against a disposable frontend-schema fixture (including migration-011
 * markers). Separate from test-db.mjs, which validates the legacy LMS.
 *
 * Usage:
 *   LD_LIBRARY_PATH="$PWD/node_modules/@embedded-postgres/linux-x64/native/lib" \
 *     node scripts/test-jamb-frontend-schema.mjs
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, '.tmp-pg-frontend-jamb');
const DATA_URL = 'postgresql://postgres:postgres@127.0.0.1:5500/wdth_frontend';
let passed = 0;

function runFrontendMigrationRunner() {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/migrate-frontend.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: DATA_URL, DATABASE_SSL: 'disable' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Frontend migration runner failed:\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function runLegacyMigrationGuard() {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/migrate.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: DATA_URL, DATABASE_SSL: 'disable' },
  });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  return { status: result.status, output };
}

function ok(name, condition = true) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function expectError(fn, fragment, name) {
  try {
    await fn();
  } catch (error) {
    assert.ok(String(error.message).includes(fragment), `${name}: ${error.message}`);
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  assert.fail(`${name}: expected ${fragment}`);
}

const FRONTEND_SCHEMA_FIXTURE = `
create schema if not exists auth;
create schema if not exists storage;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to anon, authenticated, service_role;

-- The relevant public tables match frontend migrations 001-011.
create table public.profiles (
  id uuid primary key,
  full_name text not null,
  email text not null,
  phone text,
  role text not null default 'student',
  avatar_url text,
  created_at timestamptz not null default now()
);
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  sort_order integer default 0,
  created_at timestamptz default now()
);
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  short_description text,
  description text,
  category text not null default 'General',
  duration text,
  level text default 'Beginner',
  price integer not null default 5000,
  original_price integer default 10000,
  published boolean default false,
  featured boolean default false,
  created_at timestamptz default now()
);
create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  course_id uuid not null references public.courses(id),
  status text default 'active',
  method text,
  coupon_code text,
  unique (user_id, course_id)
);
create table public.bundles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text default '',
  course_ids uuid[] not null default '{}',
  price numeric not null default 0,
  original_price numeric not null default 0,
  badge text default '',
  is_published boolean default false,
  kind text not null default 'courses' check (kind in ('courses', 'exam_access')),
  created_at timestamptz default now()
);
create table public.manual_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  course_id uuid references public.courses(id),
  bundle_id uuid references public.bundles(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected'))
);
create table public.student_id_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id),
  card_number text not null unique,
  full_name text not null,
  photo_path text not null,
  programme text not null default 'Digital Skills',
  issued_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at timestamptz
);
create table public.site_settings (
  id int primary key default 1,
  site_name text,
  tagline text,
  whatsapp text,
  support_email text,
  bank_name text,
  account_number text,
  account_name text,
  dantech_enabled boolean,
  allow_registration boolean,
  socials jsonb,
  meta_description text,
  updated_at timestamptz
);
create table public.certificate_issues (
  id uuid primary key default gen_random_uuid(),
  certificate_id text unique not null,
  verification_code text unique not null,
  user_id uuid not null,
  student_name text,
  course_id uuid not null,
  course_name text,
  status text default 'valid',
  issued_by text,
  issue_date timestamptz default now(),
  revoked_at timestamptz
);
create table public.student_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  type text,
  title text not null,
  message text not null,
  course_id uuid,
  read boolean default false,
  created_at timestamptz default now()
);
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text, active boolean, expires_at timestamptz, course_id uuid,
  max_uses integer, restricted_user_id uuid, restricted_email text,
  restricted_phone text, min_purchase integer, discount_type text,
  discount_value numeric, used_count integer default 0
);
create table public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id),
  coupon_code text not null,
  user_id uuid not null references public.profiles(id),
  course_id uuid not null references public.courses(id),
  discount integer not null,
  amount_due integer not null,
  created_at timestamptz default now()
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_email text,
  actor_name text,
  action text not null,
  entity_type text,
  entity_id text,
  details jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;
`;

async function asUser(client, id, sql, params = []) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query(`set local request.jwt.claim.sub = '${id}'`);
    const result = await client.query(sql, params);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const postgres = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: 5500,
    persistent: false,
  });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('wdth_frontend');
  const client = new pg.Client({
    host: '127.0.0.1', port: 5500, user: 'postgres', password: 'postgres', database: 'wdth_frontend',
  });
  await client.connect();

  try {
    await client.query(FRONTEND_SCHEMA_FIXTURE);
    await client.query(`
      insert into site_settings
        (id, site_name, tagline, whatsapp, support_email, bank_name, account_number,
         account_name, dantech_enabled, allow_registration, socials, meta_description)
      values
        (1, 'WOLI DAN TECH HUB', 'Learn • Build • Grow', '08150000000',
         'wolidantech@gmail.com', 'MONIEPOINT', '00000000000',
         'LUNA ENTRY SERVICES- WOLI DAN TECH HUB', true, true, '{}'::jsonb,
         'Welcome to WOLI DAN TECH HUB');
      insert into certificate_issues
        (certificate_id, verification_code, user_id, student_name, course_id, course_name,
         status, issued_by, issue_date, revoked_at)
      values
        ('WDTH-2026-ABC123', 'WDTH-ABCD-1234', '11111111-1111-4111-8111-111111111111',
         'Ada Student', '22222222-2222-4222-8222-222222222222', 'Digital Skills',
         'valid', 'WOLI DAN TECH HUB', '2026-01-02T03:04:05Z', null);
      insert into student_notifications (user_id, type, title, message, read, created_at)
      values
        ('11111111-1111-4111-8111-111111111111', 'payment_approved', 'Payment approved',
         'WOLI DAN TECH HUB approved your payment. Learn • Build • Grow', false, '2026-02-03T04:05:06Z');
    `);
    const runnerOutput = runFrontendMigrationRunner();
    ok('frontend migration runner preflights the schema and applies catalogue, JAMB and brand migrations',
      runnerOutput.includes('Frontend schema preflight passed.')
        && runnerOutput.includes('frontend-012_catalogue_expansion.sql')
        && runnerOutput.includes('frontend-013_jamb_cbt_engine.sql')
        && runnerOutput.includes('frontend-014_danqel_brand_identity.sql'));
    const rerunOutput = runFrontendMigrationRunner();
    ok('frontend migration runner safely skips migrations already recorded',
      rerunOutput.includes('frontend-012_catalogue_expansion.sql already applied')
        && rerunOutput.includes('frontend-013_jamb_cbt_engine.sql already applied')
        && rerunOutput.includes('frontend-014_danqel_brand_identity.sql already applied'));
    const legacyGuard = runLegacyMigrationGuard();
    ok('legacy migration runner refuses the frontend-shaped schema before applying SQL',
      legacyGuard.status !== 0 && legacyGuard.output.includes('No SQL was applied'));
    const { rows: [legacyTracking] } = await client.query(
      `select to_regclass('public._migrations') is not null as created`
    );
    ok('legacy migration guard does not create its migration table on the frontend schema',
      legacyTracking.created === false);

    const { rows: [catalogue] } = await client.query(
      `select count(*) filter (where published = false)::int as drafts,
              count(distinct category)::int as categories from courses`
    );
    ok('frontend catalogue migration creates 19 unpublished offerings across three categories',
      catalogue.drafts === 19 && catalogue.categories === 3);
    const { rows: [draftPass] } = await client.query(
      `select id, kind, is_published from bundles where lower(title)='jamb cbt pass'`
    );
    ok('JAMB access bundle is seeded but not for sale',
      draftPass.kind === 'exam_access' && draftPass.is_published === false);

    ok('JAMB migration applies after frontend schema + migration 011');

    const { rows: [siteSettings] } = await client.query(`select * from site_settings where id=1`);
    ok('brand migration updates the institution and tagline while preserving operational settings',
      siteSettings.site_name === 'DANQEL DIGITAL INSTITUTE'
        && siteSettings.tagline === 'Technology • Science • Digital Learning'
        && siteSettings.meta_description === 'Welcome to DANQEL DIGITAL INSTITUTE'
        && siteSettings.support_email === 'wolidantech@gmail.com'
        && siteSettings.account_name === 'LUNA ENTRY SERVICES- WOLI DAN TECH HUB'
        && siteSettings.dantech_enabled === true);
    const { rows: [legacyCertificate] } = await client.query(`
      select certificate_id, verification_code, user_id, course_id, status, issued_by, issue_date, revoked_at
      from certificate_issues where certificate_id='WDTH-2026-ABC123'
    `);
    ok('certificate issuer is rebranded without changing identifiers or validity',
      legacyCertificate.certificate_id === 'WDTH-2026-ABC123'
        && legacyCertificate.verification_code === 'WDTH-ABCD-1234'
        && legacyCertificate.status === 'valid'
        && legacyCertificate.issued_by === 'DANQEL DIGITAL INSTITUTE'
        && legacyCertificate.issue_date.toISOString() === '2026-01-02T03:04:05.000Z'
        && legacyCertificate.revoked_at === null);
    const { rows: [verifiedCertificate] } = await client.query(
      `select public.verify_certificate('WDTH-2026-ABC123') as value`
    );
    ok('public certificate verification keeps its shape and returns the new issuer',
      verifiedCertificate.value.found === true
        && verifiedCertificate.value.certificateId === 'WDTH-2026-ABC123'
        && verifiedCertificate.value.verificationCode === 'WDTH-ABCD-1234'
        && verifiedCertificate.value.issuedBy === 'DANQEL DIGITAL INSTITUTE');
    const { rows: [notification] } = await client.query(`select * from student_notifications`);
    ok('stored notification keeps its row and read state while changing display copy',
      notification.title === 'Payment approved'
        && notification.message === 'DANQEL DIGITAL INSTITUTE approved your payment. Technology • Science • Digital Learning'
        && notification.read === false
        && notification.created_at.toISOString() === '2026-02-03T04:05:06.000Z');
    const { rows: brandingFunctions } = await client.query(`
      select proname, pg_get_functiondef(oid) as definition
      from pg_proc where pronamespace = 'public'::regnamespace
        and proname = any($1::text[])
    `, [['approve_payment', 'reject_payment', 'maybe_issue_certificate', 'issue_certificate_manual', 'redeem_coupon']]);
    ok('future payment, certificate, and coupon RPC messages use the current issuer',
      brandingFunctions.length === 5
        && brandingFunctions.every((fn) => fn.definition.includes('DANQEL DIGITAL INSTITUTE')
          && !fn.definition.includes('WOLI DAN TECH HUB'))
        && brandingFunctions.filter((fn) => ['approve_payment', 'redeem_coupon'].includes(fn.proname))
          .every((fn) => fn.definition.includes('Technology • Science • Digital Learning')));

    const { rows: subjects } = await client.query(`select count(*)::int as n from jamb_subjects`);
    ok('2026 subject baseline seeded without question content', subjects[0].n === 25);
    ok('bundle foreign key references existing migration-011 table',
      (await client.query(`select 1 from pg_constraint where conname='fk_jamb_exam_access_bundle'`)).rowCount === 1);

    const studentId = '11111111-1111-4111-8111-111111111111';
    const otherStudentId = '22222222-2222-4222-8222-222222222222';
    const adminId = '33333333-3333-4333-8333-333333333333';
    await client.query(
      `insert into profiles (id, full_name, email, role) values
       ($1, 'Ada Student', 'ada@example.com', 'student'),
       ($2, 'Bola Student', 'bola@example.com', 'student'),
       ($3, 'School Admin', 'admin@example.com', 'admin')`,
      [studentId, otherStudentId, adminId]
    );
    await client.query(`update profiles set phone=$2 where id=$1`, [studentId, '+234 801 234 5678']);
    const { rows: [couponCourse] } = await client.query(
      `select id from courses where price > 0 order by created_at limit 1`
    );
    await client.query(`
      insert into coupons (code, active, restricted_phone, min_purchase, discount_type, discount_value, used_count)
      values ('DANQEL-TEST', true, '0801-234-5678', 0, 'free', 0, 0)
    `);
    await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [studentId]);
    const { rows: [couponRedemption] } = await client.query(
      `select public.redeem_coupon('DANQEL-TEST', $1) as value`, [couponCourse.id]
    );
    const { rows: [couponEnrollment] } = await client.query(
      `select e.method, e.coupon_code, n.message
       from enrollments e join student_notifications n on n.user_id=e.user_id and n.type='coupon_approved'
       where e.user_id=$1 and e.course_id=$2`, [studentId, couponCourse.id]
    );
    ok('coupon redemption keeps phone normalization and uses the current brand',
      couponRedemption.value.valid === true
        && couponRedemption.value.isFree === true
        && couponEnrollment.method === 'coupon'
        && couponEnrollment.coupon_code === 'DANQEL-TEST'
        && couponEnrollment.message.includes('DANQEL DIGITAL INSTITUTE')
        && couponEnrollment.message.includes('Technology • Science • Digital Learning'));
    await client.query(`select set_config('request.jwt.claim.sub', '', false)`);

    const { rows: [bundle] } = await client.query(
      `update bundles set is_published=true where id=$1 returning id`, [draftPass.id]
    );
    await client.query(
      `insert into manual_payments (user_id, bundle_id, status) values ($1, $2, 'approved')`,
      [studentId, bundle.id]
    );

    const { rows: [exam] } = await client.query(
      `insert into jamb_exams
         (slug, title, mode, syllabus_year, time_limit_minutes, mock_elective_count,
          status, access_bundle_id, created_by, reviewed_by, reviewed_at)
       values ('frontend-contract-mock', 'Frontend Contract Mock', 'MOCK', 2026, 60, 3,
               'DRAFT', $1, $2, $2, now()) returning id`,
      [bundle.id, adminId]
    );
    const mockSubjects = [
      { code: 'USE-OF-ENGLISH', required: true },
      { code: 'BIOLOGY', required: false },
      { code: 'CHEMISTRY', required: false },
      { code: 'MATHEMATICS', required: false },
      { code: 'PHYSICS', required: false },
    ];
    for (const [index, selection] of mockSubjects.entries()) {
      const { rows: [subject] } = await client.query(`select id from jamb_subjects where code=$1`, [selection.code]);
      const { rows: [version] } = await client.query(
        `select id from jamb_syllabus_versions where subject_id=$1 and exam_year=2026`, [subject.id]
      );
      await client.query(
        `insert into jamb_exam_sections (exam_id, subject_id, syllabus_version_id, question_count, is_required, order_number)
         values ($1, $2, $3, 1, $4, $5)`,
        [exam.id, subject.id, version.id, selection.required, index + 1]
      );
    }
    await expectError(
      () => client.query(`update jamb_exams set status='PUBLISHED' where id=$1`, [exam.id]),
      'JAMB_EXAM_QUESTION_BANK_INCOMPLETE',
      'exam cannot publish without reviewed questions'
    );

    for (const selection of mockSubjects) {
      const { rows: [subject] } = await client.query(`select id from jamb_subjects where code=$1`, [selection.code]);
      const { rows: [version] } = await client.query(
        `select id from jamb_syllabus_versions where subject_id=$1 and exam_year=2026`, [subject.id]
      );
      const { rows: [question] } = await client.query(
        `insert into jamb_questions (subject_id, syllabus_version_id, question, explanation,
                                    source_type, rights_verified, status, created_by)
         values ($1, $2, $3, 'Original test-fixture explanation.', 'ORIGINAL', true, 'DRAFT', $4)
         returning id`,
        [subject.id, version.id, `Original test question for ${selection.code}?`, adminId]
      );
      for (let order = 1; order <= 4; order += 1) {
        await client.query(
          `insert into jamb_question_options (question_id, option_text, is_correct, order_number)
           values ($1, $2, $3, $4)`,
          [question.id, `Option ${order}`, order === 1, order]
        );
      }
      await client.query(
        `update jamb_questions set status='PUBLISHED', reviewed_by=$2, reviewed_at=now() where id=$1`,
        [question.id, adminId]
      );
    }
    await client.query(`update jamb_exams set status='IN_REVIEW' where id=$1`, [exam.id]);
    await client.query(`update jamb_exams set status='APPROVED' where id=$1`, [exam.id]);
    await client.query(`update jamb_exams set status='PUBLISHED' where id=$1`, [exam.id]);
    ok('bundle-backed exam publishes after content review');

    const codes = ['USE-OF-ENGLISH', 'BIOLOGY', 'CHEMISTRY', 'MATHEMATICS'];
    await expectError(
      () => client.query(`select start_jamb_exam_attempt($1, $2, $3::text[])`, [exam.id, otherStudentId, codes]),
      'JAMB_PAID_ACCESS_REQUIRED',
      'unpaid student is rejected by the server-side bundle gate'
    );
    const { rows: [started] } = await client.query(
      `select start_jamb_exam_attempt($1, $2, $3::text[]) as attempt`, [exam.id, studentId, codes]
    );
    ok('approved exam_access payment starts a timed paper',
      !!started.attempt.attempt_id && !!started.attempt.expires_at && started.attempt.total_questions === 4);

    await expectError(
      () => asUser(client, studentId, `select count(*) from jamb_questions`),
      'permission denied',
      'authenticated browser role cannot read the private JAMB question bank'
    );
    await expectError(
      () => asUser(client, studentId, `select count(*) from jamb_exam_attempt_items`),
      'permission denied',
      'authenticated browser role cannot read private answer snapshots'
    );

    console.log(`\nAll ${passed} frontend-schema JAMB checks passed.`);
  } finally {
    await client.end();
    await postgres.stop();
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\nFrontend-schema JAMB test failed:', error.message);
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
