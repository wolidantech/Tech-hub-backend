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
  // Draft/archived lessons (lecturer work awaiting admin review, migration 015)
  // must never leak into student-facing AI answers.
  const PUBLISHED_ONLY = {
    'courses.published': 'eq.true',
    'courses.archived': 'eq.false',
    status: 'eq.published',
    archived: 'eq.false',
  };

  /**
   * Fallback readers for backend-schema databases where `course_lessons`
   * is a compatibility VIEW (PostgREST cannot resolve embeds across it)
   * or is absent entirely. Reads the canonical `lessons` (+ modules +
   * courses) tables with service-role privilege and maps rows into the
   * exact shape `toDoc()` expects. Never throws — retrieval problems
   * degrade to "no sources".
   */
  const LESSONS_FALLBACK_SELECT =
    'id,module_id,title,description,lesson_type,video_url,content,resource_url,duration,order_number,is_published';

  function courseVisible(course) {
    if (!course) return false;
    return Boolean(course.is_published || course.published) && course.archived !== true;
  }

  function toGatewayRow(lesson, module, course) {
    return {
      id: lesson.id,
      title: lesson.title,
      duration: lesson.duration,
      position: lesson.order_number,
      module_id: lesson.module_id,
      course_id: course?.id || module?.course_id || null,
      course_modules: { title: module?.title || '' },
      course_content: { body_markdown: lesson.content || lesson.description || '' },
      courses: {
        id: course?.id || null,
        title: course?.title || '',
        slug: course?.slug || '',
        level: course?.level || course?.difficulty_level || '',
        category: course?.category || '',
      },
    };
  }

  async function fetchCourseRow(courseId) {
    // `select=*`: the courses table differs between live/frontend and
    // backend schemas (level/category vs difficulty_level/category_id).
    const rows = await rest('courses', { select: '*', id: `eq.${courseId}`, limit: '1' });
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  async function fetchLessonsByCourseFallback(courseId) {
    try {
      const course = await fetchCourseRow(courseId);
      if (!courseVisible(course)) return [];
      const modules =
        (await rest('course_modules', {
          select: 'id,course_id,title,order_number',
          course_id: `eq.${course.id}`,
          order: 'order_number.asc',
          limit: '200',
        })) || [];
      if (!modules.length) return [];
      const byId = Object.fromEntries(modules.map((m) => [m.id, m]));
      const lessons =
        (await rest('lessons', {
          select: LESSONS_FALLBACK_SELECT,
          module_id: `in.(${modules.map((m) => m.id).join(',')})`,
          order: 'order_number.asc',
          limit: '200',
        })) || [];
      return lessons
        .filter((l) => l.is_published || l.published)
        .map((l) => toGatewayRow(l, byId[l.module_id], course));
    } catch {
      return [];
    }
  }

  async function searchLessonsFallback(keywords, limit = 20) {
    try {
      const or = keywords
        .slice(0, 4)
        .map((k) => `title.ilike.*${k}*`)
        .join(',');
      const lessons =
        (await rest('lessons', { select: LESSONS_FALLBACK_SELECT, or, limit: String(limit * 2) })) || [];
      if (!lessons.length) return [];
      const moduleIds = [...new Set(lessons.map((l) => l.module_id).filter(Boolean))];
      if (!moduleIds.length) return [];
      const modules =
        (await rest('course_modules', {
          select: 'id,course_id,title',
          id: `in.(${moduleIds.join(',')})`,
          limit: String(moduleIds.length),
        })) || [];
      const moduleById = Object.fromEntries(modules.map((m) => [m.id, m]));
      const courseIds = [...new Set(modules.map((m) => m.course_id).filter(Boolean))];
      const courses =
        courseIds.length > 0
          ? (await rest('courses', {
              select: '*',
              id: `in.(${courseIds.join(',')})`,
              limit: String(courseIds.length),
            })) || []
          : [];
      const courseById = Object.fromEntries(courses.map((c) => [c.id, c]));
      return lessons
        .filter((l) => (l.is_published || l.published) && courseVisible(courseById[moduleById[l.module_id]?.course_id]))
        .slice(0, limit)
        .map((l) => {
          const module = moduleById[l.module_id];
          return toGatewayRow(l, module, courseById[module?.course_id]);
        });
    } catch {
      return [];
    }
  }

  /** All lessons of one published, non-archived course, in teaching order. */
  async function fetchLessonsByCourse(courseId) {
    try {
      const rows = await rest('course_lessons', {
        select: LESSON_SELECT,
        course_id: `eq.${courseId}`,
        ...PUBLISHED_ONLY,
        order: 'position.asc',
        limit: '200',
      });
      if (Array.isArray(rows) && rows.length > 0) return rows;
    } catch {
      // Fall through to the canonical-lessons fallback below.
    }
    return fetchLessonsByCourseFallback(courseId);
  }

  /** Keyword search across published, non-archived lesson titles. */
  async function searchLessons(keywords, limit = 20) {
    if (!keywords.length) return [];
    const or = keywords.slice(0, 4).map((k) => `title.ilike.*${k}*`).join(',');
    try {
      const rows = await rest('course_lessons', {
        select: LESSON_SELECT,
        or,
        ...PUBLISHED_ONLY,
        limit: String(limit),
      });
      if (Array.isArray(rows) && rows.length > 0) return rows;
    } catch {
      // Fall through to the canonical-lessons fallback below.
    }
    return searchLessonsFallback(keywords, limit);
  }

  /** Fetch approved AI generated content for RAG (spec 22-23) — prefers DANQEL DIGITAL INSTITUTE content */
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

  /**
   * Call a SECURITY DEFINER function through PostgREST (`/rest/v1/rpc/...`).
   * Functions run with the service role's rights but enforce their own
   * admin/lecturer checks server-side; `p_user_id` overrides let auth.uid()-free
   * contexts stay blocked because every new RPC validates roles explicitly.
   */
  async function rpc(name, args = {}) {
    const res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let message = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text);
        message = parsed?.message || parsed?.hint || message;
      } catch {
        // keep the textual message
      }
      const err = new Error(message || `RPC "${name}" failed (${res.status})`);
      // PostgreSQL raises our validation errors as P0001 (400 from PostgREST);
      // surface them as client errors so lecturers/admins see the real reason.
      err.status = res.status >= 400 && res.status < 500 ? res.status : 502;
      err.code = 'RPC_FAILED';
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Encode a storage object path safely (keep "/" separators). */
  function encodeStoragePath(objectPath) {
    return String(objectPath)
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  /** Download a private/public storage object with the service role. */
  async function storageDownload(bucket, objectPath) {
    const res = await fetchImpl(
      `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(objectPath)}`,
      {
        method: 'GET',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      }
    );
    if (!res.ok) {
      const err = new Error(`Storage download failed for "${bucket}/${objectPath}" (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const arrayBuffer = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: res.headers?.get?.('content-type') || 'application/octet-stream',
    };
  }

  /** Upload (or upsert) a storage object with the service role. */
  async function storageUpload(bucket, objectPath, buffer, contentType, { upsert = true } = {}) {
    const res = await fetchImpl(
      `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(objectPath)}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': contentType || 'application/octet-stream',
          'x-upsert': upsert ? 'true' : 'false',
        },
        body: buffer,
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`Storage upload failed for "${bucket}/${objectPath}" (${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return true;
  }

  /** Update columns on a row (used to attach approved files to live content). */
  async function updateRows(table, match, patch) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(match)) {
      if (v === undefined || v === null || v === '') continue;
      qs.append(k, String(v));
    }
    const res = await fetchImpl(`${base}/rest/v1/${table}${qs.size ? `?${qs}` : ''}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`Supabase update failed for "${table}" (${res.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    rest,
    rpc,
    storageDownload,
    storageUpload,
    updateRows,
    encodeStoragePath,
    getProfile,
    fetchLessonsByCourse,
    searchLessons,
    fetchApprovedAiContent,
    fetchRagChunks,
    baseUrl: base,
  };
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
