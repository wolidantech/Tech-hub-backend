/**
 * Retrieval for DanTECH AI — PUBLISHED, non-archived course content only.
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
 */
export async function buildContext({ supabase, message, context = {}, maxDocs = 6, maxCharsPerDoc = 2000, logger = console }) {
  let rows = [];
  try {
    if (context.courseId) {
      rows = await supabase.fetchLessonsByCourse(context.courseId);
    }
    if ((!rows || rows.length === 0) && message) {
      rows = await supabase.searchLessons(keywords(message), maxDocs * 4);
    }
  } catch (error) {
    logger.warn?.('[rag] retrieval unavailable — answering without sources');
    rows = [];
  }

  const docs = (rows || []).map(toDoc);
  const picked = retrieve(docs, message, context, maxDocs);

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
  }));
}

export default { keywords, retrieve, buildContext, toSources };
