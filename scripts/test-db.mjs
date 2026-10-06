/**
 * Functional test of the DANQEL DIGITAL INSTITUTE database layer against a
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

  console.log('\n[1/8] Installing schema + stubbing Supabase platform...');
  await client.query(SUPABASE_STUB_SQL);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    console.log(`  ✓ applied ${file}`);
  }

  // ---------------- registration trigger ----------------
  console.log('\n[2/8] Registration trigger & welcome notification');
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
  ok('DANQEL welcome notification uses the current tagline',
    welcomes.length === 1
      && welcomes[0].type === 'WELCOME'
      && welcomes[0].title === 'Welcome to DANQEL DIGITAL INSTITUTE'
      && welcomes[0].message.includes('Technology • Science • Digital Learning'));

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
  ok('11 categories seeded after catalogue expansion', cats[0].n === 11);
  const { rows: courses } = await client.query(`select count(*)::int as n, min(price) as p from courses`);
  ok('32 courses seeded at NGN 5000 baseline', courses[0].n === 32 && Number(courses[0].p) === 5000);
  const { rows: draftCourses } = await client.query(
    `select count(*)::int as n from courses where slug in (
       'quality-assurance-laboratories-manufacturing', 'quality-control-testing-methods',
       'molecular-biology-laboratory-techniques', 'laboratory-analysis-instrumentation',
       'technical-drawing-cad-industrial-design', '3d-product-modelling-rendering',
       'product-prototyping-materials-fabrication', 'digital-illustration-vector-art',
       'business-administration', 'jamb-cbt-practice-mock-exams'
     ) and is_published = false`
  );
  ok('requested course and paid JAMB shells remain unpublished', draftCourses[0].n === 10);
  const { rows: bank } = await client.query(`select value from platform_settings where key='bank_details'`);
  ok('bank details seeded (MONIEPOINT)', bank[0].value.bank_name === 'MONIEPOINT');
  const { rows: platformRows } = await client.query(`select value from platform_settings where key='platform'`);
  ok('institution name and tagline are rebranded without changing support contact',
    platformRows[0].value.name === 'DANQEL DIGITAL INSTITUTE'
      && platformRows[0].value.tagline === 'Technology • Science • Digital Learning'
      && platformRows[0].value.support_email === 'wolidantech@gmail.com');
  const { rows: [welcomeLesson] } = await client.query(`
    select l.description, l.content from lessons l
    join course_modules m on m.id=l.module_id
    join courses c on c.id=m.course_id
    where c.slug='video-editing-with-capcut' and m.order_number=1 and l.title='Welcome to the course'
  `);
  ok('seeded CapCut preview lesson uses the new tagline',
    welcomeLesson?.content?.includes('Technology • Science • Digital Learning')
      && !welcomeLesson?.content?.includes('LEARN • BUILD • GROW')
      && !welcomeLesson?.description?.includes('WOLI DAN TECH HUB'));
  const { rows: capcut } = await client.query(
    `select count(*)::int as n from course_modules m join courses c on c.id=m.course_id where c.slug='video-editing-with-capcut'`
  );
  ok('CapCut course has 7 modules', capcut[0].n === 7);

  const { rows: [course] } = await client.query(`select * from courses where slug='video-editing-with-capcut'`);

  // ---------------- RLS isolation ----------------
  console.log('\n[3/8] Row Level Security');
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
  console.log('\n[4/8] Manual payment flow');
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
  console.log('\n[5/8] Atomic APPROVE -> enrollment ACTIVE');
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
  console.log('\n[6/8] Completion, certificates, rejection, statistics');
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
  ok('legacy certificate PDF is marked for one-time rebranding', cert.pdf_brand_version === 0);

  const { rows: certNotes } = await client.query(
    `select type from notifications where user_id=$1 and type in ('COURSE_COMPLETED','CERTIFICATE_ISSUED')`,
    [student.id]
  );
  ok('COURSE_COMPLETED + CERTIFICATE_ISSUED notifications', certNotes.length === 2);

  // public verification
  const { rows: [verify] } = await client.query(`select verify_certificate($1) as v`, [cert.certificate_number]);
  ok('verify_certificate: valid', verify.v.valid === true);
  ok('verify_certificate: returns name/course/new issuer only',
    verify.v.student_name === 'Ada Student' &&
    verify.v.course_name === 'Video Editing with CapCut' &&
    verify.v.issued_by === 'DANQEL DIGITAL INSTITUTE' &&
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

  // ---------------- curriculum engine (migration 014) ----------------
  console.log('\n[7/8] Curriculum engine: topics, contents, quizzes, assignments, RPCs');

  const { rows: [mod1] } = await client.query(
    `select * from course_modules where course_id=$1 order by order_number limit 1`, [course.id]
  );

  // topics: integrity + ordering
  const { rows: [topic1] } = await client.query(
    `insert into course_topics (course_id, module_id, title, order_number, is_published)
     values ($1, $2, 'Getting started', 1, true) returning *`,
    [course.id, mod1.id]
  );
  ok('topic created under module', !!topic1 && topic1.published === true);
  await expectError(
    () => client.query(
      `insert into course_topics (course_id, module_id, title) values ($1, $2, 'Bad link')`,
      [excelCourse.id, mod1.id]
    ),
    'TOPIC_COURSE_MISMATCH',
    'topic rejects module from another course'
  );
  const { rows: [topic2] } = await client.query(
    `insert into course_topics (course_id, module_id, title, order_number, is_published)
     values ($1, $2, 'Next steps', 2, true) returning *`,
    [course.id, mod1.id]
  );
  await client.query(`select reorder_topics($1, $2)`, [mod1.id, [topic2.id, topic1.id]]);
  const { rows: reordered } = await client.query(
    `select id from course_topics where module_id=$1 order by order_number`, [mod1.id]
  );
  ok('reorder_topics swaps topic order', reordered[0].id === topic2.id && reordered[1].id === topic1.id);

  // lessons: topic link, course denorm, flag mirror
  const { rows: [lesson2] } = await client.query(
    `insert into lessons (module_id, topic_id, title, lesson_type, content, order_number, is_published)
     values ($1, $2, 'Your first edit', 'TEXT', 'Trim a clip.', 2, true) returning *`,
    [mod1.id, topic1.id]
  );
  ok('lesson auto-fills course_id + published mirror',
    lesson2.course_id === course.id && lesson2.published === true);
  const { rows: [mod2] } = await client.query(
    `select * from course_modules where course_id=$1 and id <> $2 order by order_number limit 1`,
    [course.id, mod1.id]
  );
  const { rows: [otherTopic] } = await client.query(
    `insert into course_topics (course_id, module_id, title, order_number)
     values ($1, $2, 'Other module topic', 1) returning *`,
    [course.id, mod2.id]
  );
  await expectError(
    () => client.query(`update lessons set topic_id=$1 where id=$2`, [otherTopic.id, lesson2.id]),
    'LESSON_TOPIC_MISMATCH',
    'lesson rejects topic from another module'
  );

  // lesson contents: structured blocks + denorm
  const { rows: [block] } = await client.query(
    `insert into lesson_contents (lesson_id, block_type, title, body, order_number, is_published)
     values ($1, 'THEORY', 'Trimming', 'Select the clip...', 1, true) returning *`,
    [lesson2.id]
  );
  ok('lesson content denormalises course/module/topic',
    block.course_id === course.id && block.module_id === mod1.id && block.topic_id === topic1.id);

  // outline RPC: public, safe columns only
  const { rows: [outline] } = await client.query(`select get_course_outline($1) as o`, [course.id]);
  ok('get_course_outline returns modules + published lessons',
    outline.o.curriculum_complete === true && outline.o.counts.lessons === 2);
  ok('outline exposes no lesson bodies',
    JSON.stringify(outline.o).includes('Trim a clip.') === false);

  // compat views
  r = await client.query(`select id, position, order_number from course_lessons where id=$1`, [lesson2.id]);
  ok('course_lessons view mirrors lessons (position alias)', r.rows[0].position === r.rows[0].order_number);
  r = await client.query(`select count(*)::int as n from student_progress where student_id=$1`, [student.id]);
  ok('student_progress view exposes progress rows', r.rows[0].n === 1);

  // quizzes: normalised options, stripped reads, server-side grading
  const { rows: [quiz] } = await client.query(
    `insert into quizzes (course_id, module_id, lesson_id, title, passing_score, status)
     values ($1, $2, $3, 'Trimming quiz', 70, 'PUBLISHED') returning *`,
    [course.id, mod1.id, lesson2.id]
  );
  const { rows: [question] } = await client.query(
    `insert into quiz_questions (quiz_id, question, question_type, options, correct_answer)
     values ($1, 'Which tool trims?', 'multiple_choice', '[]', '"Trim"') returning *`,
    [quiz.id]
  );
  const { rows: [optA] } = await client.query(
    `insert into quiz_options (question_id, option_text, is_correct, order_number)
     values ($1, 'Trim', true, 1) returning *`, [question.id]
  );
  await client.query(
    `insert into quiz_options (question_id, option_text, is_correct, order_number)
     values ($1, 'Delete', false, 2)`, [question.id]
  );
  const { rows: [qAfter] } = await client.query(`select options from quiz_questions where id=$1`, [question.id]);
  ok('options JSONB mirror carries no correctness flags',
    JSON.stringify(qAfter.options).includes('is_correct') === false);

  const { rows: [studentQuiz] } = await client.query(
    `select get_quiz_for_student_for($1, $2) as q`, [quiz.id, student.id]
  );
  ok('student quiz strips answers',
    studentQuiz.q.questions[0].correct_answer === undefined &&
    studentQuiz.q.questions[0].options.length === 2);

  const { rows: [pass] } = await client.query(
    `select submit_quiz_attempt_for($1, $2, $3) as a`,
    [quiz.id, student.id, JSON.stringify([{ question_id: question.id, answer: optA.id }])]
  );
  ok('correct answers pass the quiz', pass.a.passed === true && Number(pass.a.score) === 100);
  const { rows: [fail] } = await client.query(
    `select submit_quiz_attempt_for($1, $2, $3) as a`,
    [quiz.id, student.id, JSON.stringify([{ question_id: question.id, answer: 'Delete' }])]
  );
  ok('wrong answers fail the quiz', fail.a.passed === false && Number(fail.a.score) === 0);

  // assignments: student submits, cannot self-grade; admin grades
  const { rows: [assignment] } = await client.query(
    `insert into assignments (course_id, module_id, lesson_id, title, description, instructions, status, pass_score)
     values ($1, $2, $3, 'Trim exercise', 'Trim.', 'Do it.', 'PUBLISHED', 50) returning *`,
    [course.id, mod1.id, lesson2.id]
  );
  const sub = await asUser(client, studentAuth.id,
    `insert into assignment_submissions (assignment_id, student_id, course_id, submission_text)
     values ($1, $2, $3, 'My edit') returning *`,
    [assignment.id, student.id, course.id]
  );
  ok('enrolled student can submit assignment', sub.rows[0].status === 'SUBMITTED');
  await expectError(
    () => asUser(client, studentAuth.id,
      `update assignment_submissions set score=100 where id=$1`, [sub.rows[0].id]),
    'FORBIDDEN',
    'student cannot self-grade submission'
  );
  r = await asUser(client, adminAuth.id,
    `update assignment_submissions set score=80, feedback='Good', status='GRADED', graded_by=$1, graded_at=now()
     where id=$2 returning *`,
    [admin.id, sub.rows[0].id]
  );
  ok('admin can grade submission', r.rows[0].status === 'GRADED' && Number(r.rows[0].score) === 80);

  // second student: gated out of lessons + classroom, outline still public
  const { rows: [student2Auth] } = await client.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ('student2@example.com', '{"full_name":"Bola Fresh"}') returning id`
  );
  const { rows: [student2] } = await client.query(`select * from profiles where user_id=$1`, [student2Auth.id]);
  r = await asUser(client, student2Auth.id, `select count(*)::int as n from lessons`);
  ok('unenrolled student sees 0 lessons via RLS', r.rows[0].n === 0);
  await expectError(
    () => asUser(client, student2Auth.id, `select get_course_classroom($1)`, [course.id]),
    'COURSE_ACCESS_DENIED',
    'classroom RPC denies unenrolled student'
  );
  r = await asUser(client, student2Auth.id,
    `select count(*)::int as n from assignment_submissions`);
  ok('student cannot read other students submissions', r.rows[0].n === 0);

  // assessments: live + enrolled-readable
  const { rows: [assessment] } = await client.query(
    `insert into course_assessments (course_id, title, assessment_type, status)
     values ($1, 'CapCut final', 'FINAL_EXAM', 'PUBLISHED') returning *`, [course.id]
  );
  await client.query(`update quizzes set assessment_id=$1, scope='FINAL' where id=$2`, [assessment.id, quiz.id]);
  r = await asUser(client, studentAuth.id,
    `select count(*)::int as n from course_assessments where course_id=$1`, [course.id]);
  ok('enrolled student reads live assessments', r.rows[0].n === 1);
  r = await asUser(client, student2Auth.id,
    `select count(*)::int as n from course_assessments where course_id=$1`, [course.id]);
  ok('unenrolled student reads 0 assessments', r.rows[0].n === 0);

  // publish cascade + completion check
  const { rows: [unpub] } = await client.query(`select publish_course_content($1, false) as p`, [course.id]);
  ok('unpublish cascade flips chain', unpub.p.published === false && unpub.p.lessons_updated >= 2);
  const { rows: [outlineHidden] } = await client.query(`select get_course_outline($1) as o`, [course.id]);
  ok('unpublished course has no public outline', outlineHidden.o === null);
  await client.query(`select publish_course_content($1, true)`, [course.id]);
  const { rows: [repub] } = await client.query(
    `select is_published, published, archived from courses where id=$1`, [course.id]
  );
  ok('republish restores synced flags',
    repub.is_published === true && repub.published === true && repub.archived === false);

  // dual-flag sync: legacy writes propagate one way, canonical the other
  await client.query(`update courses set published=false where id=$1`, [course.id]);
  const { rows: [legacyOff] } = await client.query(
    `select is_published, published from courses where id=$1`, [course.id]
  );
  ok('legacy published=false unpublishes canonically',
    legacyOff.is_published === false && legacyOff.published === false);
  await client.query(`update courses set is_published=true where id=$1`, [course.id]);
  const { rows: [canonOn] } = await client.query(
    `select is_published, published, archived from courses where id=$1`, [course.id]
  );
  ok('canonical is_published=true republishes mirror',
    canonOn.is_published === true && canonOn.published === true && canonOn.archived === false);
  await client.query(`update lessons set published=false where id=$1`, [lesson2.id]);
  const { rows: [lessonOff] } = await client.query(
    `select is_published, published from lessons where id=$1`, [lesson2.id]
  );
  ok('lesson flags stay mirrored both directions',
    lessonOff.is_published === false && lessonOff.published === false);
  await client.query(`update lessons set is_published=true where id=$1`, [lesson2.id]);

  const { rows: [completion] } = await client.query(
    `select check_course_completion($1, $2) as c`, [student.id, course.id]
  );
  ok('completion check reports COMPLETED enrollment', completion.c.completed === true);

  const { rows: [stats2] } = await client.query(`select admin_statistics() as s`);
  ok('admin_statistics includes curriculum keys',
    stats2.s.total_topics >= 2 && stats2.s.live_quizzes >= 1 && stats2.s.live_assignments >= 1);

  // ---------------- JAMB CBT + student ID security ----------------
  console.log('\n[8/8] JAMB CBT, paid access, answer privacy and student IDs');
  ok('student number is automatically assigned', /^WDTH-\d{4}-\d{6}$/.test(student.student_number));
  const { rows: [studentCard] } = await client.query(
    `select status, student_number from student_id_cards where profile_id=$1`, [student.id]
  );
  ok('ID-card row is created pending photo at signup',
    studentCard.status === 'PENDING_PHOTO' && studentCard.student_number === student.student_number);

  r = await asUser(client, studentAuth.id,
    `select status from student_id_cards where profile_id=$1`, [student.id]);
  ok('student can read their own ID-card status', r.rows[0]?.status === 'PENDING_PHOTO');
  r = await asUser(client, studentAuth.id,
    `select count(*)::int as n from student_id_cards where profile_id=$1`, [student2.id]);
  ok('student cannot read another student ID-card row', r.rows[0].n === 0);
  await expectError(
    () => asUser(client, studentAuth.id,
      `update profiles set student_number='WDTH-2026-999999' where id=$1`, [student.id]),
    'FORBIDDEN',
    'student cannot change their server-assigned student number'
  );
  await asUser(client, studentAuth.id,
    `update profiles set profile_photo_url='https://example.supabase.co/storage/v1/object/public/avatars/student/avatar.png' where id=$1`,
    [student.id]);
  const { rows: [photoCard] } = await client.query(
    `select status from student_id_cards where profile_id=$1`, [student.id]
  );
  ok('adding a profile photo moves the ID card to pending generation', photoCard.status === 'PENDING_GENERATION');

  const { rows: [jambCourse] } = await client.query(
    `select id, price, is_published from courses where slug='jamb-cbt-practice-mock-exams'`
  );
  ok('paid JAMB access course is seeded unpublished',
    !!jambCourse && Number(jambCourse.price) === 5000 && jambCourse.is_published === false);

  await expectError(
    () => asUser(client, studentAuth.id, `select count(*)::int as n from quiz_questions`),
    'permission denied',
    'direct quiz answer-key table reads are revoked'
  );
  await expectError(
    () => asUser(client, studentAuth.id, `select count(*)::int as n from jamb_questions`),
    'permission denied',
    'direct JAMB question-bank reads are revoked'
  );

  // Configure a complete mock in the isolated test database. No past-paper
  // content is used; the five questions below are synthetic test fixtures.
  await client.query(`update courses set is_published=true where id=$1`, [jambCourse.id]);
  const { rows: [exam] } = await client.query(
    `insert into jamb_exams
       (slug, title, mode, syllabus_year, time_limit_minutes, mock_elective_count,
        status, access_course_id, created_by, reviewed_by, reviewed_at)
     values ('test-utme-mock-2026', 'Test UTME Mock 2026', 'MOCK', 2026, 60, 3,
             'DRAFT', $1, $2, $2, now()) returning *`,
    [jambCourse.id, admin.id]
  );
  const mockSubjects = [
    { code: 'USE-OF-ENGLISH', required: true },
    { code: 'BIOLOGY', required: false },
    { code: 'CHEMISTRY', required: false },
    { code: 'MATHEMATICS', required: false },
    { code: 'PHYSICS', required: false },
  ];
  for (const [index, selection] of mockSubjects.entries()) {
    const { rows: [subjectRow] } = await client.query(
      `select id from jamb_subjects where code=$1`, [selection.code]
    );
    const { rows: [syllabus] } = await client.query(
      `select id from jamb_syllabus_versions where subject_id=$1 and exam_year=2026`, [subjectRow.id]
    );
    await client.query(
      `insert into jamb_exam_sections (exam_id, subject_id, syllabus_version_id, question_count, is_required, order_number)
       values ($1, $2, $3, 1, $4, $5)`,
      [exam.id, subjectRow.id, syllabus.id, selection.required, index + 1]
    );
  }
  await expectError(
    () => client.query(`update jamb_exams set status='PUBLISHED' where id=$1`, [exam.id]),
    'JAMB_EXAM_QUESTION_BANK_INCOMPLETE',
    'exam publishing is blocked until every section has enough reviewed questions'
  );

  for (const selection of mockSubjects) {
    const { rows: [subjectRow] } = await client.query(
      `select id from jamb_subjects where code=$1`, [selection.code]
    );
    const { rows: [syllabus] } = await client.query(
      `select id from jamb_syllabus_versions where subject_id=$1 and exam_year=2026`, [subjectRow.id]
    );
    const { rows: [questionRow] } = await client.query(
      `insert into jamb_questions
         (subject_id, syllabus_version_id, question, explanation, source_type, rights_verified, status, created_by)
       values ($1, $2, $3, 'This is an original test-fixture explanation.', 'ORIGINAL', true, 'DRAFT', $4)
       returning id`,
      [subjectRow.id, syllabus.id, `Synthetic test question for ${selection.code}?`, admin.id]
    );
    for (let index = 0; index < 4; index += 1) {
      await client.query(
        `insert into jamb_question_options (question_id, option_text, is_correct, order_number)
         values ($1, $2, $3, $4)`,
        [questionRow.id, `Option ${index + 1} for ${selection.code}`, index === 0, index + 1]
      );
    }
    await client.query(
      `update jamb_questions set status='PUBLISHED', reviewed_by=$2, reviewed_at=now() where id=$1`,
      [questionRow.id, admin.id]
    );
  }

  await client.query(`update jamb_exams set status='IN_REVIEW' where id=$1`, [exam.id]);
  await client.query(`update jamb_exams set status='APPROVED' where id=$1`, [exam.id]);
  await client.query(`update jamb_exams set status='PUBLISHED' where id=$1`, [exam.id]);
  const { rows: [publishedExam] } = await client.query(
    `select status from jamb_exams where id=$1`, [exam.id]
  );
  ok('complete paid mock publishes after review', publishedExam.status === 'PUBLISHED');

  await expectError(
    () => client.query(
      `select start_jamb_exam_attempt($1, $2, $3::text[])`,
      [exam.id, student2.id, ['USE-OF-ENGLISH', 'BIOLOGY', 'CHEMISTRY', 'MATHEMATICS']]
    ),
    'JAMB_PAID_ACCESS_REQUIRED',
    'student without paid JAMB enrollment cannot start a mock'
  );
  await client.query(
    `insert into enrollments (student_id, course_id, status) values ($1, $2, 'ACTIVE')`,
    [student.id, jambCourse.id]
  );
  const { rows: [attemptResult] } = await client.query(
    `select start_jamb_exam_attempt($1, $2, $3::text[]) as a`,
    [exam.id, student.id, ['USE-OF-ENGLISH', 'BIOLOGY', 'CHEMISTRY', 'MATHEMATICS']]
  );
  const activeAttempt = attemptResult.a;
  ok('paid student starts a mock with required English + three electives',
    activeAttempt.total_questions === 4 && activeAttempt.selected_subject_codes.length === 4);
  const { rows: attemptItems } = await client.query(
    `select id, subject_id, options_snapshot, correct_option_id_snapshot
       from jamb_exam_attempt_items where attempt_id=$1 order by order_number`,
    [activeAttempt.attempt_id]
  );
  ok('attempt snapshots expose option text but no answer flags',
    attemptItems.length === 4 && attemptItems.every((item) =>
      item.options_snapshot.length === 4 &&
      item.options_snapshot.every((option) => !Object.hasOwn(option, 'is_correct'))));

  // ---------------- past-question study library (migration 020) -------------
  const { rows: [studyColumn] } = await client.query(`
    select column_default, is_nullable from information_schema.columns
     where table_schema='public' and table_name='jamb_questions'
       and column_name='study_visible'
  `);
  ok('past-question release flag exists and defaults to hidden',
    !!studyColumn && studyColumn.is_nullable === 'NO' && studyColumn.column_default === 'false');

  const libraryQuery = `
    select q.id, q.exam_year, q.topic, q.question, js.code as subject_code
      from jamb_questions q join jamb_subjects js on js.id = q.subject_id
     where q.status = 'PUBLISHED' and q.study_visible = true
     order by q.exam_year desc nulls last`;
  const { rows: unreleasedLibrary } = await client.query(libraryQuery);
  ok('a reviewed bank stays out of the student library until an admin releases it',
    unreleasedLibrary.length === 0);

  const { rows: [librarySubject] } = await client.query(`select id from jamb_subjects where code='BIOLOGY'`);
  await client.query(
    `update jamb_questions
        set study_visible = true, exam_year = 2023, topic = 'Cell structure'
      where subject_id = $1 and status = 'PUBLISHED'`,
    [librarySubject.id]
  );
  const { rows: releasedLibrary } = await client.query(libraryQuery);
  ok('released published questions become browsable with their paper year and subject',
    releasedLibrary.length === 1
      && releasedLibrary[0].exam_year === 2023
      && releasedLibrary[0].topic === 'Cell structure'
      && releasedLibrary[0].subject_code === 'BIOLOGY');
  await expectError(
    () => asUser(client, studentAuth.id, `select count(*)::int as n from jamb_questions where study_visible`),
    'permission denied',
    'the release flag does not reopen direct browser reads of the private bank'
  );

  const submittedAnswers = attemptItems.map((item, index) => {
    const wrongOption = item.options_snapshot.find((option) => option.id !== item.correct_option_id_snapshot);
    return {
      attempt_item_id: item.id,
      option_id: index === 0 ? wrongOption.id : item.correct_option_id_snapshot,
    };
  });
  const { rows: [saved] } = await client.query(
    `select save_jamb_exam_answers($1, $2, $3::jsonb) as s`,
    [activeAttempt.attempt_id, student.id, JSON.stringify(submittedAnswers)]
  );
  ok('attempt answers save through the server-side RPC', saved.s.saved_count === 4);
  const { rows: [score] } = await client.query(
    `select submit_jamb_exam_attempt($1, $2) as s`, [activeAttempt.attempt_id, student.id]
  );
  ok('server-side grading returns 75 percent and three correct',
    score.s.status === 'SUBMITTED' && score.s.correct_count === 3 && Number(score.s.score) === 75);
  await expectError(
    () => asUser(client, studentAuth.id, `select count(*)::int as n from jamb_exam_attempt_items`),
    'permission denied',
    'students cannot read private attempt/correct-answer snapshots directly'
  );

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
