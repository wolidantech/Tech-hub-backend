/**
 * Functional test of the WOLI DAN TECH HUB database layer against a
 * REAL PostgreSQL (embedded), with Supabase's auth/storage internals
 * stubbed faithfully (auth.users, auth.uid(), storage.buckets...).
 *
 * Covers: schema install, registration trigger, RLS isolation,
 * payment submission rules, atomic approve/reject, course completion
 * trigger, certificate issuance + public verification, statistics.
 *
 * Usage: node scripts/test-db.mjs
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-pg');

let passed = 0;
function ok(name, cond = true) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function expectError(fn, match, name) {
  try {
    await fn();
  } catch (err) {
    assert.ok(String(err.message).includes(match), `${name} — wrong error: ${err.message}`);
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  assert.fail(`${name} — expected error "${match}"`);
}

const SUPABASE_STUB_SQL = `
-- Supabase platform stubs (what the cloud provides out of the box)
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

-- faithful copy of Supabase's auth.uid()
create or replace function auth.uid()
returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

-- Supabase built-in roles
do $$ begin
  create role anon nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin;
exception when duplicate_object then null; end $$;
grant usage on schema public to anon, authenticated, service_role;

-- storage stubs
create table if not exists storage.buckets (
  id text primary key,
  name text,
  public boolean default false,
  owner uuid,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz default now()
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
  rmSync(DATA_DIR, { recursive: true, force: true });
  const ep = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: 5499,
    persistent: false,
  });
  await ep.initialise();
  await ep.start();
  await ep.createDatabase('wdth');

  const client = new pg.Client({
    host: '127.0.0.1',
    port: 5499,
    user: 'postgres',
    password: 'postgres',
    database: 'wdth',
  });
  await client.connect();

  console.log('\n[1/6] Installing schema + stubbing Supabase platform...');
  await client.query(SUPABASE_STUB_SQL);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    console.log(`  ✓ applied ${file}`);
  }

  // ---------------- registration trigger ----------------
  console.log('\n[2/6] Registration trigger & welcome notification');
  const { rows: [studentAuth] } = await client.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ('student1@example.com', '{"full_name":"Ada Student","phone":"+2348000000001"}') returning id`
  );
  const { rows: [student] } = await client.query(
    `select * from profiles where user_id = $1`, [studentAuth.id]
  );
  ok('profile auto-created for new auth user', !!student);
  ok('default role is student', student.role === 'student');
  ok('full name copied from metadata', student.full_name === 'Ada Student');
  const { rows: welcomes } = await client.query(
    `select * from notifications where user_id = $1`, [student.id]
  );
  ok('WELCOME notification created', welcomes.length === 1 && welcomes[0].type === 'WELCOME');

  // admin user (created like scripts/create-admin.js would)
  const { rows: [adminAuth] } = await client.query(
    `insert into auth.users (email) values ('wolidantech@gmail.com') returning id`
  );
  const { rows: [admin] } = await client.query(
    `update profiles set role = 'admin', full_name = 'Woli Dan (Admin)' where user_id = $1 returning *`,
    [adminAuth.id]
  );
  ok('admin profile ready', admin.role === 'admin');

  // seed sanity
  const { rows: cats } = await client.query(`select count(*)::int as n from course_categories`);
  ok('7 categories seeded', cats[0].n === 7);
  const { rows: courses } = await client.query(`select count(*)::int as n, min(price) as p from courses`);
  ok('12 courses seeded at NGN 5000', courses[0].n === 12 && Number(courses[0].p) === 5000);
  const { rows: bank } = await client.query(`select value from platform_settings where key='bank_details'`);
  ok('bank details seeded (MONIEPOINT)', bank[0].value.bank_name === 'MONIEPOINT');
  const { rows: capcut } = await client.query(
    `select count(*)::int as n from course_modules m join courses c on c.id=m.course_id where c.slug='video-editing-with-capcut'`
  );
  ok('CapCut course has 7 modules', capcut[0].n === 7);

  const { rows: [course] } = await client.query(`select * from courses where slug='video-editing-with-capcut'`);

  // ---------------- RLS isolation ----------------
  console.log('\n[3/6] Row Level Security');
  let r = await asUser(client, studentAuth.id, `select count(*)::int as n from profiles`);
  ok('student sees only own profile (RLS)', r.rows[0].n === 1);

  r = await asUser(client, adminAuth.id, `select count(*)::int as n from profiles`);
  ok('admin sees all profiles (RLS)', r.rows[0].n === 2);

  await expectError(
    () => asUser(client, studentAuth.id, `update profiles set role='admin' where id=$1`, [student.id]),
    'FORBIDDEN',
    'student cannot escalate own role (trigger)'
  );

  r = await asUser(client, studentAuth.id, `select count(*)::int as n from lessons`);
  ok('unenrolled student sees 0 lesson rows via RLS', r.rows[0].n === 0);

  // ---------------- payment submission rules ----------------
  console.log('\n[4/6] Manual payment flow');
  const payment = await asUser(client, studentAuth.id,
    `insert into payments (student_id, course_id, amount, transaction_reference, transaction_date)
     values ($1, $2, 5000, 'TRX-0001', '2026-09-10') returning *`,
    [student.id, course.id]
  );
  ok('student can submit own PENDING payment', payment.rows[0].status === 'PENDING');

  const { rows: submittedNotes } = await client.query(
    `select * from notifications where user_id=$1 and type='PAYMENT_SUBMITTED'`, [student.id]
  );
  ok('PAYMENT_SUBMITTED notification created by trigger', submittedNotes.length === 1);

  // student cannot flip the status
  await asUser(client, studentAuth.id, `update payments set status='APPROVED' where id=$1`, [payment.rows[0].id]);
  const { rows: stillPending } = await client.query(`select status from payments where id=$1`, [payment.rows[0].id]);
  ok('student UPDATE on payment is silently denied by RLS', stillPending[0].status === 'PENDING');

  await expectError(
    () => asUser(client, studentAuth.id,
      `insert into payments (student_id, course_id, amount, transaction_reference, transaction_date)
       values ($1, $2, 5000, 'TRX-0002', '2026-09-10')`,
      [admin.id, course.id]),
    'row-level security',
    'student cannot insert a payment for another user (WITH CHECK)'
  );

  await expectError(
    () => client.query(
      `insert into payments (student_id, course_id, amount, transaction_reference, transaction_date)
       values ($1, $2, 5000, 'TRX-0001', '2026-09-09')`,
      [student.id, course.id]),
    'uq_transaction_reference',
    'duplicate transaction reference rejected'
  );

  await expectError(
    () => client.query(
      `insert into payments (student_id, course_id, amount, transaction_reference, transaction_date)
       values ($1, $2, 5000, 'TRX-0003', '2026-09-10')`,
      [student.id, course.id]),
    'uq_pending_payment_per_course',
    'second PENDING payment for same course blocked (partial unique index)'
  );

  // receipt RLS: owner vs stranger
  const { rows: [receipt] } = await client.query(
    `insert into payment_receipts (payment_id, student_id, file_path, file_name, file_type)
     values ($1, $2, $3, 'receipt.jpg', 'image/jpeg') returning *`,
    [payment.rows[0].id, student.id, `${studentAuth.id}/${payment.rows[0].id}/receipt.jpg`]
  );
  r = await asUser(client, studentAuth.id, `select count(*)::int as n from payment_receipts`);
  ok('owner can read own receipt row (RLS)', r.rows[0].n === 1);

  // ---------------- atomic approval ----------------
  console.log('\n[5/6] Atomic APPROVE -> enrollment ACTIVE');
  const { rows: [approveRes] } = await client.query(
    `select approve_payment($1, $2) as r`, [payment.rows[0].id, admin.id]
  );
  ok('approve_payment returns enrollment id', !!approveRes.r.enrollment_id);

  const after = await client.query(
    `select p.status as payment_status, p.reviewed_by, p.reviewed_at,
            e.status as enrollment_status, e.payment_id
       from payments p join enrollments e on e.student_id=p.student_id and e.course_id=p.course_id
      where p.id=$1`,
    [payment.rows[0].id]
  );
  ok('payment APPROVED with reviewer+timestamp',
    after.rows[0].payment_status === 'APPROVED' &&
    after.rows[0].reviewed_by === admin.id &&
    !!after.rows[0].reviewed_at);
  ok('enrollment created and ACTIVE', after.rows[0].enrollment_status === 'ACTIVE');
  ok('enrollment linked to approved payment', after.rows[0].payment_id === payment.rows[0].id);

  const { rows: approveNotes } = await client.query(
    `select type from notifications where user_id=$1 and type in ('PAYMENT_APPROVED','COURSE_ENROLLED') order by 1`,
    [student.id]
  );
  ok('student got PAYMENT_APPROVED + COURSE_ENROLLED notifications', approveNotes.length === 2);

  const { rows: audit } = await client.query(`select * from audit_logs where action='PAYMENT_APPROVED'`);
  ok('audit event recorded', audit.length === 1 && audit[0].admin_id === admin.id);

  await expectError(
    () => client.query(`select approve_payment($1, $2)`, [payment.rows[0].id, admin.id]),
    'PAYMENT_ALREADY_REVIEWED',
    'double approval rejected'
  );

  // enrolled student now sees lessons via RLS
  r = await asUser(client, studentAuth.id,
    `select count(*)::int as n from lessons`);
  ok('enrolled student sees lessons via RLS', r.rows[0].n === 1); // 1 seed lesson

  // ---------------- course completion -> certificate ----------------
  console.log('\n[6/6] Completion, certificates, rejection, statistics');
  const { rows: seedLessons } = await client.query(
    `select l.id, m.course_id from lessons l join course_modules m on m.id=l.module_id where m.course_id=$1 and l.is_published`,
    [course.id]
  );
  const { rows: [progress] } = await client.query(
    `insert into lesson_progress (student_id, lesson_id, course_id, completed, completed_at)
     values ($1, $2, $3, true, now()) returning *`,
    [student.id, seedLessons[0].id, course.id]
  );
  ok('lesson progress recorded', !!progress);

  const { rows: [enr] } = await client.query(
    `select * from enrollments where student_id=$1 and course_id=$2`, [student.id, course.id]
  );
  ok('all lessons done -> enrollment COMPLETED', enr.status === 'COMPLETED' && !!enr.completed_at);

  const { rows: [cert] } = await client.query(
    `select * from certificates where student_id=$1 and course_id=$2`, [student.id, course.id]
  );
  ok('certificate auto-issued with WDTH number', /^WDTH-\d{4}-000001$/.test(cert.certificate_number));

  const { rows: certNotes } = await client.query(
    `select type from notifications where user_id=$1 and type in ('COURSE_COMPLETED','CERTIFICATE_ISSUED')`,
    [student.id]
  );
  ok('COURSE_COMPLETED + CERTIFICATE_ISSUED notifications', certNotes.length === 2);

  // public verification
  const { rows: [verify] } = await client.query(`select verify_certificate($1) as v`, [cert.certificate_number]);
  ok('verify_certificate: valid', verify.v.valid === true);
  ok('verify_certificate: returns name/course/org only',
    verify.v.student_name === 'Ada Student' &&
    verify.v.course_name === 'Video Editing with CapCut' &&
    verify.v.issued_by === 'WOLI DAN TECH HUB' &&
    verify.v.email === undefined);
  const { rows: [verifyMissing] } = await client.query(`select verify_certificate('WDTH-2099-999999') as v`);
  ok('verify_certificate: unknown id -> null', verifyMissing.v === null);

  // rejection flow + resubmission
  const { rows: [pay2] } = await client.query(
    `insert into payments (student_id, course_id, amount, transaction_reference, transaction_date)
     values ($1, $2, 5000, 'TRX-7777', '2026-09-10') returning *`,
    [student.id, seedLessons[0].course_id ? (await client.query(`select id from courses where slug='microsoft-excel'`)).rows[0].id : course.id]
  );
  await expectError(
    () => client.query(`select reject_payment($1, $2, $3)`, [pay2.id, admin.id, '']),
    'REJECTION_REASON_REQUIRED',
    'rejection requires a reason'
  );
  await client.query(`select reject_payment($1, $2, $3)`, [pay2.id, admin.id, 'Amount does not match receipt']);
  const { rows: [pay2After] } = await client.query(`select * from payments where id=$1`, [pay2.id]);
  ok('payment REJECTED with reason + reviewer',
    pay2After.status === 'REJECTED' && pay2After.rejection_reason === 'Amount does not match receipt' && pay2After.reviewed_by === admin.id);
  const { rows: rejNotes } = await client.query(
    `select * from notifications where user_id=$1 and type='PAYMENT_REJECTED'`, [student.id]
  );
  ok('student notified of rejection', rejNotes.length === 1);
  const { rows: [excelCourse] } = await client.query(`select id from courses where slug='microsoft-excel'`);
  const { rows: noEnr } = await client.query(
    `select * from enrollments where student_id=$1 and course_id=$2 and status='ACTIVE'`, [student.id, excelCourse?.id || pay2.course_id]
  );
  ok('no ACTIVE enrollment after rejection', noEnr.length === 0);

  await client.query(
    `insert into payments (student_id, course_id, amount, transaction_reference, transaction_date)
     values ($1, $2, 5000, 'TRX-7778', '2026-09-11')`,
    [student.id, pay2.course_id]
  );
  ok('student may resubmit after rejection', true);

  // statistics (approved revenue only)
  const { rows: [stats] } = await client.query(`select admin_statistics() as s`);
  ok('admin_statistics: 1 student', stats.s.total_students === 1);
  ok('admin_statistics: revenue counts APPROVED only', Number(stats.s.total_revenue) === 5000);
  ok('admin_statistics: counts coherent',
    stats.s.approved_payments === 1 && stats.s.rejected_payments === 1 &&
    stats.s.pending_payments === 1 && stats.s.certificates_issued === 1 &&
    stats.s.completed_courses === 1);

  console.log(`\nAll ${passed} database checks passed.`);
  await client.end();
  await ep.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
}

main().catch(async (err) => {
  console.error('\nTEST FAILURE:', err.message);
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
