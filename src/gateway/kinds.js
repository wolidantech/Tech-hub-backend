/**
 * Per-kind output contracts.
 *
 * These schemas are byte-compatible with `src/lib/ai.js` +
 * `src/pages/admin/AIStudio.jsx` (`renderData` / `applyContent`) in
 * wolidantech/Tech-hub-frontend — the admin UI renders and imports exactly
 * these shapes, so a missing field breaks the apply-flow.
 *
 * Unknown extra fields are preserved (`.passthrough()`), required ones are
 * validated and normalised.
 */
import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const str = z.string().catch('');
const strArray = z.array(str).catch([]);

// ------------------------------------------------------------------ schemas
const courseOutline = z
  .object({
    title: nonEmptyString,
    description: nonEmptyString,
    category: str.optional(),
    duration: str.optional(),
    level: str.optional(),
    learningObjectives: z.array(nonEmptyString).min(1),
    modules: z
      .array(
        z
          .object({
            title: nonEmptyString,
            summary: str.optional(),
            practical: str.optional(),
            lessons: z
              .array(
                z.object({
                  title: nonEmptyString,
                  description: str.optional(),
                  duration: str.optional(),
                  keyConcepts: strArray,
                })
              )
              .min(1),
            quiz: z.object({ passingScore: z.number().int().min(0).max(100).optional() }).optional(),
          })
      )
      .min(1),
    finalProject: str.optional(),
  })
  .passthrough();

const quiz = z
  .object({
    title: str.optional(),
    passingScore: z.number().int().min(0).max(100).optional(),
    questions: z
      .array(
        z
          .object({
            type: z.enum(['multiple_choice', 'true_false', 'multiple_answer', 'short_answer']),
            question: nonEmptyString,
            options: z.array(str).default([]),
            correctAnswer: z.number().int().min(0).optional(),
            correctAnswers: z.array(z.number().int().min(0)).optional(),
            acceptedAnswers: strArray.optional(),
            explanation: str.optional(),
          })
      )
      .min(1),
  })
  .passthrough();

const assignment = z
  .object({
    title: nonEmptyString,
    description: nonEmptyString,
    instructions: nonEmptyString,
    requiredOutput: nonEmptyString,
  })
  .passthrough();

const markdownDoc = z.object({ markdown: nonEmptyString }).passthrough();

const exercise = z
  .object({
    title: nonEmptyString,
    steps: z.array(nonEmptyString).min(1),
    deliverable: nonEmptyString,
    estimatedMinutes: z.number().int().min(1).optional(),
    level: str.optional(),
  })
  .passthrough();

const flashcards = z
  .object({
    title: nonEmptyString,
    cards: z.array(z.object({ front: nonEmptyString, back: nonEmptyString }).passthrough()).min(1),
  })
  .passthrough();

const script = z
  .object({
    title: nonEmptyString,
    voice: z
      .object({
        gender: str.optional(),
        language: str.optional(),
        speed: z.number().optional(),
        style: str.optional(),
      })
      .optional(),
    estimatedWords: z.number().int().min(0).optional(),
    scenes: z
      .array(
        z.object({
          time: nonEmptyString,
          visual: nonEmptyString,
          narration: nonEmptyString,
        })
      )
      .min(1),
    subtitles: str.optional(),
  })
  .passthrough();

/** kind -> zod schema. `lesson_script` is accepted as an alias of video_script. */
export const KIND_SCHEMAS = {
  course_outline: courseOutline,
  quiz,
  assignment,
  lesson_text: markdownDoc,
  summary: markdownDoc,
  notes: markdownDoc,
  exercise,
  flashcards,
  video_script: script,
  voiceover: script,
  lesson_script: script,
};

export const AI_KINDS = [
  'course_outline',
  'lesson_text',
  'quiz',
  'assignment',
  'video_script',
  'voiceover',
  'exercise',
  'notes',
  'flashcards',
  'summary',
];

export function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(KIND_SCHEMAS, kind);
}

/** Models sometimes wrap the payload; dig it out before validating. */
export function unwrapPayload(kind, parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  for (const key of ['output', 'data', 'result', kind]) {
    const inner = parsed[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
  }
  return parsed;
}

/**
 * Validate + normalise a model payload for `kind`.
 * Throws a ZodError when the shape does not match the frontend contract.
 */
export function validateOutput(kind, payload) {
  const schema = KIND_SCHEMAS[kind];
  if (!schema) throw new Error(`Unsupported AI kind: ${kind}`);
  return schema.parse(unwrapPayload(kind, payload));
}

export default KIND_SCHEMAS;
