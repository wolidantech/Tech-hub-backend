/**
 * WOLI DAN TECH HUB — RAG-Ready Architecture per spec 23
 * Indexes approved educational material for retrieval by DanTECH AI
 * Stores metadata: course_id, module_id, lesson_id, content_type, chunk, embedding ref
 */

import { supabaseAdmin } from '../config/supabase.js';

function chunkText(text, maxChars = 2000, overlap = 200) {
  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    const chunk = text.slice(start, end);
    if (chunk.trim().length > 100) {
      chunks.push({ chunk: chunk.trim(), index, start, end });
      index++;
    }
    start = end - overlap;
    if (start >= text.length) break;
  }
  return chunks;
}

export async function indexLessonContent({ lessonId, courseId, moduleId, content, contentType = 'TEXT' }) {
  if (!lessonId || !courseId || !content) throw new Error('lessonId, courseId, content required');

  // Delete old chunks for this lesson
  await supabaseAdmin.from('lesson_content').delete().eq('lesson_id', lessonId);

  const chunks = chunkText(content, 2000, 200);

  const rows = chunks.map(c => ({
    lesson_id: lessonId,
    course_id: courseId,
    module_id: moduleId,
    content_type: contentType,
    content: c.chunk,
    chunk_index: c.index,
    metadata: { start: c.start, end: c.end, length: c.chunk.length },
    is_approved: true, // Only approved content is indexed per spec
  }));

  if (rows.length === 0) return [];

  const { data, error } = await supabaseAdmin.from('lesson_content').insert(rows).select();
  if (error) throw error;
  return data;
}

export async function indexApprovedAiContent(contentId) {
  // Fetch approved AI content and index it
  const { data: content } = await supabaseAdmin
    .from('ai_generated_content')
    .select('*')
    .eq('id', contentId)
    .in('status', ['APPROVED', 'PUBLISHED'])
    .maybeSingle();

  if (!content) throw new Error('Content not found or not approved');

  const text = typeof content.content === 'string' ? content.content : JSON.stringify(content.content);
  const markdown = content.content?.markdown || content.content?.content || text;

  return indexLessonContent({
    lessonId: content.lesson_id || content.id,
    courseId: content.course_id,
    moduleId: content.module_id,
    content: markdown,
    contentType: content.content_type,
  });
}

export async function searchApprovedContent({ query, courseId, lessonId, maxDocs = 6 }) {
  // Simple keyword search over lesson_content (approved only)
  // In production, this would use pgvector similarity search
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 4);
  if (keywords.length === 0) return [];

  let q = supabaseAdmin
    .from('lesson_content')
    .select('id, course_id, module_id, lesson_id, content, content_type, chunk_index')
    .eq('is_approved', true)
    .limit(maxDocs * 2);

  if (courseId) q = q.eq('course_id', courseId);
  if (lessonId) q = q.eq('lesson_id', lessonId);

  // For now, fetch and filter in JS (keyword matching) — can be replaced with full-text search or vector search
  const { data, error } = await q;
  if (error) throw error;

  const scored = (data || [])
    .map(doc => {
      const haystack = doc.content.toLowerCase();
      let score = 0;
      for (const kw of keywords) if (haystack.includes(kw)) score += 2;
      if (lessonId && doc.lesson_id === lessonId) score += 20;
      if (courseId && doc.course_id === courseId) score += 8;
      return { doc, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxDocs)
    .map(x => x.doc);

  return scored;
}
