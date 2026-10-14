/**
 * End-to-end test of the frontend lecturer workflow + ID-card download routes
 * on the DEPLOYED gateway (src/gateway/app.js).
 *
 * Only the network is stubbed: Supabase Auth, PostgREST + RPC dispatch, and
 * Storage. Everything else — JWT-less auth flow, role checks, course-scope
 * checks, validation, multer uploads, rate limiting, the PDF download and the
 * approval wiring — is the real production code exercised over real HTTP.
 *
 * SQL behaviour of the review functions is verified against a real database
 * in scripts/test-frontend-lecturer-schema.mjs; this file verifies the
 * gateway wiring and authorisation contract.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

process.env.SKIP_ENV_VALIDATION = 'true';
const { createProvider } = await import('../src/gateway/providers/index.js');
const { createSupabase } = await import('../src/gateway/supabase.js');
const { createAuth } = await import('../src/gateway/auth.js');
const { createApp } = await import('../src/gateway/app.js');

const SUPABASE_URL = 'https://stub.supabase.co';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const INSTRUCTOR_ID = '22222222-2222-4222-8222-222222222222';
const OUTSIDER_ID = '33333333-3333-4333-8333-333333333333';
const STUDENT_ID = '44444444-4444-4444-8444-444444444444';
const REVOKED_STUDENT_ID = '55555555-5555-4555-8555-555555555555';
const MISSING_PHOTO_STUDENT_ID = '66666666-6666-4666-8666-666666666666';
const NO_CARD_STUDENT_ID = '77777777-7777-4777-8777-777777777777';
const COURSE_ID = '88888888-8888-4888-8888-888888888888';
const COURSE2_ID = '99999999-9999-4999-8999-999999999999';
const MODULE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ASG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CARD_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const TOKENS = {
  'admin-jwt': ADMIN_ID,
  'instructor-jwt': INSTRUCTOR_ID,
  'outsider-jwt': OUTSIDER_ID,
  'student-jwt': STUDENT_ID,
  'revoked-jwt': REVOKED_STUDENT_ID,
  'missingphoto-jwt': MISSING_PHOTO_STUDENT_ID,
  'nocard-jwt': NO_CARD_STUDENT_ID,
};

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=',
  'base64'
);

// --------------------------------------------------------------- in-memory DB
const db = {
  profiles: [
    { id: ADMIN_ID, full_name: 'Site Admin', email: 'admin@danqel.test', role: 'admin', avatar_url: null },
    { id: INSTRUCTOR_ID, full_name: 'Lee Lecturer', email: 'lee@danqel.test', role: 'instructor', avatar_url: null },
    { id: OUTSIDER_ID, full_name: 'Outsider Lecturer', email: 'out@danqel.test', role: 'instructor', avatar_url: null },
    { id: STUDENT_ID, full_name: 'Ada Student', email: 'ada@danqel.test', role: 'student', avatar_url: `${STUDENT_ID}/avatar.png` },
    { id: REVOKED_STUDENT_ID, full_name: 'Rob Revoked', email: 'rob@danqel.test', role: 'student', avatar_url: `${REVOKED_STUDENT_ID}/avatar.png` },
    { id: MISSING_PHOTO_STUDENT_ID, full_name: 'Mia Missing', email: 'mia@danqel.test', role: 'student', avatar_url: `${MISSING_PHOTO_STUDENT_ID}/avatar.png` },
    { id: NO_CARD_STUDENT_ID, full_name: 'Noel New', email: 'noel@danqel.test', role: 'student', avatar_url: null },
  ],
  courses: [
    { id: COURSE_ID, title: 'Web Development', slug: 'web-dev', published: true, archived: false, category: 'Web Development', level: 'Beginner' },
    { id: COURSE2_ID, title: 'Data Science', slug: 'data-science', published: false, archived: false, category: 'Data', level: 'Advanced' },
  ],
  course_modules: [
    { id: MODULE_ID, course_id: COURSE_ID, title: 'Getting started', position: 0, status: 'published', archived: false },
  ],
  course_lessons: [],
  lecturer_course_assignments: [],
  enrollments: [
    { id: randomUUID(), course_id: COURSE_ID, user_id: STUDENT_ID, status: 'active', enrolled_at: '2026-10-02T09:00:00Z' },
  ],
  assignments: [
    { id: ASG_ID, course_id: COURSE_ID, title: 'Build a landing page', max_score: 100, status: 'published' },
  ],
  assignment_submissions: [
    {
      id: SUB_ID, assignment_id: ASG_ID, course_id: COURSE_ID, user_id: STUDENT_ID,
      status: 'submitted', score: null, feedback: null, kind: 'link', file_name: null,
      submitted_at: '2026-10-05T08:00:00Z', reviewed_at: null,
    },
  ],
  student_id_cards: [
    {
      id: CARD_ID, user_id: STUDENT_ID, card_number: 'WDTH-2026-000123', full_name: 'Ada Student',
      photo_path: `${STUDENT_ID}/avatar.png`, programme: 'Digital Skills',
      issued_at: '2026-10-01T10:00:00.000Z', status: 'active',
    },
    {
      id: randomUUID(), user_id: REVOKED_STUDENT_ID, card_number: 'WDTH-2026-000124', full_name: 'Rob Revoked',
      photo_path: `${REVOKED_STUDENT_ID}/avatar.png`, programme: 'Digital Skills',
      issued_at: '2026-09-01T10:00:00.000Z', status: 'revoked',
    },
    {
      id: randomUUID(), user_id: MISSING_PHOTO_STUDENT_ID, card_number: 'WDTH-2026-000125', full_name: 'Mia Missing',
      photo_path: `${MISSING_PHOTO_STUDENT_ID}/avatar.png`, programme: 'Digital Skills',
      issued_at: '2026-10-03T10:00:00.000Z', status: 'active',
    },
  ],
  lecturer_content_revisions: [],
  lecturer_grade_reviews: [],
};

const storageFiles = new Map([[`${STUDENT_ID}/avatar.png`, PIXEL_PNG]]); // Mia's photo intentionally absent
const patchedRows = [];

// -------------------------------------------------------------- stub plumbing
function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => body.buffer,
  };
}

const EMBEDS = {
  lecturer_course_assignments: (row) => ({ ...row, courses: db.courses.find((c) => c.id === row.course_id) || null }),
  enrollments: (row) => ({ ...row, profiles: db.profiles.find((p) => p.id === row.user_id) || null }),
  assignment_submissions: (row) => ({
    ...row,
    assignments: db.assignments.find((a) => a.id === row.assignment_id) || null,
    profiles: db.profiles.find((p) => p.id === row.user_id) || null,
  }),
};

function applyFilters(rows, params) {
  let out = [...rows];
  for (const [key, value] of params.entries()) {
    if (['select', 'order', 'limit'].includes(key)) continue;
    const [raw, op] = [key, String(value)];
    if (op.startsWith('eq.')) {
      let v = op.slice(3);
      if (v === 'true') v = true;
      if (v === 'false') v = false;
      out = out.filter((r) => r[raw] === v || String(r[raw]) === String(v));
    } else if (op.startsWith('in.(')) {
      const list = op.slice(4, -1).split(',');
      out = out.filter((r) => list.includes(String(r[raw])));
    }
  }
  return out;
}

const rpcs = {
  admin_upsert_lecturer_assignment(args) {
    const lecturer = db.profiles.find((p) => p.id === args.p_lecturer_id);
    if (!lecturer) return { status: 400, body: { message: 'Lecturer account not found' } };
    if (lecturer.role !== 'instructor') return { status: 400, body: { message: `That user is not a lecturer (role: ${lecturer.role})` } };
    if (!db.courses.some((c) => c.id === args.p_course_id)) return { status: 400, body: { message: 'Course not found' } };
    let row = db.lecturer_course_assignments.find((a) => a.lecturer_id === args.p_lecturer_id && a.course_id === args.p_course_id);
    if (!row) {
      row = { id: randomUUID(), lecturer_id: args.p_lecturer_id, course_id: args.p_course_id, created_at: new Date().toISOString(), assigned_by: 'admin@danqel.test' };
      db.lecturer_course_assignments.push(row);
    }
    return { status: 200, body: { id: row.id, lecturerId: row.lecturer_id, courseId: row.course_id, createdAt: row.created_at } };
  },
  admin_remove_lecturer_assignment(args) {
    const before = db.lecturer_course_assignments.length;
    db.lecturer_course_assignments = db.lecturer_course_assignments.filter(
      (a) => !(a.lecturer_id === args.p_lecturer_id && a.course_id === args.p_course_id)
    );
    return { status: 200, body: { ok: true, removed: before - db.lecturer_course_assignments.length } };
  },
  lecturer_save_content_draft(args) {
    if (!args.p_title || !String(args.p_title).trim()) return { status: 400, body: { message: 'A title is required' } };
    const assigned = db.lecturer_course_assignments.some((a) => a.course_id === args.p_course_id && a.lecturer_id === rpcs.__lecturer);
    if (!assigned) return { status: 400, body: { message: 'You are not assigned to this course' } };
    let row;
    if (args.p_revision_id) {
      row = db.lecturer_content_revisions.find((r) => r.id === args.p_revision_id);
      if (!row) return { status: 400, body: { message: 'Draft not found' } };
      if (!['draft', 'changes_requested'].includes(row.status)) return { status: 400, body: { message: `Only drafts can be edited (current status: ${row.status})` } };
      Object.assign(row, {
        kind: args.p_kind, course_id: args.p_course_id, module_id: args.p_module_id, lesson_id: args.p_lesson_id,
        target_id: args.p_target_id, title: args.p_title, payload: args.p_payload, updated_at: new Date().toISOString(),
      });
    } else {
      row = {
        id: randomUUID(), kind: args.p_kind, course_id: args.p_course_id, module_id: args.p_module_id,
        lesson_id: args.p_lesson_id, target_id: args.p_target_id, lecturer_id: rpcs.__lecturer,
        title: args.p_title, payload: args.p_payload, status: 'draft', version: 1,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), submitted_at: null,
      };
      db.lecturer_content_revisions.push(row);
    }
    return { status: 200, body: { id: row.id, kind: row.kind, courseId: row.course_id, title: row.title, status: row.status, version: row.version, updatedAt: row.updated_at } };
  },
  lecturer_submit_content_for_review(args) {
    const row = db.lecturer_content_revisions.find((r) => r.id === args.p_revision_id);
    if (!row) return { status: 400, body: { message: 'Draft not found' } };
    if (!['draft', 'changes_requested'].includes(row.status)) return { status: 400, body: { message: `Only drafts or requested changes can be submitted (current status: ${row.status})` } };
    row.status = 'pending_approval';
    row.submitted_at = new Date().toISOString();
    return { status: 200, body: { id: row.id, status: row.status, version: row.version, submittedAt: row.submitted_at } };
  },
  admin_review_content_approval(args) {
    const row = db.lecturer_content_revisions.find((r) => r.id === args.p_revision_id);
    if (!row) return { status: 400, body: { message: 'Review item not found' } };
    if (row.status !== 'pending_approval') return { status: 400, body: { message: `This item has already been reviewed (status: ${row.status})` } };
    if (args.p_action !== 'approved' && !String(args.p_notes || '').trim()) return { status: 400, body: { message: 'A reason is required when rejecting or requesting changes' } };
    let targetTable = null;
    let targetId = null;
    if (args.p_action === 'approved') {
      if (row.kind === 'module_create') {
        targetId = randomUUID();
        targetTable = 'course_modules';
        db.course_modules.push({ id: targetId, course_id: row.course_id, title: row.title, position: 1, status: 'published', archived: false });
      } else if (row.kind.startsWith('lesson')) {
        targetId = randomUUID();
        targetTable = 'course_lessons';
        db.course_lessons.push({ id: targetId, course_id: row.course_id, module_id: row.module_id, title: row.title, status: 'published', archived: false, resources: row.payload?.resources || [] });
      } else if (row.kind.startsWith('quiz')) {
        targetId = randomUUID();
        targetTable = 'quizzes';
      } else if (row.kind.startsWith('assignment')) {
        targetId = randomUUID();
        targetTable = 'assignments';
      }
    }
    row.status = args.p_action;
    row.review_notes = args.p_notes || null;
    row.reviewed_by = ADMIN_ID;
    row.reviewed_at = new Date().toISOString();
    return { status: 200, body: { ok: true, action: args.p_action, revisionId: row.id, targetTable, targetId } };
  },
  lecturer_submit_grade_for_review(args) {
    const sub = db.assignment_submissions.find((s) => s.id === args.p_submission_id);
    if (!sub) return { status: 400, body: { message: 'Submission not found' } };
    if (args.p_decision === 'approved' && args.p_score == null) return { status: 400, body: { message: 'A score is required to approve work' } };
    let row = db.lecturer_grade_reviews.find((g) => g.assignment_id === sub.assignment_id && g.student_id === sub.user_id && g.lecturer_id === rpcs.__lecturer);
    if (!row) {
      row = { id: randomUUID(), assignment_id: sub.assignment_id, student_id: sub.user_id, lecturer_id: rpcs.__lecturer, version: 1, created_at: new Date().toISOString() };
      db.lecturer_grade_reviews.push(row);
    }
    Object.assign(row, {
      submission_id: sub.id, course_id: sub.course_id, decision: args.p_decision, score: args.p_score,
      feedback: args.p_feedback, status: 'pending_approval', submitted_at: new Date().toISOString(),
      prev_values: { status: sub.status, score: sub.score, feedback: sub.feedback },
    });
    return { status: 200, body: { id: row.id, status: row.status, decision: row.decision, score: row.score, version: row.version, submittedAt: row.submitted_at } };
  },
  admin_review_grade_approval(args) {
    const row = db.lecturer_grade_reviews.find((g) => g.id === args.p_grading_id);
    if (!row) return { status: 400, body: { message: 'Review item not found' } };
    if (row.status !== 'pending_approval') return { status: 400, body: { message: `This grade has already been reviewed (status: ${row.status})` } };
    if (args.p_action !== 'approved' && !String(args.p_notes || '').trim()) return { status: 400, body: { message: 'A reason is required when rejecting or requesting changes' } };
    let released = false;
    if (args.p_action === 'approved') {
      released = true;
      row.status = 'released';
      const sub = db.assignment_submissions.find((s) => s.id === row.submission_id);
      if (sub) {
        Object.assign(sub, { status: row.decision, score: row.score, feedback: row.feedback, reviewed_by: 'admin@danqel.test', reviewed_at: new Date().toISOString() });
      }
    } else {
      row.status = args.p_action;
    }
    row.review_notes = args.p_notes || null;
    return { status: 200, body: { ok: true, action: args.p_action, gradingId: row.id, released } };
  },
};

let currentLecturer = null;

async function stubFetch(url, opts = {}) {
  const target = String(url);
  const bearer = (opts.headers?.Authorization || '').replace('Bearer ', '');
  const u = new URL(target);

  // ---- Supabase Auth ----
  if (target.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
    const id = TOKENS[bearer];
    if (!id) return jsonResponse(401, { error: 'invalid_token' });
    return jsonResponse(200, { id, email: `${id}@example.com`, role: 'authenticated' });
  }

  // ---- Storage ----
  if (target.startsWith(`${SUPABASE_URL}/storage/v1/object/`)) {
    const rest = target.slice(`${SUPABASE_URL}/storage/v1/object/`.length);
    const [bucket, ...segments] = rest.split('/');
    const path = segments.map(decodeURIComponent).join('/');
    if (opts.method === 'GET' || !opts.method) {
      if (bucket === 'avatars' && storageFiles.has(path)) return jsonResponse(200, storageFiles.get(path), { 'content-type': 'image/png' });
      if (storageFiles.has(`${bucket}/${path}`)) return jsonResponse(200, storageFiles.get(`${bucket}/${path}`));
      return jsonResponse(404, { message: 'Object not found' });
    }
    if (opts.method === 'POST') {
      storageFiles.set(`${bucket}/${path}`, Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body || ''));
      return jsonResponse(200, { Key: `${bucket}/${path}` });
    }
    return jsonResponse(405, {});
  }

  // ---- RPC ----
  if (target.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) {
    const name = target.slice(`${SUPABASE_URL}/rest/v1/rpc/`.length);
    const args = opts.body ? JSON.parse(opts.body) : {};
    const handler = rpcs[name];
    if (!handler) return jsonResponse(404, { message: `function ${name} is not mocked` });
    const result = handler(args);
    return jsonResponse(result.status, result.body);
  }

  // ---- PostgREST reads / updates ----
  if (target.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
    const table = target.slice(`${SUPABASE_URL}/rest/v1/`.length).split('?')[0];

    if (opts.method === 'PATCH') {
      const rows = applyFilters(db[table] || [], u.searchParams);
      const patch = JSON.parse(opts.body || '{}');
      for (const row of rows) {
        Object.assign(row, patch);
        patchedRows.push({ table, id: row.id, patch });
      }
      return jsonResponse(200, rows);
    }

    if (table === 'profiles' && u.searchParams.get('role') === 'eq.instructor') {
      return jsonResponse(200, db.profiles.filter((p) => p.role === 'instructor'));
    }
    let rows = applyFilters(db[table] || [], u.searchParams);
    const embed = EMBEDS[table];
    if (embed) rows = rows.map(embed);
    return jsonResponse(200, rows);
  }

  return jsonResponse(404, { message: `unmocked ${target}` });
}

// ---------------------------------------------------------------- test runner
let passed = 0;
function ok(name, cond = true) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function section(title) {
  console.log(`\n${title}`);
}

const stubConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'test',
  baseUrl: '',
  maxTokens: 100,
  temperature: 0.7,
  aiTimeoutMs: 5000,
  maxRetries: 2,
  supabaseUrl: SUPABASE_URL,
  supabaseServiceRoleKey: 'service-key',
  allowedOrigins: ['https://frontend.test'],
  chatRateLimit: 30,
  generateRateLimit: 10,
  downloadRateLimit: 30,
  lecturerRateLimit: 30,
  rateWindowMs: 60000,
  maxMessageChars: 4000,
  maxHistory: 12,
  ragMaxDocs: 6,
  ragMaxCharsPerDoc: 2000,
};

const supabase = createSupabase({ url: SUPABASE_URL, serviceKey: 'service-key', fetchImpl: stubFetch });
const auth = createAuth({ supabaseUrl: SUPABASE_URL, serviceKey: 'service-key', supabase, fetchImpl: stubFetch });
const app = createApp({
  config: stubConfig,
  provider: createProvider(stubConfig, { fetchImpl: stubFetch }),
  supabase,
  auth,
  logger: { info() {}, warn() {}, error() {} },
});
const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: payload });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* pdf bodies */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
}

function markLecturer() {
  // RPCs in the real DB see auth.uid(); the gateway already gates them by
  // role + assignment, so the mock attributes writes to the active lecturer.
  rpcs.__lecturer = currentLecturer;
}

try {
  section('[1/8] Authentication & role gates');
  {
    const res = await call('GET', '/api/lecturer/inbox');
    ok('inbox without a token returns 401', res.status === 401);
  }
  {
    const res = await call('GET', '/api/lecturer/inbox', { token: 'student-jwt' });
    ok('students cannot open the lecturer inbox', res.status === 403 && res.json.error.code === 'FORBIDDEN_ROLE');
  }
  {
    const res = await call('GET', '/api/admin/lecturers', { token: 'instructor-jwt' });
    ok('lecturers cannot open admin lecturer management', res.status === 403);
  }
  {
    const res = await call('GET', '/api/admin/students/11111111-1111-4111-8111-111111111111/id-card/download', { token: 'student-jwt', raw: true });
    ok('students cannot use the admin ID-card download', res.status === 403);
    res.body?.cancel?.();
  }

  section('[2/8] Admin assigns a course to the lecturer');
  {
    currentLecturer = ADMIN_ID; markLecturer();
    const res = await call('POST', `/api/admin/lecturers/${INSTRUCTOR_ID}/courses`, {
      token: 'admin-jwt',
      body: { courseId: COURSE_ID },
    });
    ok('admin assigns the course', res.status === 201 && res.json.success);
    ok('assignment response carries both ids', res.json.data.assignment.courseId === COURSE_ID && res.json.data.assignment.lecturerId === INSTRUCTOR_ID);
  }
  {
    const res = await call('POST', `/api/admin/lecturers/${STUDENT_ID}/courses`, {
      token: 'admin-jwt',
      body: { courseId: COURSE_ID },
    });
    ok('assigning a non-lecturer account fails', res.status === 400);
  }
  {
    const res = await call('GET', '/api/admin/lecturers', { token: 'admin-jwt' });
    const lee = res.json.data.lecturers.find((l) => l.id === INSTRUCTOR_ID);
    ok('lecturer list shows the assigned course', lee?.courses?.[0]?.title === 'Web Development');
  }
  {
    const res = await call('POST', '/api/admin/lecturers/not-a-uuid/courses', {
      token: 'admin-jwt',
      body: { courseId: COURSE_ID },
    });
    ok('invalid lecturer id rejected before hitting the database', res.status === 400 && res.json.error.code === 'INVALID_ID');
  }

  section('[3/8] Lecturer sees assigned work; outsiders stay locked out');
  {
    currentLecturer = INSTRUCTOR_ID; markLecturer();
    const res = await call('GET', '/api/lecturer/inbox', { token: 'instructor-jwt' });
    ok('inbox returns the assigned course', res.status === 200 && res.json.data.courses.length === 1);
    ok('course includes title and slug', res.json.data.courses[0].title === 'Web Development' && res.json.data.courses[0].slug === 'web-dev');
    ok('enrolled students are listed for the course', res.json.data.students.some((s) => s.profiles?.full_name === 'Ada Student'));
    ok('the awaiting submission appears', res.json.data.submissions.some((s) => s.id === SUB_ID && s.status === 'submitted'));
    const outsider = await call('GET', '/api/lecturer/inbox', { token: 'outsider-jwt' });
    ok('a lecturer with no assignments sees no courses', outsider.status === 200 && outsider.json.data.courses.length === 0);
  }

  section('[4/8] Content drafting with mandatory review');
  let revisionId;
  {
    currentLecturer = INSTRUCTOR_ID; markLecturer();
    const res = await call('POST', '/api/lecturer/content', {
      token: 'instructor-jwt',
      body: { kind: 'module_create', courseId: COURSE_ID, title: 'Module 2: React Foundations', payload: { title: 'Module 2: React Foundations' } },
    });
    ok('draft saved for an assigned course', res.status === 201 && res.json.data.revision.status === 'draft');
    ok('save reports it is NOT submitted', res.json.data.submitted === false);
    revisionId = res.json.data.revision.id;
  }
  {
    const res = await call('POST', '/api/lecturer/content', {
      token: 'outsider-jwt',
      body: { kind: 'module_create', courseId: COURSE_ID, title: 'Sneaky module', payload: {} },
    });
    ok('an unassigned lecturer cannot draft for the course', res.status === 403 && res.json.error.code === 'COURSE_NOT_ASSIGNED');
  }
  {
    const res = await call('POST', '/api/lecturer/content', {
      token: 'instructor-jwt',
      body: { kind: 'not_a_real_kind', courseId: COURSE_ID, title: 'x', payload: {} },
    });
    ok('malformed payloads fail validation with 400', res.status === 400);
  }
  {
    const res = await call('POST', '/api/lecturer/content', {
      token: 'instructor-jwt',
      body: { kind: 'module_update', courseId: COURSE_ID, title: 'Rename module', payload: {} },
    });
    ok('update requires a targetId', res.status === 400 && /targetId/i.test(res.text));
  }
  {
    const res = await call('POST', '/api/lecturer/content', {
      token: 'instructor-jwt',
      body: {
        kind: 'quiz_create', courseId: COURSE_ID, title: 'Hooks quiz', submit: true,
        payload: {
          passing_score: 70,
          questions: [
            { type: 'multiple_choice', question: 'useState returns…?', options: ['value+setter', 'node'], correct_answer: 0 },
            { type: 'short_answer', question: 'Name the setter', accepted_answers: ['setter'] },
          ],
        },
      },
    });
    ok('a quiz draft can be saved AND submitted in one call', res.status === 201 && res.json.data.revision.status === 'pending_approval');
    revisionId = res.json.data.revision.id;
  }

  section('[5/8] Admin moderation queue publishes the exact submission');
  {
    currentLecturer = ADMIN_ID; markLecturer();
    const res = await call('GET', '/api/admin/reviews', { token: 'admin-jwt' });
    const item = res.json.data.content.find((r) => r.id === revisionId);
    ok('pending revision appears in the queue', Boolean(item));
    ok('queue enriches with course and lecturer context', item.course?.title === 'Web Development' && item.lecturer?.full_name === 'Lee Lecturer');
  }
  {
    const res = await call('POST', `/api/admin/reviews/${revisionId}/decision`, {
      token: 'admin-jwt',
      body: { decision: 'reject' },
    });
    ok('rejecting without a reason is refused', res.status === 400);
  }
  {
    const res = await call('POST', `/api/admin/reviews/${revisionId}/decision`, {
      token: 'admin-jwt',
      body: { decision: 'request_changes', notes: 'Add a true/false question' },
    });
    ok('changes can be requested with a reason', res.status === 200 && res.json.data.result.action === 'changes_requested');
    const row = db.lecturer_content_revisions.find((r) => r.id === revisionId);
    ok('revision returns to the lecturer as changes_requested', row.status === 'changes_requested');
  }
  {
    currentLecturer = INSTRUCTOR_ID; markLecturer();
    const res = await call('POST', '/api/lecturer/content', {
      token: 'instructor-jwt',
      body: {
        revisionId, submit: true, kind: 'quiz_create', courseId: COURSE_ID, title: 'Hooks quiz (v2)',
        payload: { questions: [{ type: 'true_false', question: 'Hooks run at the top level', correct_answer: 0 }] },
      },
    });
    ok('lecturer revises and resubmits', res.status === 201 && res.json.data.revision.status === 'pending_approval');
  }
  {
    currentLecturer = ADMIN_ID; markLecturer();
    const res = await call('POST', `/api/admin/reviews/${revisionId}/decision`, {
      token: 'admin-jwt',
      body: { decision: 'approve' },
    });
    ok('approval publishes and returns the target', res.status === 200 && res.json.data.result.action === 'approved' && res.json.data.result.targetTable === 'quizzes');
    const again = await call('POST', `/api/admin/reviews/${revisionId}/decision`, {
      token: 'admin-jwt',
      body: { decision: 'approve' },
    });
    ok('double approval is rejected by the database function', again.status === 400 && /already been reviewed/i.test(again.text));
  }

  section('[6/8] File upload + promotion to the live bucket');
  {
    currentLecturer = INSTRUCTOR_ID; markLecturer();
    const form = new FormData();
    form.append('kind', 'lesson_create');
    form.append('courseId', COURSE_ID);
    form.append('moduleId', MODULE_ID);
    form.append('title', 'Lesson: JSX deep dive');
    form.append('submit', 'true');
    form.append('payload', JSON.stringify({ type: 'text', content: '# JSX\n\nEverything is an expression.' }));
    form.append('file', new Blob([Buffer.from('%PDF-1.4 demo')], { type: 'application/pdf' }), 'handout.pdf');
    const res = await call('POST', '/api/lecturer/content', { token: 'instructor-jwt', body: form });
    ok('multipart draft with a file is accepted', res.status === 201 && res.json.data.revision.status === 'pending_approval');
    const row = db.lecturer_content_revisions.find((r) => r.id === res.json.data.revision.id);
    ok('the file landed in the PRIVATE pending bucket', typeof row.payload.file?.path === 'string' && storageFiles.has(`resources-pending/${row.payload.file.path}`));
    ok('pending file path is namespaced to the lecturer', row.payload.file.path.startsWith(`${INSTRUCTOR_ID}/`));
    revisionId = res.json.data.revision.id;
  }
  {
    currentLecturer = ADMIN_ID; markLecturer();
    const before = patchedRows.length;
    const res = await call('POST', `/api/admin/reviews/${revisionId}/decision`, {
      token: 'admin-jwt',
      body: { decision: 'approve' },
    });
    ok('lesson with file approves cleanly', res.status === 200);
    const target = res.json.data.result.targetId;
    const liveKey = `resources/${COURSE_ID}/${target}/handout.pdf`;
    ok('approved file is copied to the live course bucket', storageFiles.has(liveKey));
    ok('published lesson row was patched with the live resource', patchedRows.slice(before).some((p) => p.table === 'course_lessons' && p.id === target));
    ok('response reports the file promotion', res.json.data.file?.livePath === `${COURSE_ID}/${target}/handout.pdf`);
  }

  section('[7/8] Grades wait for admin release');
  let gradingId;
  {
    currentLecturer = INSTRUCTOR_ID; markLecturer();
    const res = await call('POST', '/api/lecturer/grades', {
      token: 'instructor-jwt',
      body: { submissionId: SUB_ID, decision: 'approved' },
    });
    ok('approving without a score is refused', res.status === 400);
  }
  {
    const res = await call('POST', '/api/lecturer/grades', {
      token: 'instructor-jwt',
      body: { submissionId: SUB_ID, decision: 'approved', score: 92, feedback: 'Excellent structure.' },
    });
    ok('grade proposed for review', res.status === 201 && res.json.data.review.status === 'pending_approval');
    gradingId = res.json.data.review.id;
    const sub = db.assignment_submissions.find((s) => s.id === SUB_ID);
    ok('pending grade does NOT touch the student-facing submission', sub.status === 'submitted' && sub.score === null);
  }
  {
    currentLecturer = ADMIN_ID; markLecturer();
    const queue = await call('GET', '/api/admin/reviews', { token: 'admin-jwt' });
    const item = queue.json.data.grades.find((g) => g.id === gradingId);
    ok('grade appears in the admin queue with student context', item?.student?.full_name === 'Ada Student' && item?.assignment?.title === 'Build a landing page');
    const released = await call('POST', `/api/admin/grade-reviews/${gradingId}/decision`, {
      token: 'admin-jwt',
      body: { decision: 'approve' },
    });
    ok('admin releases the grade', released.status === 200 && released.json.data.result.released === true);
    const sub = db.assignment_submissions.find((s) => s.id === SUB_ID);
    ok('release updates the submission exactly once', sub.status === 'approved' && sub.score === 92 && sub.feedback === 'Excellent structure.');
  }
  {
    const res = await call('POST', '/api/lecturer/grades', {
      token: 'outsider-jwt',
      body: { submissionId: SUB_ID, decision: 'approved', score: 10 },
    });
    ok('outsider lecturers cannot grade the course', res.status === 403 && res.json.error.code === 'COURSE_NOT_ASSIGNED');
  }

  section('[8/8] Student ID card downloads');
  {
    const res = await call('GET', '/api/students/me/id-card/download', { token: 'student-jwt', raw: true });
    const buf = Buffer.from(await res.arrayBuffer());
    ok('download returns a PDF', res.status === 200 && res.headers.get('content-type') === 'application/pdf');
    ok('PDF opens (header + EOF markers)', buf.subarray(0, 8).toString('latin1').startsWith('%PDF-') && buf.includes('%%EOF'));
    const disposition = res.headers.get('content-disposition') || '';
    ok('browser gets an attachment filename with the card number', disposition.includes('attachment') && disposition.includes('WDTH-2026-000123'));
    ok('response is not publicly cacheable', (res.headers.get('cache-control') || '').includes('no-store'));
    ok('a real binary payload was delivered', buf.length > 1000);
  }
  {
    const res = await call('GET', `/api/admin/students/${STUDENT_ID}/id-card/download`, { token: 'admin-jwt', raw: true });
    ok('admins can download a student card for printing', res.status === 200 && res.headers.get('content-type') === 'application/pdf');
    res.body?.cancel?.();
  }
  {
    const res = await call('GET', '/api/students/me/id-card/download', { token: 'nocard-jwt' });
    ok('students without an issued card get a clear 404', res.status === 404 && res.json.error.code === 'ID_CARD_NOT_FOUND');
  }
  {
    const res = await call('GET', '/api/students/me/id-card/download', { token: 'revoked-jwt' });
    ok('revoked cards cannot be downloaded', res.status === 410 && res.json.error.code === 'ID_CARD_REVOKED');
  }
  {
    const res = await call('GET', '/api/students/me/id-card/download', { token: 'missingphoto-jwt' });
    ok('a missing photo is reported instead of a corrupt PDF', res.status === 409 && res.json.error.code === 'CARD_PHOTO_UNAVAILABLE');
  }

  console.log(`\n✓ frontend lecturer workflow + ID card gateway: ${passed} checks passed`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
