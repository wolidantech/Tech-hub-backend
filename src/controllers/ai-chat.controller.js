/**
 * WOLI DAN TECH HUB — Advanced DanTECH AI Controller
 * Modes: GENERAL, STUDY, CODING, RESEARCH, CAREER, DEEP_EXPLANATION
 * Features: streaming (SSE), course-aware, RAG, file analysis, conversations, rate limiting, cost control
 */

import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import * as convService from '../services/ai-conversation.service.js';
import { getSystemPromptForMode, checkRateLimit } from '../services/ai-conversation.service.js';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function getUserId(req) {
  return req.profile?.id || null;
}

async function fetchCourseContext({ courseId, moduleId, lessonId }) {
  if (!courseId && !lessonId) return null;
  try {
    let courseTitle = null, moduleTitle = null, lessonTitle = null;
    if (courseId) {
      const { data } = await supabaseAdmin.from('courses').select('title').eq('id', courseId).maybeSingle();
      courseTitle = data?.title;
    }
    if (moduleId) {
      const { data } = await supabaseAdmin.from('course_modules').select('title').eq('id', moduleId).maybeSingle();
      moduleTitle = data?.title;
    }
    if (lessonId) {
      const { data } = await supabaseAdmin.from('lessons').select('title').eq('id', lessonId).maybeSingle();
      if (!data) {
        const { data: cl } = await supabaseAdmin.from('course_lessons').select('title').eq('id', lessonId).maybeSingle();
        lessonTitle = cl?.title;
      } else lessonTitle = data.title;
    }
    return { courseId, courseTitle, moduleId, moduleTitle, lessonId, lessonTitle };
  } catch {
    return { courseId, moduleId, lessonId };
  }
}

async function fetchApprovedContent({ courseId, lessonId, query, maxDocs = 5 }) {
  // RAG: prefer current lesson, then course, then approved content
  const docs = [];
  try {
    if (lessonId) {
      const { data: lessonChunks } = await supabaseAdmin
        .from('lesson_content')
        .select('content')
        .eq('lesson_id', lessonId)
        .eq('is_approved', true)
        .limit(3);
      if (lessonChunks) docs.push(...lessonChunks.map(c => ({ content: c.content, source: 'current_lesson', priority: 1 })));
    }
    if (courseId) {
      const { data: courseContent } = await supabaseAdmin
        .from('ai_generated_content')
        .select('content')
        .eq('course_id', courseId)
        .in('status', ['APPROVED', 'PUBLISHED'])
        .limit(3);
      if (courseContent) docs.push(...courseContent.map(c => ({ content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content).slice(0, 2000), source: 'course', priority: 2 })));
    }
    // General approved resources
    const { data: resources } = await supabaseAdmin
      .from('course_resources')
      .select('title, description, url, source')
      .eq('is_approved', true)
      .limit(2);
    if (resources) docs.push(...resources.map(r => ({ content: `${r.title}: ${r.description}`, source: r.source || 'resource', url: r.url, priority: 3 })));
  } catch (e) {
    console.error('RAG fetch error', e.message);
  }
  return docs.slice(0, maxDocs);
}

// ------------------------------------------------------------------
// POST /api/dantech/chat — non-streaming
// ------------------------------------------------------------------
export const chat = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required');

  const { message, courseId, moduleId, lessonId, mode = 'GENERAL', conversationId, stream = false } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length < 1) throw ApiError.badRequest('Message required', 'VALIDATION_ERROR');
  if (message.length > 10000) throw ApiError.badRequest('Message too long', 'VALIDATION_ERROR');

  // Rate limiting
  const rate = checkRateLimit(userId, 30, 60000); // 30 req/min
  if (!rate.allowed) throw ApiError.tooManyRequests('Rate limit exceeded, please wait', 'RATE_LIMIT');

  // Get or create conversation
  let convId = conversationId;
  if (!convId) {
    const conv = await convService.createConversation({ userId, title: message.slice(0, 80), courseId, moduleId, lessonId, mode });
    convId = conv.id;
  }

  // Save user message
  await convService.addMessage({ conversationId: convId, userId, role: 'user', content: message, courseId, lessonId });

  // Course context + RAG
  const courseContext = await fetchCourseContext({ courseId, moduleId, lessonId });
  const ragDocs = await fetchApprovedContent({ courseId, lessonId, query: message });
  const systemPrompt = getSystemPromptForMode(mode, courseContext);

  let contextPrompt = systemPrompt;
  if (ragDocs.length > 0) {
    contextPrompt += `\n\nApproved context (use as primary source):\n${ragDocs.map((d, i) => `[${i + 1}] ${d.source}: ${d.content.slice(0, 800)}`).join('\n\n')}`;
  }

  // Call AI provider
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    // Fallback: echo with RAG
    const fallbackAnswer = `DanTECH AI (${mode}) — AI key not configured. Based on approved content:\n\n${ragDocs.length > 0 ? ragDocs[0].content.slice(0, 500) : 'No approved content found for this course. Please configure OPENAI_API_KEY for full AI responses.'}\n\nYour question: ${message}`;
    await convService.addMessage({ conversationId: convId, userId, role: 'assistant', content: fallbackAnswer, metadata: { mode, rag: ragDocs } });
    return res.json({ success: true, data: { conversationId: convId, message: fallbackAnswer, mode, sources: ragDocs } });
  }

  try {
    // Mobile: request cancellation via AbortController, timeout 30s
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    req.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: contextPrompt },
          { role: 'user', content: message },
        ],
        max_tokens: 1500,
        temperature: mode === 'CODING' ? 0.2 : mode === 'RESEARCH' ? 0.4 : 0.7,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!aiRes.ok) {
      const txt = await aiRes.text();
      throw new Error(`AI provider ${aiRes.status}: ${txt.slice(0, 500)}`);
    }

    const json = await aiRes.json();
    const answer = json.choices?.[0]?.message?.content || 'No response generated';

    await convService.addMessage({ conversationId: convId, userId, role: 'assistant', content: answer, metadata: { mode, rag: ragDocs, model: json.model } });

    res.json({ success: true, data: { conversationId: convId, message: answer, mode, sources: ragDocs, usage: json.usage } });
  } catch (e) {
    console.error('AI chat error', e.message);
    throw ApiError.internal('AI response failed', 'AI_ERROR');
  }
});

// ------------------------------------------------------------------
// POST /api/dantech/chat/stream — SSE streaming
// ------------------------------------------------------------------
export const chatStream = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required');

  const { message, courseId, moduleId, lessonId, mode = 'GENERAL', conversationId } = req.body;
  if (!message) throw ApiError.badRequest('Message required', 'VALIDATION_ERROR');

  const rate = checkRateLimit(userId, 20, 60000);
  if (!rate.allowed) throw ApiError.tooManyRequests('Rate limit exceeded', 'RATE_LIMIT');

  let convId = conversationId;
  if (!convId) {
    const conv = await convService.createConversation({ userId, title: message.slice(0, 80), courseId, moduleId, lessonId, mode });
    convId = conv.id;
  }

  await convService.addMessage({ conversationId: convId, userId, role: 'user', content: message, courseId, lessonId });

  const courseContext = await fetchCourseContext({ courseId, moduleId, lessonId });
  const ragDocs = await fetchApprovedContent({ courseId, lessonId, query: message });
  const systemPrompt = getSystemPromptForMode(mode, courseContext);
  let contextPrompt = systemPrompt;
  if (ragDocs.length > 0) contextPrompt += `\n\nApproved context:\n${ragDocs.map((d, i) => `[${i + 1}] ${d.source}: ${d.content.slice(0, 800)}`).join('\n\n')}`;

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`data: ${JSON.stringify({ type: 'start', conversationId: convId, mode })}\n\n`);

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    const fallback = `DanTECH AI (${mode}) — AI key not configured. Fallback answer for: ${message}`;
    res.write(`data: ${JSON.stringify({ type: 'token', content: fallback })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', conversationId: convId })}\n\n`);
    await convService.addMessage({ conversationId: convId, userId, role: 'assistant', content: fallback, metadata: { mode } });
    return res.end();
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    req.on('close', () => {
      if (!res.writableFinished) {
        controller.abort();
        // Do not corrupt conversation on interruption — user message saved, assistant not yet
      }
    });

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: contextPrompt },
          { role: 'user', content: message },
        ],
        max_tokens: 2000,
        temperature: 0.7,
        stream: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!aiRes.ok || !aiRes.body) {
      const txt = await aiRes.text();
      throw new Error(`AI stream ${aiRes.status}: ${txt.slice(0, 500)}`);
    }

    const reader = aiRes.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.replace(/^data:\s*/, '');
        if (data === '[DONE]') break;
        try {
          const json = JSON.parse(data);
          const token = json.choices?.[0]?.delta?.content;
          if (token) {
            fullAnswer += token;
            res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
          }
        } catch {}
      }
    }

    await convService.addMessage({ conversationId: convId, userId, role: 'assistant', content: fullAnswer, metadata: { mode, rag: ragDocs } });
    res.write(`data: ${JSON.stringify({ type: 'done', conversationId: convId, sources: ragDocs })}\n\n`);
    res.end();
  } catch (e) {
    console.error('Stream error', e.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

// ------------------------------------------------------------------
// Conversations CRUD
// ------------------------------------------------------------------
export const listConversations = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required');
  const convs = await convService.getConversations({ userId, limit: parseInt(req.query.limit, 10) || 20 });
  res.json({ success: true, data: { conversations: convs } });
});

export const getConversation = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required');
  const conv = await convService.getConversation({ conversationId: req.params.id, userId });
  if (!conv) throw ApiError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
  res.json({ success: true, data: { conversation: conv } });
});

export const deleteConversation = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required');
  await convService.deleteConversation({ conversationId: req.params.id, userId });
  res.json({ success: true, message: 'Conversation deleted' });
});

// ------------------------------------------------------------------
// File analysis — upload + summarize/explain/quiz/flashcards
// ------------------------------------------------------------------
export const uploadFile = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required');

  // Multer should have parsed file — but we handle via express.json? For simplicity, expect file already uploaded via storage route
  // This endpoint expects { fileName, filePath, fileType, fileSize, conversationId }
  const { fileName, filePath, fileType, fileSize, conversationId } = req.body;
  if (!fileName || !filePath) throw ApiError.badRequest('fileName and filePath required', 'VALIDATION_ERROR');

  if (fileSize && fileSize > 20 * 1024 * 1024) throw ApiError.badRequest('File too large (max 20MB)', 'FILE_TOO_LARGE');

  const allowedTypes = ['application/pdf', 'text/plain', 'text/csv', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png', 'text/markdown'];
  if (fileType && !allowedTypes.includes(fileType)) throw ApiError.badRequest('Unsupported file type', 'UNSUPPORTED_TYPE');

  const { data, error } = await supabaseAdmin
    .from('ai_uploaded_files')
    .insert({
      user_id: userId,
      conversation_id: conversationId || null,
      file_name: fileName,
      file_path: filePath,
      file_type: fileType || 'application/octet-stream',
      file_size: fileSize || 0,
    })
    .select()
    .single();

  if (error) throw error;

  res.status(201).json({ success: true, data: { file: data } });
});

export const analyzeFile = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required');

  const { fileId, action = 'summarize' } = req.body; // summarize, explain, quiz, flashcards, concepts
  if (!fileId) throw ApiError.badRequest('fileId required', 'VALIDATION_ERROR');

  const { data: file } = await supabaseAdmin.from('ai_uploaded_files').select('*').eq('id', fileId).eq('user_id', userId).maybeSingle();
  if (!file) throw ApiError.notFound('File not found', 'FILE_NOT_FOUND');

  // Extracted text should already be populated by background job or previous analysis
  // For now, if no extracted_text, return placeholder requiring extraction
  if (!file.extracted_text) {
    return res.json({
      success: true,
      data: {
        message: 'File uploaded, extraction pending. Please ensure file is processed.',
        file,
      },
    });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw ApiError.internal('AI not configured', 'AI_NOT_CONFIGURED');

  const actionPrompts = {
    summarize: 'Summarize this document concisely, highlighting key points.',
    explain: 'Explain this document in simple terms, as if teaching a beginner.',
    concepts: 'Extract key concepts and definitions from this document.',
    quiz: 'Generate 5 multiple-choice quiz questions based on this document with correct answers and explanations.',
    flashcards: 'Create 8 flashcards (question/answer) from this document.',
  };

  const prompt = actionPrompts[action] || actionPrompts.summarize;

  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `You are DanTECH AI. ${prompt}` },
          { role: 'user', content: `Document: ${file.file_name}\n\nContent:\n${file.extracted_text.slice(0, 10000)}` },
        ],
        max_tokens: 1500,
      }),
    });

    if (!aiRes.ok) throw new Error(`AI error ${aiRes.status}`);
    const json = await aiRes.json();
    const result = json.choices?.[0]?.message?.content || '';

    // Save summary if summarize
    if (action === 'summarize') {
      await supabaseAdmin.from('ai_uploaded_files').update({ summary: result }).eq('id', fileId);
    }

    res.json({ success: true, data: { action, result, fileId } });
  } catch (e) {
    throw ApiError.internal('File analysis failed', 'AI_ERROR');
  }
});

// ------------------------------------------------------------------
// Web research — controlled research tool with citations
// ------------------------------------------------------------------
export const webResearch = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required');

  const { query, maxResults = 5 } = req.body;
  if (!query) throw ApiError.badRequest('Query required', 'VALIDATION_ERROR');

  const rate = checkRateLimit(userId + '_research', 10, 60000);
  if (!rate.allowed) throw ApiError.tooManyRequests('Research rate limit exceeded', 'RATE_LIMIT');

  // If no search API configured, return trusted sources guidance
  const searchApiKey = process.env.SEARCH_API_KEY;
  if (!searchApiKey) {
    // Fallback: search in our resource_sources and course_resources
    const { data: resources } = await supabaseAdmin
      .from('course_resources')
      .select('title, description, url, source, license')
      .or(`title.ilike.%${query}%,description.ilike.%${query}%`)
      .eq('is_approved', true)
      .limit(maxResults);

    return res.json({
      success: true,
      data: {
        query,
        results: resources || [],
        note: 'Using internal approved resources. Configure SEARCH_API_KEY for external web search.',
        citations: (resources || []).map(r => ({ title: r.title, url: r.url, source: r.source })),
      },
    });
  }

  // If search API available, implement (e.g. Serper, Brave)
  // Placeholder for now — would call external search
  res.json({ success: true, data: { query, results: [], note: 'External search not implemented, configure provider' } });
});
