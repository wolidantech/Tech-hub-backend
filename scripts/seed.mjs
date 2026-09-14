/**
 * WOLI DAN TECH HUB — Production course seed system.
 *
 * Seeds COMPLETE courses (modules → topics → lessons → contents → videos →
 * resources → practicals → assignments → quizzes → assessments → final exam)
 * from JSON in supabase/seed/courses/<slug>/.
 *
 * IDEMPOTENT: every row carries a stable seed_key (<slug>:mod01:top02...)
 * and is upserted (INSERT ... ON CONFLICT DO UPDATE), so re-running the
 * seed refreshes content in place and NEVER duplicates rows.
 *
 * COMPLETENESS GATE (§24): a course is published ONLY if the seed data
 * passes every check (metadata, scheme of work, real theory per lesson,
 * examples, resources, practicals, assignments, quizzes, module exams,
 * final exam, references). Anything incomplete is inserted as DRAFT so
 * students can never see an unfinished course.
 *
 * SOURCE REGISTRY (§21): every external URL in seed data must exist in
 * supabase/seed/sources.json (verified, licensed sources). Unknown URLs
 * fail the gate — invented references are impossible by construction.
 *
 * Usage:
 *   npm run seed                          # seed all courses (DATABASE_URL)
 *   npm run seed -- --courses=biology     # seed one course
 *   npm run seed -- --dry-run             # validate + gate, no writes
 *   npm run seed -- --no-publish          # insert everything as drafts
 *   npm run seed -- --export-sql=out.sql  # emit idempotent SQL, no DB needed
 *
 * Test harness: `import { loadSeedCourses, checkCompleteness, buildSeedPlan,
 * executePlan } from './seed.mjs'` (see scripts/test-seed.mjs).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { z } from 'zod';

dotenv.config();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COURSES_DIR = join(ROOT, 'supabase', 'seed', 'courses');
const SOURCES_FILE = join(ROOT, 'supabase', 'seed', 'sources.json');

// ---------------------------------------------------------------------------
// Seed format schemas
// ---------------------------------------------------------------------------

const questionSchema = z.object({
  type: z.enum(['multiple_choice', 'true_false', 'multiple_answer']),
  question: z.string().min(10),
  options: z.array(z.string().min(1)).min(2),
  correct: z.array(z.number().int().min(0)).min(1),
  explanation: z.string().min(10),
  points: z.number().int().min(1).default(1),
  topic: z.string().optional(),
});

const quizSchema = z.object({
  title: z.string().min(5),
  description: z.string().min(10).optional(),
  passing_score: z.number().int().min(0).max(100).default(70),
  time_limit: z.number().int().min(1).optional(),
  attempt_limit: z.number().int().min(1).default(3),
  questions: z.array(questionSchema).min(1),
});

const assignmentSchema = z.object({
  title: z.string().min(5),
  description: z.string().min(10),
  instructions: z.string().min(20),
  requirements: z.string().optional(),
  expected_output: z.string().optional(),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).default('BEGINNER'),
  estimated_time: z.number().int().min(1).optional(),
  submission_type: z.string().default('TEXT'),
  evaluation_criteria: z.array(z.string()).default([]),
  max_score: z.number().min(1).default(100),
  pass_score: z.number().min(0).default(50),
});

const practicalSchema = z.object({
  title: z.string().min(5),
  objective: z.string().min(10),
  scenario: z.string().optional(),
  instructions: z.string().min(20),
  requirements: z.string().optional(),
  expected_output: z.string().optional(),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).default('BEGINNER'),
  estimated_time: z.number().int().min(1).optional(),
  submission_type: z.string().default('TEXT'),
  evaluation_criteria: z.array(z.string()).default([]),
});

const resourceSchema = z.object({
  type: z.enum(['VIDEO', 'PDF', 'ARTICLE', 'DOCUMENTATION', 'DATASET', 'CODE', 'TEMPLATE', 'WEBSITE', 'BOOK', 'EXERCISE']),
  title: z.string().min(5),
  url: z.string().url(),
  description: z.string().optional(),
  source: z.string().min(2),
  license: z.string().min(2),
  license_url: z.string().url().optional(),
  attribution: z.string().min(5),
});

const videoSchema = z.object({
  title: z.string().min(5),
  url: z.string().url(),
  source: z.string().min(2),
  license: z.string().min(2),
  attribution: z.string().min(5),
  duration: z.number().int().min(1).optional(),
  description: z.string().optional(),
});

const contentBlockSchema = z.object({
  block: z.enum(['THEORY', 'TEXT', 'EXAMPLE', 'VIDEO', 'PDF', 'IMAGE', 'AUDIO', 'CODE', 'EMBED', 'SUMMARY', 'KEY_CONCEPTS', 'READING', 'DOWNLOAD']),
  title: z.string().optional(),
  body: z.string().optional(),
  url: z.string().url().optional(),
  duration_seconds: z.number().int().min(0).optional(),
}).refine((b) => (b.body && b.body.length > 0) || (b.url && b.url.length > 0), {
  message: 'content block must carry a body or a url (mirrors chk_content_payload)',
});

const lessonSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(5),
  description: z.string().min(10).optional(),
  duration: z.number().int().min(1).default(30),
  objectives: z.array(z.string().min(5)).min(1),
  introduction: z.string().min(20).optional(),
  key_points: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  contents: z.array(contentBlockSchema).min(1),
  videos: z.array(videoSchema).default([]),
  resources: z.array(resourceSchema).default([]),
  practical: practicalSchema.nullable().default(null),
  assignment: assignmentSchema.nullable().default(null),
  quiz: quizSchema.nullable().default(null),
});

const topicSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  order: z.number().int().min(1),
  title: z.string().min(5),
  description: z.string().min(10).optional(),
  summary: z.string().optional(),
  objectives: z.array(z.string()).default([]),
  lessons: z.array(lessonSchema).min(1),
});

const assessmentSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/).default('exam'),
  title: z.string().min(5),
  description: z.string().optional(),
  instructions: z.string().min(20),
  passing_score: z.number().int().min(0).max(100).default(60),
  time_limit_minutes: z.number().int().min(1).optional(),
  max_attempts: z.number().int().min(1).default(3),
  time_limit: z.number().int().min(1).optional(),
  attempt_limit: z.number().int().min(1).default(2),
  questions: z.array(questionSchema).min(1),
});

const moduleSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  order: z.number().int().min(1),
  title: z.string().min(5),
  description: z.string().min(10),
  objectives: z.array(z.string().min(5)).min(1),
  duration_text: z.string().optional(),
  topics: z.array(topicSchema).min(1),
  resources: z.array(resourceSchema).default([]),
  practical: practicalSchema.nullable().default(null),
  assignment: assignmentSchema.nullable().default(null),
  quiz: quizSchema.nullable().default(null),
  assessment: assessmentSchema.nullable().default(null),
});

const courseSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(5),
  category: z.string().min(2).default('Science'),
  short_description: z.string().min(20),
  description: z.string().min(100),
  level: z.string().min(2),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).default('BEGINNER'),
  duration: z.string().min(2),
  study_hours: z.number().int().min(1).optional(),
  price: z.number().min(0).default(5000),
  thumbnail: z.string().url().nullable().default(null),
  icon: z.string().optional(),
  subcategory: z.string().optional(),
  prerequisites: z.array(z.string()).default([]),
  target_audience: z.array(z.string()).default([]),
  learning_objectives: z.array(z.string()).min(1),
  learning_outcomes: z.array(z.string()).min(1),
  skills_gained: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  instructor_name: z.string().default('WOLI DAN TECH HUB Faculty'),
  publish: z.boolean().default(true),
  completeness: z.object({
    min_modules: z.number().int().min(1).default(8),
    min_topics_per_module: z.number().int().min(1).default(2),
    min_questions_per_quiz: z.number().int().min(1).default(4),
    min_questions_per_exam: z.number().int().min(1).default(5),
    min_final_questions: z.number().int().min(1).default(20),
    min_theory_chars: z.number().int().min(1).default(200),
    min_example_chars: z.number().int().min(1).default(100),
    require_module_video: z.boolean().default(true),
    require_module_resource: z.boolean().default(true),
    require_module_practical: z.boolean().default(true),
    require_module_assignment: z.boolean().default(true),
    require_module_quiz: z.boolean().default(true),
    require_module_exam: z.boolean().default(true),
  }).default({}),
  completion_rules: z.object({
    required_lesson_completion_percentage: z.number().int().min(0).max(100).default(80),
    minimum_quiz_score: z.number().int().min(0).max(100).nullable().default(60),
    assignment_required: z.boolean().default(true),
    final_project_required: z.boolean().default(false),
    final_assessment_score: z.number().int().min(0).max(100).nullable().default(60),
  }).default({}),
  final_exam: assessmentSchema,
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function loadSourceRegistry() {
  if (!existsSync(SOURCES_FILE)) return { sources: [] };
  return JSON.parse(readFileSync(SOURCES_FILE, 'utf8'));
}

export function loadSeedCourses({ only = null } = {}) {
  if (!existsSync(COURSES_DIR)) return [];
  const slugs = readdirSync(COURSES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((s) => !only || only.includes(s))
    .sort();
  const courses = [];
  for (const slug of slugs) {
    const dir = join(COURSES_DIR, slug);
    const courseFile = join(dir, 'course.json');
    if (!existsSync(courseFile)) throw new Error(`[${slug}] missing course.json`);
    const course = courseSchema.parse(JSON.parse(readFileSync(courseFile, 'utf8')));
    if (course.slug !== slug) throw new Error(`[${slug}] course.json slug "${course.slug}" must match directory name`);
    const moduleFiles = readdirSync(dir).filter((f) => f.startsWith('module-') && f.endsWith('.json')).sort();
    if (moduleFiles.length === 0) throw new Error(`[${slug}] no module-*.json files`);
    const modules = moduleFiles.map((f) => {
      try {
        return moduleSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      } catch (err) {
        throw new Error(`[${slug}/${f}] ${err.message}`);
      }
    });
    // key uniqueness within course
    const seen = new Set();
    for (const m of modules) {
      if (seen.has(m.key)) throw new Error(`[${slug}] duplicate module key "${m.key}"`);
      seen.add(m.key);
    }
    courses.push({ dir, course, modules });
  }
  return courses;
}

// ---------------------------------------------------------------------------
// Completeness gate (§24) + placeholder scan (§2/§8) + source check (§21)
// ---------------------------------------------------------------------------

const BANNED_PATTERNS = [
  /lorem ipsum/i,
  /coming soon/i,
  /\bTBD\b/,
  /TODO:/,
  /insert (text|content|theory|example) here/i,
];
const BANNED_TITLES = new Set(['lesson 1', 'module 1', 'topic 1', 'quiz 1', 'coming soon', 'untitled']);

function collectTexts(course, modules) {
  const out = [];
  const push = (path, value) => {
    if (typeof value === 'string' && value.length > 0) out.push({ path, value });
    else if (Array.isArray(value)) value.forEach((v, i) => push(`${path}[${i}]`, v));
  };
  push('course.title', course.title);
  push('course.description', course.description);
  push('course.short_description', course.short_description);
  for (const m of modules) {
    push(`${m.key}.title`, m.title);
    push(`${m.key}.description`, m.description);
    push(`${m.key}.objectives`, m.objectives);
    for (const t of m.topics) {
      push(`${m.key}.${t.key}.title`, t.title);
      for (const l of t.lessons) {
        push(`${m.key}.${t.key}.${l.key}.title`, l.title);
        for (const [i, b] of l.contents.entries()) {
          push(`${m.key}.${t.key}.${l.key}.contents[${i}]`, b.title);
          push(`${m.key}.${t.key}.${l.key}.contents[${i}]`, b.body);
        }
        for (const q of [...(l.quiz?.questions ?? []), ...(m.quiz?.questions ?? [])]) {
          push('quiz.question', q.question);
          push('quiz.explanation', q.explanation);
        }
      }
    }
  }
  return out;
}

function collectUrls(course, modules) {
  const urls = [];
  const push = (path, url) => { if (url) urls.push({ path, url }); };
  push('course.thumbnail', course.thumbnail);
  for (const m of modules) {
    for (const r of m.resources) push(`${m.key}.resource`, r.url);
    for (const t of m.topics) {
      for (const l of t.lessons) {
        for (const v of l.videos) push(`${m.key}.${t.key}.${l.key}.video`, v.url);
        for (const r of l.resources) push(`${m.key}.${t.key}.${l.key}.resource`, r.url);
        for (const b of l.contents) push(`${m.key}.${t.key}.${l.key}.block`, b.url);
      }
    }
  }
  return urls;
}

export function checkCompleteness(course, modules, registry) {
  const c = course.completeness;
  const checks = [];
  const failures = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
  };

  // -- metadata (§4) --
  check('metadata.title', course.title.length >= 5);
  check('metadata.short_description', course.short_description.length >= 20);
  check('metadata.full_description', course.description.length >= 100);
  check('metadata.category', course.category.length >= 2);
  check('metadata.level', course.level.length >= 2);
  check('metadata.duration', course.duration.length >= 2);
  check('metadata.prerequisites', course.prerequisites.length >= 1, `${course.prerequisites.length} prerequisite(s)`);
  check('metadata.target_audience', course.target_audience.length >= 1);
  check('metadata.learning_objectives', course.learning_objectives.length >= 3, `${course.learning_objectives.length} objective(s)`);
  check('metadata.learning_outcomes', course.learning_outcomes.length >= 3, `${course.learning_outcomes.length} outcome(s)`);
  check('metadata.skills_gained', course.skills_gained.length >= 1);

  // -- scheme of work (§5/§6) --
  check('scheme.modules', modules.length >= c.min_modules, `${modules.length} module(s), need ${c.min_modules}`);

  let lessonCount = 0;
  let topicCount = 0;
  let questionCount = 0;
  for (const m of modules) {
    topicCount += m.topics.length;
    check(`${m.key}.topics`, m.topics.length >= c.min_topics_per_module, `${m.topics.length} topic(s)`);
    check(`${m.key}.objectives`, m.objectives.length >= 1);

    const moduleVideos = new Set();
    const moduleResources = m.resources.length;
    let moduleLessonResources = 0;
    for (const t of m.topics) {
      for (const l of t.lessons) {
        lessonCount += 1;
        l.videos.forEach((v) => moduleVideos.add(v.url));
        l.contents.filter((b) => b.block === 'VIDEO' && b.url).forEach((b) => moduleVideos.add(b.url));
        moduleLessonResources += l.resources.length;
        const theory = l.contents.filter((b) => ['THEORY', 'TEXT'].includes(b.block)).map((b) => b.body ?? '').join('\n');
        const examples = l.contents.filter((b) => ['EXAMPLE', 'CODE'].includes(b.block)).map((b) => b.body ?? '').join('\n');
        const summaries = l.contents.filter((b) => ['SUMMARY', 'KEY_CONCEPTS'].includes(b.block));
        check(`${m.key}.${t.key}.${l.key}.theory`, theory.length >= c.min_theory_chars, `${theory.length} chars`);
        check(`${m.key}.${t.key}.${l.key}.example`, examples.length >= c.min_example_chars, `${examples.length} chars`);
        check(`${m.key}.${t.key}.${l.key}.summary`, summaries.length >= 1);
        check(`${m.key}.${t.key}.${l.key}.objectives`, l.objectives.length >= 2, `${l.objectives.length} objective(s)`);
        if (l.quiz) {
          check(`${m.key}.${t.key}.${l.key}.quiz`, l.quiz.questions.length >= c.min_questions_per_quiz, `${l.quiz.questions.length} question(s)`);
          questionCount += l.quiz.questions.length;
        }
      }
    }
    if (c.require_module_video) check(`${m.key}.video`, moduleVideos.size >= 1, `${moduleVideos.size} video(s)`);
    if (c.require_module_resource) check(`${m.key}.resource`, moduleResources + moduleLessonResources >= 1);
    if (c.require_module_practical) check(`${m.key}.practical`, m.practical != null || m.topics.some((t) => t.lessons.some((l) => l.practical != null)));
    if (c.require_module_assignment) check(`${m.key}.assignment`, m.assignment != null || m.topics.some((t) => t.lessons.some((l) => l.assignment != null)));
    if (c.require_module_quiz) {
      const hasQuiz = m.quiz != null || m.topics.some((t) => t.lessons.some((l) => l.quiz != null));
      check(`${m.key}.quiz`, hasQuiz);
      if (m.quiz) {
        check(`${m.key}.quiz.questions`, m.quiz.questions.length >= c.min_questions_per_quiz, `${m.quiz.questions.length} question(s)`);
        questionCount += m.quiz.questions.length;
      }
    }
    if (c.require_module_exam) {
      check(`${m.key}.exam`, m.assessment != null);
      if (m.assessment) {
        check(`${m.key}.exam.questions`, m.assessment.questions.length >= c.min_questions_per_exam, `${m.assessment.questions.length} question(s)`);
        check(`${m.key}.exam.instructions`, m.assessment.instructions.length >= 20);
        questionCount += m.assessment.questions.length;
      }
    }
  }

  // -- final exam (§15/§16) --
  check('final.questions', course.final_exam.questions.length >= c.min_final_questions, `${course.final_exam.questions.length} question(s)`);
  check('final.instructions', course.final_exam.instructions.length >= 20);
  questionCount += course.final_exam.questions.length;

  // -- question integrity (§14) --
  const allQuestions = [];
  const gather = (prefix, quiz) => quiz?.questions.forEach((q, i) => allQuestions.push({ prefix: `${prefix}.q${i + 1}`, q }));
  for (const m of modules) {
    gather(`${m.key}.quiz`, m.quiz);
    if (m.assessment) gather(`${m.key}.exam`, m.assessment);
    for (const t of m.topics) for (const l of t.lessons) gather(`${m.key}.${t.key}.${l.key}.quiz`, l.quiz);
  }
  gather('final', course.final_exam);
  for (const { prefix, q } of allQuestions) {
    const maxIdx = q.options.length - 1;
    const validIdx = q.correct.every((i) => i >= 0 && i <= maxIdx);
    check(`${prefix}.options_valid`, validIdx && q.options.length >= 2);
    if (q.type === 'multiple_choice') check(`${prefix}.single_answer`, q.correct.length === 1, `${q.correct.length} marked correct`);
    if (q.type === 'true_false') check(`${prefix}.tf_shape`, q.options.length === 2 && q.correct.length === 1);
    check(`${prefix}.explanation`, q.explanation.length >= 20, `${q.explanation.length} chars`);
  }

  // -- placeholder scan (§2/§8) --
  for (const { path, value } of collectTexts(course, modules)) {
    for (const re of BANNED_PATTERNS) {
      if (re.test(value)) check(`content.real[${path}]`, false, `banned pattern ${re} in "${value.slice(0, 60)}..."`);
    }
  }
  const titles = [];
  for (const m of modules) {
    titles.push(m.title);
    for (const t of m.topics) {
      titles.push(t.title);
      for (const l of t.lessons) titles.push(l.title);
    }
  }
  for (const t of titles) {
    if (BANNED_TITLES.has(t.trim().toLowerCase())) check('content.real_title', false, `placeholder title "${t}"`);
  }

  // -- source registry (§21): every URL must be verified --
  const allowed = new Set();
  for (const s of registry.sources ?? []) for (const u of s.urls ?? []) allowed.add(u.url);
  for (const { path, url } of collectUrls(course, modules)) {
    check(`source.verified[${path}]`, allowed.has(url), allowed.has(url) ? '' : `UNVERIFIED URL: ${url}`);
  }

  return {
    complete: failures.length === 0,
    checks,
    failures,
    stats: { modules: modules.length, topics: topicCount, lessons: lessonCount, questions: questionCount },
  };
}

// ---------------------------------------------------------------------------
// Seed plan (pure: no DB access — executed live or rendered as SQL)
// ---------------------------------------------------------------------------

function correctAnswerJson(q) {
  if (q.type === 'true_false') return q.correct[0] === 0;
  if (q.type === 'multiple_answer') return q.correct.map((i) => q.options[i]);
  return q.options[q.correct[0]];
}

export function buildSeedPlan(course, modules, { publish }) {
  const slug = course.slug;
  const live = publish && course.publish;
  const ops = [];
  const PUBLISHED = live ? 'PUBLISHED' : 'DRAFT';
  const pub = live === true;

  ops.push({ op: 'ensure-category', name: course.category });
  ops.push({
    op: 'upsert', table: 'courses', idKey: `course:${slug}`,
    conflict: { columns: ['slug'] },
    values: {
      title: course.title, slug, description: course.description,
      thumbnail_url: course.thumbnail, price: course.price, duration: course.duration,
      difficulty_level: { enum: 'public.difficulty_level', value: course.difficulty },
      is_published: pub, published: pub, archived: false,
      learning_outcomes: course.learning_outcomes, prerequisites: course.prerequisites,
      learning_objectives: course.learning_objectives,
      level: course.level, category: course.category,
      metadata: {
        short_description: course.short_description, subcategory: course.subcategory ?? null,
        study_hours: course.study_hours ?? null, target_audience: course.target_audience,
        skills_gained: course.skills_gained, requirements: course.requirements,
        instructor_name: course.instructor_name, icon: course.icon ?? null,
        syllabus_version: 1,
      },
    },
    refs: { category_id: { table: 'course_categories', column: 'name', value: course.category } },
  });

  const seedQuiz = (quizKey, quiz, scope, parent) => {
    ops.push({
      op: 'upsert', table: 'quizzes', idKey: quizKey,
      conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
      values: {
        seed_key: quizKey, title: quiz.title, description: quiz.description ?? null,
        passing_score: quiz.passing_score, time_limit: quiz.time_limit ?? null,
        status: { enum: 'public.content_status', value: PUBLISHED },
        scope, order_number: 1,
        metadata: { attempt_limit: quiz.attempt_limit, points_total: quiz.questions.reduce((n, q) => n + (q.points ?? 1), 0) },
      },
      refs: {
        course_id: { table: 'courses', column: 'slug', value: slug },
        ...(parent.moduleKey ? { module_id: { ref: parent.moduleKey } } : {}),
        ...(parent.topicKey ? { topic_id: { ref: parent.topicKey } } : {}),
        ...(parent.lessonKey ? { lesson_id: { ref: parent.lessonKey } } : {}),
        ...(parent.assessmentKey ? { assessment_id: { ref: parent.assessmentKey } } : {}),
      },
    });
    quiz.questions.forEach((q, qi) => {
      const qKey = `${quizKey}:q${String(qi + 1).padStart(2, '0')}`;
      ops.push({
        op: 'upsert', table: 'quiz_questions', idKey: qKey,
        conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
        values: {
          seed_key: qKey, question: q.question, question_type: q.type,
          options: q.options, correct_answer: { json: correctAnswerJson(q) },
          explanation: q.explanation, order_number: qi + 1,
          metadata: { points: q.points ?? 1, topic_tag: q.topic ?? null },
        },
        refs: { quiz_id: { ref: quizKey } },
      });
      ops.push({ op: 'delete-children', table: 'quiz_options', column: 'question_id', parentRef: qKey });
      q.options.forEach((text, oi) => {
        ops.push({
          op: 'insert', table: 'quiz_options',
          values: {
            seed_key: `${qKey}:o${oi + 1}`, option_text: text,
            is_correct: q.correct.includes(oi), order_number: oi + 1,
          },
          refs: { question_id: { ref: qKey } },
        });
      });
    });
  };

  const seedPractical = (pKey, p, parent) => {
    ops.push({
      op: 'upsert', table: 'lesson_practicals', idKey: pKey,
      conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
      values: {
        seed_key: pKey, title: p.title, objective: p.objective, scenario: p.scenario ?? null,
        instructions: p.instructions, requirements: p.requirements ?? null,
        expected_output: p.expected_output ?? null,
        difficulty: { enum: 'public.difficulty_level', value: p.difficulty },
        estimated_time: p.estimated_time ?? null, submission_type: p.submission_type,
        evaluation_criteria: p.evaluation_criteria,
        status: { enum: 'public.content_status', value: PUBLISHED },
      },
      refs: {
        lesson_id: { ref: parent.lessonKey }, course_id: { table: 'courses', column: 'slug', value: slug },
        module_id: { ref: parent.moduleKey },
        ...(parent.topicKey ? { topic_id: { ref: parent.topicKey } } : {}),
      },
    });
  };

  const seedAssignment = (aKey, a, parent) => {
    ops.push({
      op: 'upsert', table: 'assignments', idKey: aKey,
      conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
      values: {
        seed_key: aKey, title: a.title, description: a.description, instructions: a.instructions,
        requirements: a.requirements ?? null, expected_output: a.expected_output ?? null,
        difficulty: { enum: 'public.difficulty_level', value: a.difficulty },
        estimated_time: a.estimated_time ?? null, submission_type: a.submission_type,
        evaluation_criteria: a.evaluation_criteria,
        status: { enum: 'public.content_status', value: PUBLISHED },
        max_score: a.max_score, pass_score: a.pass_score,
      },
      refs: {
        course_id: { table: 'courses', column: 'slug', value: slug },
        module_id: { ref: parent.moduleKey },
        ...(parent.topicKey ? { topic_id: { ref: parent.topicKey } } : {}),
        ...(parent.lessonKey ? { lesson_id: { ref: parent.lessonKey } } : {}),
      },
    });
  };

  // Two-phase ordering support: seeded siblings are parked at negative
  // order_numbers before upserts, so renumbers can never collide.
  const orderGroups = [];
  const parkOrders = (table, parentColumn, parentRef) => {
    orderGroups.push({ table, parentColumn, parentRef });
    ops.push({ op: 'renumber-park', table, parentColumn, parentRef });
  };

  parkOrders('course_modules', 'course_id', `course:${slug}`);

  for (const m of modules) {
    const mKey = `${slug}:${m.key}`;
    ops.push({
      op: 'upsert', table: 'course_modules', idKey: mKey,
      conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
      values: {
        seed_key: mKey, title: m.title, description: m.description, order_number: m.order,
        metadata: { objectives: m.objectives, duration_text: m.duration_text ?? null },
      },
      refs: { course_id: { table: 'courses', column: 'slug', value: slug } },
    });
    parkOrders('course_topics', 'module_id', mKey);

    let lessonOrder = 0;
    parkOrders('lessons', 'module_id', mKey);

    for (const t of m.topics) {
      const tKey = `${mKey}:${t.key}`;
      ops.push({
        op: 'upsert', table: 'course_topics', idKey: tKey,
        conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
        values: {
          seed_key: tKey, title: t.title, description: t.description ?? null,
          summary: t.summary ?? null, order_number: t.order,
          is_published: pub, published: pub,
          metadata: { objectives: t.objectives },
        },
        refs: {
          course_id: { table: 'courses', column: 'slug', value: slug },
          module_id: { ref: mKey },
        },
      });

      for (const l of t.lessons) {
        lessonOrder += 1;
        const lKey = `${tKey}:${l.key}`;
        const hasVideo = l.videos.length > 0 || l.contents.some((b) => b.block === 'VIDEO');
        const firstVideo = l.videos[0]?.url ?? l.contents.find((b) => b.block === 'VIDEO' && b.url)?.url ?? null;
        const firstDoc = l.resources.find((r) => ['PDF', 'BOOK', 'ARTICLE'].includes(r.type))?.url ?? null;
        const theoryText = l.contents.filter((b) => ['THEORY', 'TEXT'].includes(b.block)).map((b) => `${b.title ?? ''}\n${b.body ?? ''}`.trim()).join('\n\n');
        ops.push({
          op: 'upsert', table: 'lessons', idKey: lKey,
          conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
          values: {
            seed_key: lKey, title: l.title, description: l.description ?? l.introduction?.slice(0, 300) ?? null,
            lesson_type: { enum: 'public.lesson_type', value: hasVideo ? 'VIDEO' : 'TEXT' },
            video_url: firstVideo, content: [l.introduction ?? '', theoryText].filter(Boolean).join('\n\n') || null,
            resource_url: firstDoc, duration: l.duration, order_number: lessonOrder,
            is_published: pub, published: pub,
            metadata: {
              objectives: l.objectives, introduction: l.introduction ?? null,
              key_points: l.key_points, references: l.references,
            },
          },
          refs: {
            module_id: { ref: mKey }, topic_id: { ref: tKey },
            course_id: { table: 'courses', column: 'slug', value: slug },
          },
        });

        parkOrders('lesson_contents', 'lesson_id', lKey);
        l.contents.forEach((b, bi) => {
          ops.push({
            op: 'upsert', table: 'lesson_contents', idKey: `${lKey}:blk${String(bi + 1).padStart(2, '0')}`,
            conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
            values: {
              seed_key: `${lKey}:blk${String(bi + 1).padStart(2, '0')}`,
              block_type: b.block, title: b.title ?? null, body: b.body ?? null,
              url: b.url ?? null, duration_seconds: b.duration_seconds ?? null,
              order_number: bi + 1, is_published: pub, published: pub,
            },
            refs: { lesson_id: { ref: lKey } },
          });
        });

        l.videos.forEach((v, vi) => {
          const vKey = `${lKey}:vid${vi + 1}`;
          ops.push({
            op: 'upsert', table: 'lesson_videos', idKey: vKey,
            conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
            values: {
              seed_key: vKey, title: v.title, video_url: v.url,
              duration: v.duration ? Math.round(v.duration / 60) : null,
              status: { enum: 'public.video_job_status', value: 'COMPLETED' },
              provider: 'youtube', language: 'en',
              transcript: v.description ?? null,
              provider_metadata: { source: v.source, license: v.license, attribution: v.attribution },
            },
            refs: {
              lesson_id: { ref: lKey }, course_id: { table: 'courses', column: 'slug', value: slug },
              module_id: { ref: mKey }, topic_id: { ref: tKey },
            },
          });
          ops.push({
            op: 'upsert', table: 'course_resources', idKey: `${vKey}:res`,
            conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
            values: {
              seed_key: `${vKey}:res`, title: v.title, description: v.description ?? null,
              url: v.url, source: v.source, license: v.license, attribution: v.attribution,
              resource_type: { enum: 'public.resource_type', value: 'VIDEO' },
              is_external: true, is_approved: pub,
            },
            refs: {
              course_id: { table: 'courses', column: 'slug', value: slug },
              module_id: { ref: mKey }, topic_id: { ref: tKey }, lesson_id: { ref: lKey },
            },
          });
        });

        l.resources.forEach((r, ri) => {
          ops.push({
            op: 'upsert', table: 'course_resources', idKey: `${lKey}:res${ri + 1}`,
            conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
            values: {
              seed_key: `${lKey}:res${ri + 1}`, title: r.title, description: r.description ?? null,
              url: r.url, source: r.source, license: r.license, attribution: r.attribution,
              resource_type: { enum: 'public.resource_type', value: r.type },
              is_external: true, is_approved: pub,
            },
            refs: {
              course_id: { table: 'courses', column: 'slug', value: slug },
              module_id: { ref: mKey }, topic_id: { ref: tKey }, lesson_id: { ref: lKey },
            },
          });
        });

        const lessonParent = { moduleKey: mKey, topicKey: tKey, lessonKey: lKey };
        if (l.practical) seedPractical(`${lKey}:prac`, l.practical, lessonParent);
        if (l.assignment) seedAssignment(`${lKey}:asg`, l.assignment, lessonParent);
        if (l.quiz) seedQuiz(`${lKey}:quiz`, l.quiz, 'LESSON', lessonParent);
      }
    }

    m.resources.forEach((r, ri) => {
      ops.push({
        op: 'upsert', table: 'course_resources', idKey: `${mKey}:res${ri + 1}`,
        conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
        values: {
          seed_key: `${mKey}:res${ri + 1}`, title: r.title, description: r.description ?? null,
          url: r.url, source: r.source, license: r.license, attribution: r.attribution,
          resource_type: { enum: 'public.resource_type', value: r.type },
          is_external: true, is_approved: pub,
        },
        refs: {
          course_id: { table: 'courses', column: 'slug', value: slug },
          module_id: { ref: mKey },
        },
      });
    });

    // Module-level items attach to the module's FIRST lesson for the
    // lesson_id FK (nullable semantically, but practicals require it).
    const firstLessonKey = `${mKey}:${m.topics[0].key}:${m.topics[0].lessons[0].key}`;
    const moduleParent = { moduleKey: mKey, lessonKey: firstLessonKey };
    if (m.practical) seedPractical(`${mKey}:prac`, m.practical, moduleParent);
    if (m.assignment) seedAssignment(`${mKey}:asg`, m.assignment, moduleParent);
    if (m.quiz) seedQuiz(`${mKey}:quiz`, m.quiz, 'MODULE', moduleParent);
    if (m.assessment) {
      const aKey = `${mKey}:${m.assessment.key}`;
      ops.push({
        op: 'upsert', table: 'course_assessments', idKey: aKey,
        conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
        values: {
          seed_key: aKey, title: m.assessment.title, description: m.assessment.description ?? null,
          instructions: m.assessment.instructions, assessment_type: 'MODULE_EXAM',
          passing_score: m.assessment.passing_score,
          time_limit_minutes: m.assessment.time_limit_minutes ?? null,
          max_attempts: m.assessment.max_attempts, order_number: m.order,
          status: { enum: 'public.content_status', value: PUBLISHED },
        },
        refs: {
          course_id: { table: 'courses', column: 'slug', value: slug },
          module_id: { ref: mKey },
        },
      });
      seedQuiz(`${aKey}:quiz`, {
        title: m.assessment.title, description: m.assessment.description,
        passing_score: m.assessment.passing_score,
        time_limit: m.assessment.time_limit ?? m.assessment.time_limit_minutes ?? null,
        attempt_limit: m.assessment.attempt_limit, questions: m.assessment.questions,
      }, 'MODULE', { moduleKey: mKey, assessmentKey: aKey });
    }
  }

  // Final examination (course level).
  const fKey = `${slug}:final-exam`;
  ops.push({
    op: 'upsert', table: 'course_assessments', idKey: fKey,
    conflict: { columns: ['seed_key'], predicate: 'seed_key is not null' },
    values: {
      seed_key: fKey, title: course.final_exam.title,
      description: course.final_exam.description ?? null,
      instructions: course.final_exam.instructions, assessment_type: 'FINAL_EXAM',
      passing_score: course.final_exam.passing_score,
      time_limit_minutes: course.final_exam.time_limit_minutes ?? null,
      max_attempts: course.final_exam.max_attempts, order_number: 999,
      status: { enum: 'public.content_status', value: PUBLISHED },
    },
    refs: { course_id: { table: 'courses', column: 'slug', value: slug } },
  });
  seedQuiz(`${fKey}:quiz`, {
    title: course.final_exam.title, description: course.final_exam.description,
    passing_score: course.final_exam.passing_score,
    time_limit: course.final_exam.time_limit ?? course.final_exam.time_limit_minutes ?? null,
    attempt_limit: course.final_exam.attempt_limit, questions: course.final_exam.questions,
  }, 'FINAL', { assessmentKey: fKey });

  ops.push({
    op: 'upsert', table: 'course_completion_rules', idKey: `rules:${slug}`,
    conflict: { columns: ['course_id'] },
    values: {
      required_lesson_completion_percentage: course.completion_rules.required_lesson_completion_percentage,
      minimum_quiz_score: course.completion_rules.minimum_quiz_score,
      assignment_required: course.completion_rules.assignment_required,
      final_project_required: course.completion_rules.final_project_required,
      final_assessment_score: course.completion_rules.final_assessment_score,
    },
    refs: { course_id: { table: 'courses', column: 'slug', value: slug } },
  });

  return { slug, publish: live, ops };
}

// ---------------------------------------------------------------------------
// Plan execution (live DB)
// ---------------------------------------------------------------------------

function isEnumValue(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && 'enum' in v && 'value' in v;
}
// { json: value } forces JSON encoding for scalar/array values going into
// jsonb columns. A BARE string (e.g. a correct-answer text) must be sent as
// '"..."' — otherwise Postgres tries to parse the raw text as JSON.
function isJsonValue(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === 1 && 'json' in v;
}
function toParam(v) {
  if (v === undefined) return null;
  if (isEnumValue(v)) return v.value;
  if (isJsonValue(v)) return JSON.stringify(v.json);
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export async function executePlan(client, plan) {
  const ids = new Map();
  const resolveRef = (ref) => {
    if (ref.ref) {
      const id = ids.get(ref.ref);
      if (!id) throw new Error(`seed plan: unresolved ref "${ref.ref}"`);
      return id;
    }
    return null; // table lookup refs resolved via SQL subselect below
  };

  for (const op of plan.ops) {
    if (op.op === 'ensure-category') {
      await client.query(
        `insert into public.course_categories (name) values ($1)
         on conflict (name) do nothing`, [op.name]
      );
      continue;
    }
    if (op.op === 'renumber-park') {
      const parentId = op.parentRef.startsWith('course:')
        ? (await client.query(`select id from public.courses where slug = $1`, [plan.slug])).rows[0]?.id
        : ids.get(op.parentRef);
      if (!parentId) throw new Error(`seed plan: renumber-park unresolved parent "${op.parentRef}"`);
      await client.query(
        `update public.${op.table} set order_number = -abs(order_number) - 500000
         where ${op.parentColumn} = $1 and seed_key is not null and order_number > -500000`,
        [parentId]
      );
      continue;
    }
    if (op.op === 'delete-children') {
      const parentId = resolveRef({ ref: op.parentRef });
      await client.query(`delete from public.${op.table} where ${op.column} = $1`, [parentId]);
      continue;
    }
    if (op.op === 'upsert' || op.op === 'insert') {
      const columns = [...Object.keys(op.values), ...Object.keys(op.refs ?? {})];
      const params = [];
      const placeholders = [];
      for (const c of columns) {
        let v;
        if (c in (op.refs ?? {})) {
          const ref = op.refs[c];
          if (ref.ref) v = resolveRef(ref);
          else {
            const r = await client.query(`select id from public.${ref.table} where ${ref.column} = $1`, [ref.value]);
            if (!r.rows[0]) throw new Error(`seed plan: lookup failed ${ref.table}.${ref.column} = ${ref.value}`);
            v = r.rows[0].id;
          }
        } else {
          v = op.values[c];
        }
        params.push(toParam(v));
        const cast = isEnumValue(v) ? `::${v.enum}` : '';
        placeholders.push(`$${params.length}${cast}`);
      }
      const returning = op.idKey ? ' returning id' : '';
      if (op.op === 'insert') {
        const r = await client.query(
          `insert into public.${op.table} (${columns.join(', ')}) values (${placeholders.join(', ')})${returning}`,
          params
        );
        if (op.idKey && r.rows[0]) ids.set(op.idKey, r.rows[0].id);
        continue;
      }
      const updateSet = columns
        .filter((c) => !op.conflict.columns.includes(c))
        .map((c) => `${c} = excluded.${c}`)
        .join(', ');
      const predicate = op.conflict.predicate ? ` where ${op.conflict.predicate}` : '';
      const r = await client.query(
        `insert into public.${op.table} (${columns.join(', ')}) values (${placeholders.join(', ')})
         on conflict (${op.conflict.columns.join(', ')})${predicate} do update set ${updateSet}${returning}`,
        params
      );
      if (op.idKey && r.rows[0]) ids.set(op.idKey, r.rows[0].id);
      continue;
    }
    throw new Error(`seed plan: unknown op "${op.op}"`);
  }
  return ids;
}

export async function seedResourceSources(client, registry) {
  for (const s of registry.sources ?? []) {
    await client.query(
      `insert into public.resource_sources (name, base_url, type, is_trusted, is_active, description)
       values ($1, $2, $3, true, true, $4)
       on conflict (name) do update set base_url = excluded.base_url, type = excluded.type,
         description = excluded.description, is_trusted = true, is_active = true`,
      [s.name, s.base_url, s.type, s.description ?? null]
    );
  }
}

const COUNT_TABLES = [
  ['course_modules', 'modules'], ['course_topics', 'topics'], ['lessons', 'lessons'],
  ['lesson_contents', 'contents'], ['course_resources', 'resources'], ['lesson_videos', 'videos'],
  ['lesson_practicals', 'practicals'], ['assignments', 'assignments'], ['quizzes', 'quizzes'],
  ['quiz_questions', 'questions'], ['quiz_options', 'options'], ['course_assessments', 'assessments'],
];

export async function countSeeded(client, slug) {
  const counts = {};
  for (const [table, label] of COUNT_TABLES) {
    const r = await client.query(`select count(*)::int as n from public.${table} where seed_key like $1`, [`${slug}:%`]);
    counts[label] = r.rows[0].n;
  }
  const c = await client.query(`select is_published, published from public.courses where slug = $1`, [slug]);
  counts.published = Boolean(c.rows[0]?.is_published && c.rows[0]?.published);
  return counts;
}

// ---------------------------------------------------------------------------
// SQL export (idempotent .sql for Supabase SQL Editor)
// ---------------------------------------------------------------------------

function pickDollarTag(allText) {
  let i = 0;
  let tag = '$wdthseed$';
  while (allText.includes(tag)) {
    i += 1;
    tag = `$wdthseed${i}$`;
  }
  return tag;
}

function toLiteral(v, tag) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('seed export: non-finite number');
    return String(v);
  }
  if (isEnumValue(v)) return `${tag}${v.value}${tag}::${v.enum}`;
  if (isJsonValue(v)) return `${tag}${JSON.stringify(v.json)}${tag}::jsonb`;
  if (typeof v === 'object') return `${tag}${JSON.stringify(v)}${tag}::jsonb`;
  return `${tag}${v}${tag}`;
}

export function renderPlanSQL(plan, registry) {
  const chunks = [];
  chunks.push(`-- =====================================================================`);
  chunks.push(`-- WOLI DAN TECH HUB — course seed: ${plan.slug} (${plan.publish ? 'PUBLISHED' : 'DRAFT'})`);
  chunks.push(`-- Generated by: npm run seed -- --export-sql (DO NOT hand-edit; edit the`);
  chunks.push(`-- JSON in supabase/seed/courses/ and re-export). Idempotent: safe to run`);
  chunks.push(`-- multiple times — rows are upserted by stable seed_key, never duplicated.`);
  chunks.push(`-- =====================================================================`);
  chunks.push('');

  // Collect every literal first so the dollar-quote tag is guaranteed unique.
  const literals = [];
  const stmts = [];
  for (const op of plan.ops) {
    if (op.op === 'ensure-category') {
      stmts.push({ op, parts: [op.name] });
      literals.push(op.name);
      continue;
    }
    if (op.op === 'renumber-park') {
      stmts.push({ op, parts: [] });
      continue;
    }
    if (op.op === 'delete-children') {
      stmts.push({ op, parts: [] });
      continue;
    }
    const parts = [];
    for (const c of Object.keys(op.values)) {
      parts.push(op.values[c]);
      literals.push(typeof op.values[c] === 'object' && op.values[c] !== null && !isEnumValue(op.values[c])
        ? JSON.stringify(op.values[c]) : String(op.values[c] ?? ''));
    }
    for (const c of Object.keys(op.refs ?? {})) {
      const ref = op.refs[c];
      if (!ref.ref) {
        parts.push({ __lookupValue: ref.value });
        literals.push(String(ref.value));
      }
    }
    stmts.push({ op, parts });
  }
  const tag = pickDollarTag(literals.join('\n'));

  const refSubselect = (ref) => {
    if (ref.ref) {
      // refs point at seeded rows: resolve through their seed_key.
      const [table] = tableForIdKey(plan, ref.ref);
      return `(select id from public.${table} where seed_key = ${tag}${seedKeyForIdKey(plan, ref.ref)}${tag})`;
    }
    return `(select id from public.${ref.table} where ${ref.column} = ${toLiteral(ref.value, tag)})`;
  };

  for (const { op } of stmts) {
    if (op.op === 'ensure-category') {
      chunks.push(`insert into public.course_categories (name) values (${toLiteral(op.name, tag)}) on conflict (name) do nothing;`);
      continue;
    }
    if (op.op === 'renumber-park') {
      const parentSel = op.parentRef.startsWith('course:')
        ? `(select id from public.courses where slug = ${tag}${plan.slug}${tag})`
        : `(select id from public.${tableForIdKey(plan, op.parentRef)[0]} where seed_key = ${tag}${seedKeyForIdKey(plan, op.parentRef)}${tag})`;
      chunks.push(`update public.${op.table} set order_number = -abs(order_number) - 500000 where ${op.parentColumn} = ${parentSel} and seed_key is not null and order_number > -500000;`);
      continue;
    }
    if (op.op === 'delete-children') {
      const [table] = tableForIdKey(plan, op.parentRef);
      chunks.push(`delete from public.${op.table} where ${op.column} = (select id from public.${table} where seed_key = ${tag}${seedKeyForIdKey(plan, op.parentRef)}${tag});`);
      continue;
    }
    const columns = [...Object.keys(op.values), ...Object.keys(op.refs ?? {})];
    const vals = columns.map((c) => {
      if (c in (op.refs ?? {})) return refSubselect(op.refs[c]);
      return toLiteral(op.values[c], tag);
    });
    if (op.op === 'insert') {
      chunks.push(`insert into public.${op.table} (${columns.join(', ')}) values (${vals.join(', ')});`);
      continue;
    }
    const updateSet = columns.filter((c) => !op.conflict.columns.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
    const predicate = op.conflict.predicate ? ` where ${op.conflict.predicate}` : '';
    chunks.push(`insert into public.${op.table} (${columns.join(', ')}) values (${vals.join(', ')}) on conflict (${op.conflict.columns.join(', ')})${predicate} do update set ${updateSet};`);
  }
  return chunks.join('\n') + '\n';
}

// idKey → (table, seed_key): idKeys ARE seed_keys except course:/rules: aliases.
function tableForIdKey(plan, idKey) {
  for (const op of plan.ops) {
    if (op.idKey === idKey && (op.op === 'upsert' || op.op === 'insert')) return [op.table];
  }
  if (idKey.startsWith('course:')) return ['courses'];
  throw new Error(`seed export: unknown idKey "${idKey}"`);
}
function seedKeyForIdKey(plan, idKey) {
  if (idKey.startsWith('course:')) return null; // handled by slug lookup
  return idKey;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { courses: null, dryRun: false, publish: true, exportSql: null };
  for (const a of argv) {
    if (a.startsWith('--courses=')) args.courses = a.slice('--courses='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-publish') args.publish = false;
    else if (a.startsWith('--export-sql=')) args.exportSql = a.slice('--export-sql='.length);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/seed.mjs [--courses=a,b] [--dry-run] [--no-publish] [--export-sql=path]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadSourceRegistry();
  const loaded = loadSeedCourses({ only: args.courses });
  if (loaded.length === 0) {
    console.log('No seed courses found in supabase/seed/courses/.');
    return;
  }

  console.log(`\nWOLI DAN TECH HUB — course seed (${loaded.length} course(s))\n`);

  const plans = [];
  let gateFailures = 0;
  for (const { course, modules } of loaded) {
    console.log(`[${course.slug}] ${course.title}`);
    const gate = checkCompleteness(course, modules, registry);
    const failed = gate.checks.filter((c) => !c.ok);
    console.log(`  gate: ${gate.checks.length - failed.length}/${gate.checks.length} checks passed `
      + `(${gate.stats.modules} modules, ${gate.stats.topics} topics, ${gate.stats.lessons} lessons, ${gate.stats.questions} questions)`);
    for (const f of failed.slice(0, 25)) console.log(`    ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    if (failed.length > 25) console.log(`    ... and ${failed.length - 25} more`);
    if (!gate.complete) {
      gateFailures += 1;
      console.log(`  → GATE FAILED: will seed as DRAFT (unpublished). Fix the failures above, then re-run to publish.`);
    }
    plans.push({ course, plan: buildSeedPlan(course, modules, { publish: args.publish && gate.complete }) });
  }

  if (args.exportSql) {
    let sql = `-- WOLI DAN TECH HUB — production course seeds (idempotent, re-runnable).\n-- Generated from supabase/seed/courses/*.json — edit JSON + re-export, never this file.\n\n`;
    for (const s of registry.sources ?? []) {
      sql += `insert into public.resource_sources (name, base_url, type, is_trusted, is_active, description) values `
        + `('${s.name.replace(/'/g, "''")}', '${s.base_url}', '${s.type}', true, true, ${s.description ? `'${s.description.replace(/'/g, "''")}'` : 'NULL'}) `
        + `on conflict (name) do update set base_url = excluded.base_url, type = excluded.type, description = excluded.description, is_trusted = true, is_active = true;\n`;
    }
    sql += '\n';
    for (const { plan } of plans) sql += renderPlanSQL(plan, registry) + '\n';
    writeFileSync(args.exportSql, sql);
    console.log(`\nExported idempotent SQL → ${args.exportSql} (${(sql.length / 1024).toFixed(1)} KB)`);
    if (args.dryRun) return;
  }

  if (args.dryRun && !args.exportSql) {
    console.log('\nDry run — no database writes.');
    process.exit(gateFailures > 0 ? 2 : 0);
  }
  if (args.exportSql && args.dryRun) process.exit(gateFailures > 0 ? 2 : 0);
  if (args.exportSql && process.env.SEED_SKIP_DB === '1') return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    if (args.exportSql) return; // export-only run
    console.error('ERROR: DATABASE_URL is not set. Seed against Supabase with DATABASE_URL, or use --export-sql.');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await seedResourceSources(client, registry);
    for (const { course, plan } of plans) {
      console.log(`\n[${course.slug}] seeding (${plan.ops.length} ops, ${plan.publish ? 'PUBLISHED' : 'DRAFT'})...`);
      await client.query('begin');
      try {
        await executePlan(client, plan);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
      const counts = await countSeeded(client, course.slug);
      console.log(`  → modules=${counts.modules} topics=${counts.topics} lessons=${counts.lessons} `
        + `contents=${counts.contents} resources=${counts.resources} videos=${counts.videos} `
        + `practicals=${counts.practicals} assignments=${counts.assignments} quizzes=${counts.quizzes} `
        + `questions=${counts.questions} assessments=${counts.assessments} published=${counts.published}`);
    }
    console.log('\nSeed complete. Re-run any time: rows refresh in place, never duplicate.');
    if (gateFailures > 0) process.exitCode = 2;
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('seed.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('\nSeed failed:', err.message);
    if (process.env.SEED_DEBUG) console.error(err);
    process.exit(1);
  });
}
