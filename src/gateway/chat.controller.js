/**
 * POST /api/dantech/chat — DanTECH AI, the platform's learning assistant.
 *
 * Contract (wolidantech/Tech-hub-frontend `src/lib/dantech.js`):
 *   request  { message, context: { courseId?, lessonId?, level? }, history: [{role,text}] }
 *   response { reply: "<markdown>", sources: [...] }
 *
 * Grounded in PUBLISHED, non-archived course content retrieved server-side
 * with the service-role key. Academic integrity is enforced here, before any
 * model call.
 */
import { z } from 'zod';
import { chatSystemPrompt } from './prompts.js';
import { buildContext, toSources } from './rag.js';
import { checkIntegrity } from './integrity.js';
import { sanitizeHistory } from './providers/index.js';
import { DANTECH_NAME } from './config.js';

const requestSchema = z.object({
  message: z.string(),
  context: z
    .object({
      courseId: z.string().optional(),
      lessonId: z.string().optional(),
      level: z.string().optional(),
    })
    .default({}),
  history: z.array(z.record(z.unknown())).default([]),
});

export function createChatHandler({ provider, supabase, config, logger = console }) {
  return async function chatHandler(req, res) {
    const started = Date.now();
    const parsed = requestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Body must be JSON of the form { "message": string, "context": object, "history": array }.',
        code: 'BAD_REQUEST',
      });
    }

    const message = parsed.data.message.trim();
    const context = parsed.data.context || {};

    if (!message) {
      return res.status(400).json({ error: 'Invalid request', message: 'message must not be empty.', code: 'EMPTY_MESSAGE' });
    }
    if (message.length > config.maxMessageChars) {
      return res.status(400).json({
        error: 'Message too long',
        message: `Please keep messages under ${config.maxMessageChars} characters.`,
        code: 'MESSAGE_TOO_LONG',
      });
    }

    // Server-side integrity guard — a refusal is a normal reply, not an error.
    const refusal = checkIntegrity(message);
    if (refusal) {
      logger.info?.({ route: '/api/dantech/chat', outcome: 'integrity_refusal', ms: Date.now() - started });
      return res.json({ reply: refusal, sources: [], provider: 'guardrail' });
    }

    // Retrieval — published, non-archived lessons only.
    const docs = await buildContext({
      supabase,
      message,
      context,
      maxDocs: config.ragMaxDocs,
      maxCharsPerDoc: config.ragMaxCharsPerDoc,
      logger,
    });

    const focus = docs.find((d) => d.lessonId === context.lessonId) || docs.find((d) => d.courseId === context.courseId) || docs[0];

    const system = chatSystemPrompt(
      {
        courseId: context.courseId,
        lessonId: context.lessonId,
        level: context.level,
        courseTitle: focus?.courseTitle,
        lessonTitle: focus?.lessonTitle,
      },
      docs
    );

    const messages = [...sanitizeHistory(parsed.data.history, { maxTurns: config.maxHistory }), { role: 'user', content: message }];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.aiTimeoutMs);
    try {
      const reply = await provider.chat({ system, messages, signal: controller.signal });
      logger.info?.({
        route: '/api/dantech/chat',
        outcome: 'ok',
        sources: docs.length,
        provider: provider.name,
        ms: Date.now() - started,
      });
      return res.json({ reply: String(reply).trim(), sources: toSources(docs), provider: provider.name });
    } catch (error) {
      logger.warn?.({
        route: '/api/dantech/chat',
        outcome: 'provider_error',
        provider: provider.name,
        ms: Date.now() - started,
      });
      return res.status(502).json({
        error: 'Assistant unavailable',
        message: `${DANTECH_NAME} could not answer just now. Please try again in a moment.`,
        code: 'AI_CHAT_FAILED',
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

export default createChatHandler;
