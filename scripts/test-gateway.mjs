/**
 * End-to-end test of the WOLI DAN TECH HUB Secure AI Gateway.
 *
 * ONLY the network is stubbed (Supabase Auth, PostgREST and the LLM API).
 * Everything else — auth middleware, role lookup, RAG, integrity guard, rate
 * limiting, provider request building, JSON parsing and the zod contracts —
 * is the real production code, exercised over real HTTP.
 *
 * Usage: node scripts/test-gateway.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// The test supplies its own config object, so skip env validation on import.
process.env.SKIP_ENV_VALIDATION = 'true';
const { createProvider } = await import('../src/gateway/providers/index.js');
const { createSupabase } = await import('../src/gateway/supabase.js');
const { createAuth } = await import('../src/gateway/auth.js');
const { createApp } = await import('../src/gateway/app.js');

const SUPABASE_URL = 'https://stub.supabase.co';
const ADMIN_TOKEN = 'admin-jwt';
const STUDENT_TOKEN = 'student-jwt';
const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const STUDENT_ID = '22222222-2222-2222-2222-222222222222';
const COURSE_ID = '33333333-3333-3333-3333-333333333333';
const LESSON_ID = '44444444-4444-4444-4444-444444444444';

let passed = 0;
let failed = 0;
function ok(name, cond = true) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function section(title) {
  console.log(`\n${title}`);
}

// ------------------------------------------------------------------ fixtures
/** Valid payloads for EVERY kind — must satisfy the frontend contract. */
const FIXTURES = {
  course_outline: {
    title: 'React for Nigerian Freelancers',
    description: 'A practical, project-based React course that takes you from components to paid client work.',
    category: 'Web Development',
    duration: '8 weeks',
    level: 'Beginner',
    learningObjectives: ['Build reusable React components', 'Manage state with hooks', 'Ship a portfolio project'],
    modules: [
      {
        title: 'Foundations',
        summary: 'Components, props and JSX.',
        practical: 'Rebuild the class attendance card component.',
        lessons: [
          { title: 'What React actually solves', description: 'Why components beat copy-paste HTML.', duration: '15:00', keyConcepts: ['Components', 'JSX', 'Props'] },
        ],
        quiz: { passingScore: 70 },
      },
    ],
    finalProject: 'Build and deploy a client-ready business website.',
  },
  lesson_text: { markdown: '# useState\n\n**Level:** Beginner\n\n## What you will learn\n\n- State basics\n\n> [!TIP] Save your work.' },
  summary: { markdown: '# Summary\n\n- Big idea\n- Next step' },
  notes: { markdown: '# 📝 Revision Notes: useState\n\n## Key points\n\n- State lives in the component' },
  quiz: {
    title: 'useState Quiz',
    passingScore: 70,
    questions: [
      { type: 'multiple_choice', question: 'What does useState return?', options: ['A value and a setter', 'A DOM node', 'A promise', 'Nothing'], correctAnswer: 0, explanation: 'useState returns [value, setValue].' },
      { type: 'true_false', question: 'Mutating state directly re-renders the component.', options: ['True', 'False'], correctAnswer: 1, explanation: 'You must call the setter.' },
      { type: 'multiple_answer', question: 'Which are valid hook rules?', options: ['Call at top level', 'Call inside loops', 'Call in components'], correctAnswers: [0, 2], explanation: 'Never call hooks in loops.' },
      { type: 'short_answer', question: 'Name the function used to update state.', acceptedAnswers: ['setter', 'setState', 'setValue'], explanation: 'The second element of the array.' },
    ],
  },
  assignment: {
    title: 'Practical: Build a counter',
    description: 'Apply useState to build an interactive counter.',
    instructions: '1. Create the component\n2. Add the state\n3. Wire the buttons',
    requiredOutput: 'One working counter component.',
  },
  exercise: { title: 'Counter exercise', steps: ['Create component', 'Add state', 'Add buttons'], deliverable: 'Working counter', estimatedMinutes: 20, level: 'Beginner' },
  flashcards: { title: 'useState Flashcards', cards: [{ front: 'What is state?', back: 'Data a component remembers between renders.' }] },
  video_script: {
    title: 'useState — Video Script',
    voice: { gender: 'female', language: 'en', speed: 1, style: 'friendly coach' },
    estimatedWords: 1300,
    scenes: [{ time: '0:00', visual: 'Title card', narration: 'Welcome! Today we master useState.' }],
    subtitles: '[00:00] Welcome!',
  },
  voiceover: {
    title: 'useState — Voiceover',
    voice: { gender: 'male', language: 'en', speed: 1.1, style: 'calm teacher' },
    estimatedWords: 900,
    scenes: [{ time: '0:00', visual: 'Screen demo', narration: 'Let us look at state together.' }],
  },
};

const LESSON_ROWS = [
  {
    id: LESSON_ID,
    title: 'Understanding useState',
    duration: '15:00',
    position: 1,
    module_id: 'm1',
    course_id: COURSE_ID,
    course_modules: { title: 'Module 1: React Foundations' },
    course_content: { body_markdown: '# Understanding useState\n\nState is data a component remembers between renders. Call the setter to trigger a re-render. Never mutate state directly.' },
    courses: { id: COURSE_ID, title: 'React for Nigerian Freelancers', slug: 'react-freelancers', level: 'Beginner', category: 'Web Development' },
  },
  {
    id: '55555555-5555-5555-5555-555555555555',
    title: 'Props and composition',
    duration: '12:00',
    position: 2,
    module_id: 'm1',
    course_id: COURSE_ID,
    course_modules: { title: 'Module 1: React Foundations' },
    course_content: { body_markdown: '# Props\n\nProps are inputs passed from a parent component.' },
    courses: { id: COURSE_ID, title: 'React for Nigerian Freelancers', slug: 'react-freelancers', level: 'Beginner', category: 'Web Development' },
  },
];

// -------------------------------------------------------------- stub network
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let llmBehaviour = 'ok'; // 'ok' | 'garbage' | 'http500'
let llmCalls = 0;

async function stubFetch(url, opts = {}) {
  const target = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  const bearer = (opts.headers?.Authorization || '').replace('Bearer ', '');

  // ---- Supabase Auth: token verification ----
  if (target.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
    if (bearer === ADMIN_TOKEN) return jsonResponse(200, { id: ADMIN_ID, email: 'wolidantech@gmail.com', role: 'authenticated' });
    if (bearer === STUDENT_TOKEN) return jsonResponse(200, { id: STUDENT_ID, email: 'student@example.com', role: 'authenticated' });
    return jsonResponse(401, { error: 'invalid_token' });
  }

  // ---- PostgREST: role lookup ----
  if (target.includes('/rest/v1/profiles')) {
    if (target.includes(ADMIN_ID)) return jsonResponse(200, [{ id: ADMIN_ID, full_name: 'Woli Dan', email: 'wolidantech@gmail.com', role: 'admin' }]);
    if (target.includes(STUDENT_ID)) return jsonResponse(200, [{ id: STUDENT_ID, full_name: 'Ada Student', email: 'student@example.com', role: 'student' }]);
    return jsonResponse(200, []);
  }

  // ---- PostgREST: RAG over published lessons ----
  if (target.includes('/rest/v1/course_lessons')) {
    assert.ok(target.includes('courses.published=eq.true'), 'RAG must filter published courses');
    assert.ok(target.includes('courses.archived=eq.false'), 'RAG must exclude archived courses');
    return jsonResponse(200, LESSON_ROWS);
  }

  // ---- LLM ----
  if (target.includes('/chat/completions')) {
    llmCalls += 1;
    if (llmBehaviour === 'http500') return { ok: false, status: 500, json: async () => ({}), text: async () => 'upstream boom' };
    if (llmBehaviour === 'garbage') return jsonResponse(200, { choices: [{ message: { content: 'Sorry, here you go: not json at all' } }] });

    const isChat = !body.response_format;
    if (isChat) {
      return jsonResponse(200, {
        choices: [{ message: { content: '## Understanding useState\n\nState is data a component remembers.\n\n📚 *Based on your course: **Understanding useState***' } }],
      });
    }
    const userMsg = body.messages?.find((m) => m.role === 'user')?.content || '';
    const kind = (userMsg.match(/Create the "([a-z_]+)" asset/) || [])[1];
    const payload = FIXTURES[kind];
    if (!payload) return jsonResponse(200, { choices: [{ message: { content: '{}' } }] });
    return jsonResponse(200, { choices: [{ message: { content: '```json\n' + JSON.stringify(payload) + '\n```' } }] });
  }

  return jsonResponse(404, { error: 'unexpected upstream call', target });
}

// ----------------------------------------------------------------- boot app
const config = {
  nodeEnv: 'test',
  isProduction: false,
  port: 0,
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'test-key',
  baseUrl: '',
  maxTokens: 4000,
  temperature: 0.7,
  aiTimeoutMs: 5000,
  maxRetries: 2,
  supabaseUrl: SUPABASE_URL,
  supabaseServiceRoleKey: 'test-service-key',
  allowedOrigins: ['https://wolidantech.vercel.app'],
  chatRateLimit: 1000,
  generateRateLimit: 1000,
  rateWindowMs: 60000,
  maxMessageChars: 4000,
  maxHistory: 12,
  ragMaxDocs: 6,
  ragMaxCharsPerDoc: 2000,
};

const quiet = { info() {}, warn() {}, error() {} };

async function bootApp(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const sb = createSupabase({ url: cfg.supabaseUrl, serviceKey: cfg.supabaseServiceRoleKey, fetchImpl: stubFetch });
  const instance = createApp({
    config: cfg,
    provider: createProvider(cfg, { fetchImpl: stubFetch }),
    supabase: sb,
    auth: createAuth({ supabaseUrl: cfg.supabaseUrl, serviceKey: cfg.supabaseServiceRoleKey, supabase: sb, fetchImpl: stubFetch, cacheTtlMs: 0 }),
    logger: quiet,
  });
  const srv = createServer(instance);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}` };
}

const servers = [];
async function start(overrides) {
  const instance = await bootApp(overrides);
  servers.push(instance.server);
  return instance;
}

const { server, base } = await start();

async function post(path, body, { token, origin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}
const get = async (path) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

// ==================================================================== TESTS
try {
  section('[1/7] Health');
  const health = await get('/health');
  ok('GET /health -> 200', health.status === 200);
  ok('health body includes { ok: true }', health.body?.ok === true);

  section('[2/7] Authentication & authorisation');
  ok('no token -> 401', (await post('/api/ai/generate', { kind: 'quiz', input: {} })).status === 401);
  ok('garbage token -> 401', (await post('/api/ai/generate', { kind: 'quiz', input: {} }, { token: 'nope' })).status === 401);
  const studentGen = await post('/api/ai/generate', { kind: 'quiz', input: { topic: 'useState' } }, { token: STUDENT_TOKEN });
  ok('student on /api/ai/generate -> 403', studentGen.status === 403);
  ok('403 explains the restriction', /administrator/i.test(studentGen.body?.message || ''));
  ok('student on /api/dantech/chat is allowed (not 403)', (await post('/api/dantech/chat', { message: 'hi' }, { token: STUDENT_TOKEN })).status === 200);

  section('[3/7] CORS');
  const badOrigin = await post('/api/dantech/chat', { message: 'hi' }, { token: STUDENT_TOKEN, origin: 'https://evil.example.com' });
  ok('disallowed origin rejected', badOrigin.status === 403);
  const goodOrigin = await post('/api/dantech/chat', { message: 'hi' }, { token: STUDENT_TOKEN, origin: 'https://wolidantech.vercel.app' });
  ok('allowed origin accepted', goodOrigin.status === 200);

  section('[4/7] Input validation');
  const unknownKind = await post('/api/ai/generate', { kind: 'launch_missiles', input: {} }, { token: ADMIN_TOKEN });
  ok('unknown kind -> 400', unknownKind.status === 400);
  ok('400 lists supported kinds', /course_outline/.test(unknownKind.body?.message || ''));
  ok('malformed body -> 400', (await post('/api/ai/generate', 'not json', { token: ADMIN_TOKEN })).status === 400);
  ok('empty chat message -> 400', (await post('/api/dantech/chat', { message: '   ' }, { token: STUDENT_TOKEN })).status === 400);
  const tooLong = await post('/api/dantech/chat', { message: 'a'.repeat(4001) }, { token: STUDENT_TOKEN });
  ok('message > 4000 chars -> 400', tooLong.status === 400);

  section('[5/7] AI Studio generation — all 10 kinds');
  for (const kind of Object.keys(FIXTURES)) {
    const r = await post('/api/ai/generate', { kind, input: { topic: 'useState', courseName: 'React' }, options: { actor: 'admin' } }, { token: ADMIN_TOKEN });
    ok(`${kind} -> 200`, r.status === 200);
    ok(`${kind} returns { output, provider } wrapper`, r.body && typeof r.body.output === 'object' && typeof r.body.provider === 'string');
  }
  const outline = (await post('/api/ai/generate', { kind: 'course_outline', input: { courseName: 'React' } }, { token: ADMIN_TOKEN })).body.output;
  ok('course_outline has modules[].lessons[].keyConcepts', Array.isArray(outline.modules?.[0]?.lessons?.[0]?.keyConcepts));
  ok('course_outline has learningObjectives', outline.learningObjectives?.length >= 1);
  const quizOut = (await post('/api/ai/generate', { kind: 'quiz', input: { topic: 'useState', numQuestions: 4 } }, { token: ADMIN_TOKEN })).body.output;
  ok('quiz questions carry type/question/options', quizOut.questions.every((q) => q.type && q.question && Array.isArray(q.options)));
  ok('quiz keeps multiple_answer + acceptedAnswers', quizOut.questions.some((q) => q.correctAnswers?.length) && quizOut.questions.some((q) => q.acceptedAnswers?.length));

  section('[6/7] Provider failure handling');
  llmBehaviour = 'garbage';
  const callsBefore = llmCalls;
  const garbage = await post('/api/ai/generate', { kind: 'quiz', input: { topic: 'x' } }, { token: ADMIN_TOKEN });
  ok('unparseable model output -> 502', garbage.status === 502);
  ok('502 message is friendly (no stack/keys)', !/eyJ|sk-|at /.test(garbage.body?.message || '') && garbage.body?.code === 'AI_GENERATION_FAILED');
  ok('retried exactly 2 extra times (3 attempts total)', llmCalls - callsBefore === 3);
  llmBehaviour = 'http500';
  ok('upstream 500 -> 502', (await post('/api/ai/generate', { kind: 'quiz', input: { topic: 'x' } }, { token: ADMIN_TOKEN })).status === 502);
  llmBehaviour = 'ok';

  section('[7/7] DanTECH AI chat');
  const chat = await post('/api/dantech/chat', { message: 'Explain useState to me', context: { courseId: COURSE_ID, lessonId: LESSON_ID, level: 'Beginner' }, history: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }] }, { token: STUDENT_TOKEN });
  ok('chat -> 200', chat.status === 200);
  ok('response has { reply, sources }', typeof chat.body.reply === 'string' && Array.isArray(chat.body.sources));
  ok('reply is markdown from the model', /useState/.test(chat.body.reply));
  ok('sources cite course + lesson titles', chat.body.sources.length > 0 && chat.body.sources[0].courseTitle && chat.body.sources[0].lessonTitle);
  ok('sources never leak lesson bodies', !chat.body.sources.some((s) => s.text));

  const refusal = await post('/api/dantech/chat', { message: 'Please write my assignment for me', context: {}, history: [] }, { token: STUDENT_TOKEN });
  ok('integrity refusal -> 200 with reply', refusal.status === 200 && typeof refusal.body.reply === 'string');
  ok('refusal declines assessed work', /can't complete assessed work/i.test(refusal.body.reply));
  ok('refusal offers help instead', /feedback/i.test(refusal.body.reply));
  ok('refusal carries no sources', refusal.body.sources.length === 0);
  ok('refusal names DanTECH AI', /DanTECH AI/.test(refusal.body.reply));

  ok('quiz-answers request also refused', (await post('/api/dantech/chat', { message: 'give me the answers to the quiz' }, { token: STUDENT_TOKEN })).body.reply.includes("can't"));

  const ask = async (message) => (await post('/api/dantech/chat', { message, context: {}, history: [] }, { token: STUDENT_TOKEN })).body;
  ok('strong request cannot be softened by "for example"', (await ask('write my assignment for me, for example')).reply.includes("can't"));
  ok('"send me the answer key" refused', (await ask('send me the answer key')).reply.includes("can't"));
  ok('"do it for me" refused', (await ask('just do it for me')).reply.includes("can't"));
  ok('genuine teaching request is NOT refused', !(await ask('explain why useState triggers a re-render')).reply.includes("can't"));
  ok('asking for feedback on own work is NOT refused', !(await ask('review my assignment and give feedback')).reply.includes("can't"));

  section('Rate limiting (dedicated instance: chat 2/min, generate 2/min)');
  const rl = await start({ chatRateLimit: 2, generateRateLimit: 2 });
  const rlPost = (path, body, token) =>
    fetch(`${rl.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  const chatCodes = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await rlPost('/api/dantech/chat', { message: 'explain props' }, STUDENT_TOKEN);
    chatCodes.push(r.status);
  }
  ok('chat allows the first 2 requests', chatCodes[0] === 200 && chatCodes[1] === 200);
  ok('chat returns 429 once over the limit', chatCodes[2] === 429 && chatCodes[3] === 429);
  const limitedRes = await rlPost('/api/dantech/chat', { message: 'explain props' }, STUDENT_TOKEN);
  const limitedBody = await limitedRes.json();
  ok('429 sets Retry-After and explains the limit', limitedRes.headers.get('retry-after') !== null && /Rate limit reached/.test(limitedBody.message));
  ok('429 body leaks no internals', !/eyJ|sk-|service_role/i.test(JSON.stringify(limitedBody)));

  const genCodes = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await rlPost('/api/ai/generate', { kind: 'notes', input: { topic: 'useState' } }, ADMIN_TOKEN);
    genCodes.push(r.status);
  }
  ok('generation allows the first 2 requests', genCodes[0] === 200 && genCodes[1] === 200);
  ok('generation returns 429 once over the limit', genCodes[2] === 429 && genCodes[3] === 429);

  console.log(`\nAll ${passed} gateway checks passed.${failed ? ` (${failed} failed)` : ''}`);
} catch (error) {
  failed += 1;
  console.error(`\n✗ FAILED: ${error.message}`);
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  for (const s of servers) s.close();
  server.close();
}
