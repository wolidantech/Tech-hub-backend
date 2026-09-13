/**
 * Retrieval for DanTECH AI — PUBLISHED, non-archived course content only.
 * Upgraded per spec sections 22-23 to be course-aware and RAG-ready:
 * - Accepts studentId, courseId, moduleId, lessonId
 * - Prefers approved WOLI DAN TECH HUB content (ai_generated_content + lesson_content) over general knowledge
 * - Uses approved educational material for grounding
 *
 * Mirrors the scoring the frontend's offline engine uses (keyword hits with a
 * boost for the current lesson/course) so cloud and offline answers feel the
 * same, then truncates to fit the model context.
 */
import { toDoc } from './supabase.js';

const STOP = new Set(
  'the,a,an,to,of,and,in,is,are,was,were,be,been,for,on,with,that,this,it,as,at,by,from,or,me,my,i,you,your,please,explain,give,what,how,why,when,lesson,topic,course,like,can,could,would,should,will,about,into,over,under,again,then,than,there,their,them,they,have,has,had,not,but,just,really,very,much,many,some,any,all,each,other,more,most'.split(
    ','
  )
);

export function keywords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Rank documents against the query, boosting the current lesson/course. */
export function retrieve(docs, query, context = {}, topK = 3) {
  const keys = keywords(query);
  if (!Array.isArray(docs) || docs.length === 0) return [];

  const scored = docs
    .map((doc) => {
      const haystack = `${doc.lessonTitle} ${doc.moduleTitle} ${doc.courseTitle} ${doc.text}`.toLowerCase();
      let score = 0;
      for (const key of keys) if (haystack.includes(key)) score += 2;
      if (context.lessonId && doc.lessonId === context.lessonId) score += 20;
      else if (context.courseId && doc.courseId === context.courseId) score += 8;
      if (context.moduleId && doc.moduleId === context.moduleId) score += 12;
      // Boost approved WOLI DAN TECH HUB content per spec 23
      if (doc.isApprovedContent) score += 10;
      if (doc.contentType === 'LESSON_TEXT' || doc.contentType === 'LESSON') score += 5;
      return { doc, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // With no keyword overlap but a current lesson, still ground on that lesson.
  if (scored.length === 0 && context.lessonId) {
    const current = docs.find((d) => d.lessonId === context.lessonId);
    if (current) return [current];
  }
  return scored.slice(0, topK).map((x) => x.doc);
}

/**
 * Fetch + rank the grounding documents for one chat turn.
 * Never throws: retrieval problems degrade to "no sources", never to a 500.
 * Upgraded to include approved AI content and RAG chunks per spec 22-23
 */
export async function buildContext({ supabase, message, context = {}, maxDocs = 6, maxCharsPerDoc = 2000, logger = console }) {
  let rows = [];
  let aiRows = [];
  let ragChunks = [];
  
  try {
    if (context.courseId) {
      rows = await supabase.fetchLessonsByCourse(context.courseId);
    }
    if ((!rows || rows.length === 0) && message) {
      rows = await supabase.searchLessons(keywords(message), maxDocs * 4);
    }

    // Fetch approved AI generated content for this course/lesson per spec 22-23
    try {
      if (supabase.fetchApprovedAiContent) {
        aiRows = await supabase.fetchApprovedAiContent({
          courseId: context.courseId,
          lessonId: context.lessonId,
          moduleId: context.moduleId,
          maxDocs: maxDocs * 2,
        });
      }
    } catch (e) {
      logger.warn?.('[rag] AI content retrieval failed', e.message);
      aiRows = [];
    }

    // Fetch RAG chunks from lesson_content table (approved content)
    try {
      if (supabase.fetchRagChunks) {
        ragChunks = await supabase.fetchRagChunks({
          courseId: context.courseId,
          lessonId: context.lessonId,
          maxDocs: maxDocs,
        });
      }
    } catch (e) {
      logger.warn?.('[rag] RAG chunks retrieval failed', e.message);
      ragChunks = [];
    }
  } catch (error) {
    logger.warn?.('[rag] retrieval unavailable — answering without sources');
    rows = [];
  }

  const docs = (rows || []).map(toDoc);
  const aiDocs = (aiRows || []).map((row) => ({
    courseId: row.course_id,
    courseTitle: row.course_title || row.courseTitle || '',
    moduleId: row.module_id,
    moduleTitle: row.module_title || '',
    lessonId: row.lesson_id,
    lessonTitle: row.lesson_title || row.title || '',
    text: typeof row.content === 'string' ? row.content : JSON.stringify(row.content).slice(0, maxCharsPerDoc),
    category: '',
    level: '',
    isApprovedContent: true,
    contentType: row.content_type || 'LESSON',
  }));

  const chunkDocs = (ragChunks || []).map((chunk) => ({
    courseId: chunk.course_id,
    courseTitle: '',
    moduleId: chunk.module_id,
    moduleTitle: '',
    lessonId: chunk.lesson_id,
    lessonTitle: '',
    text: chunk.content || chunk.chunk || '',
    category: '',
    level: '',
    isApprovedContent: true,
    contentType: 'RAG_CHUNK',
  }));

  const allDocs = [...docs, ...aiDocs, ...chunkDocs];
  const picked = retrieve(allDocs, message, context, maxDocs);

  return picked.map((doc) => ({
    ...doc,
    text: String(doc.text || '').slice(0, maxCharsPerDoc),
  }));
}

/** Public, safe-to-send source list (never includes lesson bodies). */
export function toSources(docs) {
  return (docs || []).map((d) => ({
    courseId: d.courseId || null,
    courseTitle: d.courseTitle || '',
    courseSlug: d.courseSlug || '',
    moduleId: d.moduleId || null,
    moduleTitle: d.moduleTitle || '',
    lessonId: d.lessonId || null,
    lessonTitle: d.lessonTitle || '',
    category: d.category || '',
    level: d.level || '',
    isApprovedContent: !!d.isApprovedContent,
    contentType: d.contentType || '',
  }));
}

export default { keywords, retrieve, buildContext, toSources };
