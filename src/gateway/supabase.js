/**
 * Minimal Supabase access layer for the gateway.
 *
 * Talks to PostgREST/GoTrue over HTTPS with the SERVICE ROLE key. The key is
 * used here and nowhere else — it is never returned, logged or proxied.
 * `fetchImpl` is injectable so the whole service can be tested offline.
 */

export function createSupabase({ url, serviceKey, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const base = String(url).replace(/\/+$/, '');

  async function rest(path, query = {}, { headers = {} } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.append(k, String(v));
    }
    const qsStr = qs.toString();
    const res = await fetchImpl(`${base}/rest/v1/${path}${qsStr ? `?${qsStr}` : ''}`, {
      method: 'GET',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/json',
        ...headers,
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`Supabase query failed for "${path}" (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** Server-side role lookup — client claims are never trusted. */
  async function getProfile(userId) {
    const rows = await rest('profiles', { id: `eq.${userId}`, select: 'id,full_name,email,role' });
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  const LESSON_SELECT =
    'id,title,duration,position,module_id,course_id,course_modules(title),course_content(body_markdown),courses!inner(id,title,slug,level,category)';
  const PUBLISHED_ONLY = { 'courses.published': 'eq.true', 'courses.archived': 'eq.false' };

  /** All lessons of one published, non-archived course, in teaching order. */
  async function fetchLessonsByCourse(courseId) {
    return rest('course_lessons', {
      select: LESSON_SELECT,
      course_id: `eq.${courseId}`,
      ...PUBLISHED_ONLY,
      order: 'position.asc',
      limit: '200',
    });
  }

  /** Keyword search across published, non-archived lesson titles. */
  async function searchLessons(keywords, limit = 20) {
    if (!keywords.length) return [];
    const or = keywords.slice(0, 4).map((k) => `title.ilike.*${k}*`).join(',');
    return rest('course_lessons', {
      select: LESSON_SELECT,
      or,
      ...PUBLISHED_ONLY,
      limit: String(limit),
    });
  }

  /** Fetch approved AI generated content for RAG (spec 22-23) — prefers WOLI DAN TECH HUB content */
  async function fetchApprovedAiContent({ courseId, lessonId, moduleId, maxDocs = 10 } = {}) {
    try {
      const query = {
        select: 'id,course_id,module_id,lesson_id,content_type,content,status,created_at',
        status: 'in.(APPROVED,PUBLISHED)',
        order: 'created_at.desc',
        limit: String(maxDocs),
      };
      if (courseId) query.course_id = `eq.${courseId}`;
      if (lessonId) query.lesson_id = `eq.${lessonId}`;
      if (moduleId) query.module_id = `eq.${moduleId}`;

      const rows = await rest('ai_generated_content', query);
      // Normalize content to text
      return (rows || []).map(row => ({
        ...row,
        course_title: '',
        lesson_title: row.content?.title || '',
        module_title: '',
        title: row.content?.title || '',
      }));
    } catch (e) {
      // Table may not exist yet in some envs — degrade gracefully
      return [];
    }
  }

  /** Fetch RAG chunks from lesson_content table (approved content) */
  async function fetchRagChunks({ courseId, lessonId, maxDocs = 6 } = {}) {
    try {
      const query = {
        select: 'id,course_id,module_id,lesson_id,content,content_type,chunk_index,is_approved',
        is_approved: 'eq.true',
        order: 'created_at.desc',
        limit: String(maxDocs),
      };
      if (courseId) query.course_id = `eq.${courseId}`;
      if (lessonId) query.lesson_id = `eq.${lessonId}`;

      const rows = await rest('lesson_content', query);
      return rows || [];
    } catch (e) {
      return [];
    }
  }

  return { rest, getProfile, fetchLessonsByCourse, searchLessons, fetchApprovedAiContent, fetchRagChunks, baseUrl: base };
}

/** Normalise a PostgREST lesson row into a RAG document. */
export function toDoc(row) {
  const course = row.courses || {};
  const body = row.course_content?.body_markdown || '';
  return {
    courseId: row.course_id || course.id || null,
    courseTitle: course.title || '',
    courseSlug: course.slug || '',
    category: course.category || '',
    level: course.level || '',
    moduleId: row.module_id || null,
    moduleTitle: row.course_modules?.title || '',
    lessonId: row.id,
    lessonTitle: row.title || '',
    lessonIndex: typeof row.position === 'number' ? row.position : 0,
    text: String(body).slice(0, 4000),
  };
}

export default createSupabase;
