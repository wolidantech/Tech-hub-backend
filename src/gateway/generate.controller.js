/**
 * POST /api/ai/generate — AI Studio generation.
 * Students may use the Study Tools kinds (flashcards, notes, summary,
 * exercise); all other kinds are admin-only (enforced by
 * auth.requireAdminForProtectedKind before this handler runs).
 *
 * Contract (wolidantech/Tech-hub-frontend `src/lib/ai.js`):
 *   request  { kind, input, options }
 *   response { output: <kind-shaped data>, provider: "<name>" }
 *
 * Nothing is written to Supabase here — the frontend stores every result as a
 * DRAFT in `ai_generated_content` for admin review.
 */
import { z } from 'zod';
import { systemPromptFor, userPromptFor } from './prompts.js';
import { validateOutput, isKnownKind, AI_KINDS } from './kinds.js';
import { generateStructured } from './json.js';

const requestSchema = z.object({
  kind: z.string(),
  input: z.record(z.unknown()).default({}),
  options: z.record(z.unknown()).default({}),
});

export function createGenerateHandler({ provider, config, logger = console }) {
  return async function generateHandler(req, res) {
    const started = Date.now();
    const parsed = requestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Body must be JSON of the form { "kind": string, "input": object, "options": object }.',
        code: 'BAD_REQUEST',
      });
    }

    const { kind, input, options } = parsed.data;

    if (!isKnownKind(kind)) {
      return res.status(400).json({
        error: 'Unknown AI kind',
        message: `"${kind}" is not a supported kind. Supported kinds: ${AI_KINDS.join(', ')}.`,
        code: 'UNKNOWN_KIND',
      });
    }

    try {
      const output = await generateStructured(
        provider,
        {
          system: systemPromptFor(kind),
          user: userPromptFor(kind, input, options),
          validate: (payload) => validateOutput(kind, payload),
          maxRetries: config.maxRetries,
          timeoutMs: config.aiTimeoutMs,
        }
      );

      logger.info?.({
        route: '/api/ai/generate',
        kind,
        provider: provider.name,
        model: provider.model,
        ms: Date.now() - started,
        status: 200,
      });

      return res.json({ output, provider: provider.name });
    } catch (error) {
      const shapeFailure = error?.name === 'ZodError';
      logger.warn?.({
        route: '/api/ai/generate',
        kind,
        provider: provider.name,
        ms: Date.now() - started,
        status: 502,
        reason: shapeFailure ? 'invalid_shape' : 'provider_error',
      });
      // Never surface provider internals or stack traces to the client.
      return res.status(502).json({
        error: 'Generation failed',
        message: shapeFailure
          ? `The AI returned a ${kind} we could not validate after ${config.maxRetries + 1} attempts. Nothing was saved — please try again.`
          : 'The AI service could not complete this generation. Nothing was saved — please try again in a moment.',
        code: 'AI_GENERATION_FAILED',
      });
    }
  };
}

export default createGenerateHandler;
