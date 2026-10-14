/**
 * Input contracts for the lecturer content/grading endpoints.
 * Mirrors the validation enforced again inside migration 015's SQL functions;
 * failing here first gives lecturers immediate, specific feedback.
 */
import { z } from 'zod';
import { UUID_RE } from './frontend-access.js';

const uuid = z.string().regex(UUID_RE, 'Must be a valid UUID');
const trimStr = (max) => z.string().trim().min(1).max(max);
const optTrimStr = (max) => z.string().trim().max(max).optional();

export const CONTENT_KINDS = [
  'module_create', 'module_update', 'module_remove',
  'lesson_create', 'lesson_update', 'lesson_remove',
  'quiz_create', 'quiz_update', 'quiz_remove',
  'assignment_create', 'assignment_update', 'assignment_remove',
];

const resourceItem = z
  .object({
    label: trimStr(200),
    url: z.string().trim().max(2000).optional(),
    storage_path: z.string().trim().max(500).optional(),
    name: z.string().trim().max(300).optional(),
    type: z.string().trim().max(200).optional(),
    size: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
  })
  .refine((r) => r.url || r.storage_path, { message: 'Each resource needs a url or storage path' });

const videoBlock = z.object({
  provider: z.enum(['youtube', 'upload', 'ai_generated', 'external']).default('youtube'),
  url: z.string().trim().max(2000).optional(),
  storage_path: z.string().trim().max(500).optional(),
  duration_seconds: z.number().int().positive().max(24 * 3600).optional(),
});

const modulePayload = z.object({
  title: optTrimStr(300),
  position: z.number().int().min(0).max(10000).optional(),
});

const lessonPayload = z.object({
  title: optTrimStr(300),
  type: z.enum(['video', 'text', 'practical', 'quiz', 'assignment', 'project', 'resource']).optional(),
  duration: z.string().trim().max(30).optional(),
  description: z.string().max(10_000).optional(),
  content: z.string().max(300_000).optional(),
  resources: z.array(resourceItem).max(30).optional(),
  video: videoBlock.optional(),
});

const quizQuestion = z.object({
  type: z.enum(['multiple_choice', 'true_false', 'multiple_answer', 'short_answer']).default('multiple_choice'),
  question: trimStr(2000),
  options: z.array(z.string().trim().max(500)).max(10).optional(),
  correct_answer: z.number().int().min(0).max(9).optional(),
  correct_answers: z.array(z.number().int().min(0).max(9)).max(10).optional(),
  accepted_answers: z.array(z.string().trim().max(300)).max(10).optional(),
  explanation: z.string().max(2000).optional(),
});

const quizPayload = z.object({
  description: z.string().max(10_000).optional(),
  passing_score: z.number().int().min(0).max(100).optional(),
  allow_retake: z.boolean().optional(),
  attempt_limit: z.number().int().min(1).max(1000).nullable().optional(),
  is_final: z.boolean().optional(),
  questions: z.array(quizQuestion).min(1, 'A quiz needs at least one question').max(200),
});

const assignmentPayload = z.object({
  description: z.string().max(10_000).optional(),
  instructions: z.string().max(20_000).optional(),
  required_output: z.string().max(5_000).optional(),
  max_score: z.number().int().min(1).max(1000).optional(),
  is_final_project: z.boolean().optional(),
  deadline: z.string().datetime({ offset: true }).nullable().optional(),
  submission_type: z.enum(['file', 'text', 'link', 'any']).optional(),
});

const fileMeta = z.object({
  path: z.string().trim().min(1).max(500),
  name: z.string().trim().max(300).optional(),
  type: z.string().trim().max(200).optional(),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
});

const payloads = {
  module: modulePayload,
  lesson: lessonPayload,
  quiz: quizPayload,
  assignment: assignmentPayload,
};

export const contentRequestSchema = z.object({
  kind: z.enum(CONTENT_KINDS),
  courseId: uuid,
  moduleId: uuid.nullish(),
  lessonId: uuid.nullish(),
  targetId: uuid.nullish(),
  revisionId: uuid.nullish(),
  title: trimStr(300),
  submit: z.boolean().optional().default(false),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

export const gradeRequestSchema = z.object({
  submissionId: uuid,
  decision: z.enum(['approved', 'changes_requested']),
  score: z.number().int().min(0).max(1000).nullish(),
  feedback: z.string().trim().max(5_000).optional().default(''),
});

export const reviewDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'request_changes']),
  notes: z.string().trim().max(5_000).optional().default(''),
});

export const assignCourseSchema = z.object({
  courseId: uuid,
});

export function validate(rawBody) {
  const parsed = contentRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    return { error: `${where}${issue.message}` };
  }
  const body = parsed.data;

  const family = body.kind.split('_')[0];
  const isRemove = body.kind.endsWith('_remove');
  const schema = isRemove
    ? null // removals carry no payload
    : family === 'lesson' ? payloads.lesson
    : family === 'module' ? payloads.module
    : family === 'quiz' ? payloads.quiz
    : family === 'assignment' ? payloads.assignment
    : null;

  if (schema) {
    const check = schema.safeParse(stripUndefined(body.payload));
    if (!check.success) {
      const issue = check.error.issues[0];
      const where = issue.path.length ? `payload.${issue.path.join('.')}: ` : 'payload: ';
      return { error: `${where}${issue.message}` };
    }
    body.payload = check.data;
  } else {
    body.payload = {};
  }

  if ((body.kind.includes('update') || body.kind.includes('remove')) && !body.targetId) {
    return { error: 'targetId is required for update/remove actions.' };
  }
  if (body.kind.endsWith('_create') && body.targetId) {
    return { error: 'Create actions must not include targetId.' };
  }
  if (body.kind === 'lesson_create' && !body.moduleId) {
    return { error: 'moduleId is required when creating a lesson.' };
  }
  if (body.payload.file) {
    const f = fileMeta.safeParse(body.payload.file);
    if (!f.success) return { error: 'payload.file is not valid file metadata.' };
    body.payload = { ...body.payload, file: f.data };
  }
  return { body };
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
}
