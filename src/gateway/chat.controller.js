/**
 * POST /api/dantech/chat — DanTECH AI, the platform's learning assistant.
 * Upgraded to Advanced DanTECH AI:
 * - Modes: GENERAL, STUDY, CODING, RESEARCH, CAREER, DEEP_EXPLANATION
 * - Streaming SSE: POST /api/dantech/chat/stream
 * - Course-aware RAG, context: studentId, courseId, moduleId, lessonId
 * - RAG priority: current lesson > course > approved > external > general
 * - Web research with citations where applicable
 *
 * Contract (wolidantech/Tech-hub-frontend `src/lib/dantech.js`):
 *   request  { message, context: { courseId?, lessonId?, level? }, history: [{role,text}], mode? }
 *   response { reply: "<markdown>", sources: [...] }
 */

import { z } from 'zod';
import { chatSystemPrompt } from './prompts.js';
import { buildContext, toSources } from './rag.js';
import { checkIntegrity } from './integrity.js';
import { sanitizeHistory } from './providers/index.js';
import { DANTECH_NAME } from './config.js';

const MODE_ENUM = z.enum(['GENERAL', 'STUDY', 'CODING', 'RESEARCH', 'CAREER', 'DEEP_EXPLANATION']);

const requestSchema = z.object({
  message: z.string(),
  mode: MODE_ENUM.default('GENERAL').optional(),
  conversationId: z.string().optional(),
  context: z
    .object({
      courseId: z.string().optional(),
      lessonId: z.string().optional(),
      moduleId: z.string().optional(),
      studentId: z.string().optional(),
      level: z.string().optional(),
      mode: z.string().optional(),
    })
    .default({}),
  history: z.array(z.record(z.unknown())).default([]),
});

const streamSchema = requestSchema.extend({
  stream: z.boolean().optional(),
});

const MODE_PROMPTS = {
  GENERAL: 'You are DanTECH AI, a helpful general assistant for WOLI DAN TECH HUB. Be FAST, HELPFUL, DEEP, CONTEXT-AWARE, CONVERSATIONAL.',
  STUDY: 'You are DanTECH AI in STUDY mode. Help students understand concepts, explain clearly, provide examples, and guide learning. Be patient and structured.',
  CODING: 'You are DanTECH AI in CODING mode. Help with programming, debugging, code review, best practices, with clear examples. Use code blocks with language tags.',
  RESEARCH: 'You are DanTECH AI in RESEARCH mode. Help with research, provide citations where possible, authoritative sources, structured analysis. Return citations/source references where applicable.',
  CAREER: 'You are DanTECH AI in CAREER mode. Help with career advice, CV, interviews, job search, professional development. Never fabricate credentials.',
  DEEP_EXPLANATION: 'You are DanTECH AI in DEEP EXPLANATION mode. Provide thorough, structured, progressive explanations with examples, common mistakes, best practices, summary.',
};

function getModePrompt(mode) {
  return MODE_PROMPTS[mode] || MODE_PROMPTS.GENERAL;
}

export function createChatHandler({ provider, supabase, config, logger = console }) {
  return async function chatHandler(req, res) {
    const started = Date.now();
    const parsed = requestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Body must be JSON of the form { "message": string, "context": object, "history": array, "mode": string }.',
        code: 'BAD_REQUEST',
      });
    }

    const message = parsed.data.message.trim();
    const context = parsed.data.context || {};
    const mode = (parsed.data.mode || context.mode || 'GENERAL').toUpperCase();
    const validMode = MODE_PROMPTS[mode] ? mode : 'GENERAL';

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

    const refusal = checkIntegrity(message);
    if (refusal) {
      logger.info?.({ route: '/api/dantech/chat', outcome: 'integrity_refusal', ms: Date.now() - started });
      return res.json({ reply: refusal, sources: [], provider: 'guardrail', mode: validMode });
    }

    const docs = await buildContext({
      supabase,
      message,
      context,
      maxDocs: config.ragMaxDocs,
      maxCharsPerDoc: config.ragMaxCharsPerDoc,
      logger,
    });

    const focus = docs.find((d) => d.lessonId === context.lessonId) || docs.find((d) => d.courseId === context.courseId) || docs[0];

    const baseSystem = chatSystemPrompt(
      {
        courseId: context.courseId,
        lessonId: context.lessonId,
        level: context.level,
        courseTitle: focus?.courseTitle,
        lessonTitle: focus?.lessonTitle,
      },
      docs
    );

    const system = `${getModePrompt(validMode)}\n\n${baseSystem}\n\nMode: ${validMode}. ${validMode === 'RESEARCH' ? 'When answering with current information, return citations/source references where applicable. Do not pretend static model knowledge is real-time.' : ''}`;

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
        mode: validMode,
        ms: Date.now() - started,
      });
      return res.json({ reply: String(reply).trim(), sources: toSources(docs), provider: provider.name, mode: validMode });
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

export function createChatStreamHandler({ provider, supabase, config, logger = console }) {
  return async function chatStreamHandler(req, res) {
    const started = Date.now();
    const parsed = streamSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', code: 'BAD_REQUEST' });
    }

    const message = parsed.data.message.trim();
    const context = parsed.data.context || {};
    const mode = (parsed.data.mode || context.mode || 'GENERAL').toUpperCase();
    const validMode = MODE_PROMPTS[mode] ? mode : 'GENERAL';

    if (!message) return res.status(400).json({ error: 'Invalid request', message: 'message must not be empty.', code: 'EMPTY_MESSAGE' });

    const refusal = checkIntegrity(message);
    if (refusal) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'token', content: refusal })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', mode: validMode })}\n\n`);
      return res.end();
    }

    const docs = await buildContext({
      supabase,
      message,
      context,
      maxDocs: config.ragMaxDocs,
      maxCharsPerDoc: config.ragMaxCharsPerDoc,
      logger,
    });

    const focus = docs.find((d) => d.lessonId === context.lessonId) || docs.find((d) => d.courseId === context.courseId) || docs[0];
    const baseSystem = chatSystemPrompt(
      { courseId: context.courseId, lessonId: context.lessonId, level: context.level, courseTitle: focus?.courseTitle, lessonTitle: focus?.lessonTitle },
      docs
    );
    const system = `${getModePrompt(validMode)}\n\n${baseSystem}`;

    const messages = [...sanitizeHistory(parsed.data.history, { maxTurns: config.maxHistory }), { role: 'user', content: message }];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`data: ${JSON.stringify({ type: 'start', mode: validMode, sources: toSources(docs) })}\n\n`);

    if (provider.chatStream) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.aiTimeoutMs);
        for await (const token of provider.chatStream({ system, messages, signal: controller.signal })) {
          res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
        }
        clearTimeout(timer);
        res.write(`data: ${JSON.stringify({ type: 'done', mode: validMode })}\n\n`);
        return res.end();
      } catch (e) {
        logger.warn?.({ route: '/api/dantech/chat/stream', outcome: 'stream_error', error: e.message });
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Streaming failed, fallback to non-stream' })}\n\n`);
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.aiTimeoutMs);
      const reply = await provider.chat({ system, messages, signal: controller.signal });
      clearTimeout(timer);
      const text = String(reply).trim();
      const chunkSize = 30;
      for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.slice(i, i + chunkSize);
        res.write(`data: ${JSON.stringify({ type: 'token', content: chunk })}\n\n`);
        await new Promise(r => setTimeout(r, 20));
      }
      res.write(`data: ${JSON.stringify({ type: 'done', mode: validMode })}\n\n`);
      return res.end();
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
      return res.end();
    }
  };
}

export default createChatHandler;
