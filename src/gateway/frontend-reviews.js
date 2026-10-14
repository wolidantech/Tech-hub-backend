/**
 * Administrator endpoints for the lecturer workflow (live/frontend schema).
 *
 *   GET    /api/admin/lecturers                              — list lecturers + assignments
 *   POST   /api/admin/lecturers/:lecturerId/courses          — assign a course
 *   DELETE /api/admin/lecturers/:lecturerId/courses/:courseId — revoke a course
 *   GET    /api/admin/reviews                                — combined moderation queue
 *   POST   /api/admin/reviews/:revisionId/decision           — approve/reject content
 *   POST   /api/admin/grade-reviews/:gradingId/decision      — approve/reject a grade
 *
 * Approving a content revision asks the database to publish the EXACT
 * submitted payload (admin_review_content_approval). If the lecturer attached
 * a file, it is streamed from the private `resources-pending` bucket to the
 * course's live `resources` bucket here, after approval — students can only
 * ever read files that survived moderation.
 */
import {
  assertUuid,
  badRequest,
  httpError,
  notFound,
} from './frontend-access.js';
import { reviewDecisionSchema, assignCourseSchema } from './frontend-validation.js';

const REVIEW_ACTIONS = { approve: 'approved', reject: 'rejected', request_changes: 'changes_requested' };

function parseReviewDecision(body) {
  const parsed = reviewDecisionSchema.safeParse(body || {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(`${issue.path.join('.')}: ${issue.message}`.replace(/^:\s*/, ''));
  }
  const { decision, notes } = parsed.data;
  if (decision !== 'approve' && !notes) {
    throw badRequest('A reason is required when rejecting or requesting changes.', 'NOTES_REQUIRED');
  }
  return { action: REVIEW_ACTIONS[decision], notes, decision };
}

export function createFrontendReviewHandlers({ supabase, logger = console }) {
  async function listLecturers(_req, res) {
    const lecturers = await supabase.rest('profiles', {
      select: 'id,full_name,email,avatar_url,created_at',
      role: 'eq.instructor',
      order: 'full_name.asc',
      limit: '500',
    });
    let assignments = [];
    if (lecturers?.length) {
      const ids = lecturers.map((l) => l.id).join(',');
      assignments = await supabase.rest('lecturer_course_assignments', {
        select: 'id,lecturer_id,course_id,created_at,assigned_by,courses(id,title,slug,published,archived)',
        lecturer_id: `in.(${ids})`,
        order: 'created_at.asc',
        limit: '1000',
      });
    }
    const byLecturer = new Map();
    for (const l of lecturers || []) byLecturer.set(l.id, { ...l, courses: [] });
    for (const a of assignments || []) {
      const entry = byLecturer.get(a.lecturer_id);
      if (entry && a.courses) {
        entry.courses.push({
          assignmentId: a.id,
          assignedAt: a.created_at,
          assignedBy: a.assigned_by,
          ...a.courses,
        });
      }
    }
    res.json({ success: true, data: { lecturers: [...byLecturer.values()] } });
  }

  async function assignCourse(req, res) {
    const lecturerId = assertUuid(req.params.lecturerId, 'lecturerId');
    const parsed = assignCourseSchema.safeParse(req.body || {});
    if (!parsed.success) throw badRequest('courseId must be a valid UUID.', 'INVALID_COURSE');

    let result;
    try {
      result = await supabase.rpc('admin_upsert_lecturer_assignment', {
        p_lecturer_id: lecturerId,
        p_course_id: parsed.data.courseId,
      });
    } catch (err) {
      throw httpError(err.status === 400 ? 400 : 502, 'ASSIGN_FAILED', err.message);
    }
    res.status(201).json({
      success: true,
      data: { assignment: result, message: 'Course assigned. The lecturer has been notified.' },
    });
  }

  async function unassignCourse(req, res) {
    const lecturerId = assertUuid(req.params.lecturerId, 'lecturerId');
    const courseId = assertUuid(req.params.courseId, 'courseId');
    let result;
    try {
      result = await supabase.rpc('admin_remove_lecturer_assignment', {
        p_lecturer_id: lecturerId,
        p_course_id: courseId,
      });
    } catch (err) {
      throw httpError(err.status === 400 ? 400 : 502, 'REMOVE_FAILED', err.message);
    }
    res.json({
      success: true,
      data: { result, message: 'Course access removed. The lecturer loses that course immediately.' },
    });
  }

  async function queue(_req, res) {
    const [content, grades] = await Promise.all([
      supabase.rest('lecturer_content_revisions', {
        select: '*',
        status: 'eq.pending_approval',
        order: 'submitted_at.asc',
        limit: '200',
      }),
      supabase.rest('lecturer_grade_reviews', {
        select: '*',
        status: 'eq.pending_approval',
        order: 'submitted_at.asc',
        limit: '200',
      }),
    ]);

    // Enrich with course titles, lecturer names, assignment + student context.
    const courseIds = new Set();
    const profileIds = new Set();
    const assignmentIds = new Set();
    for (const row of content || []) { if (row.course_id) courseIds.add(row.course_id); if (row.lecturer_id) profileIds.add(row.lecturer_id); }
    for (const row of grades || []) {
      if (row.course_id) courseIds.add(row.course_id);
      if (row.lecturer_id) profileIds.add(row.lecturer_id);
      if (row.student_id) profileIds.add(row.student_id);
      if (row.assignment_id) assignmentIds.add(row.assignment_id);
    }

    const [courses, profiles, assignments] = await Promise.all([
      courseIds.size
        ? supabase.rest('courses', { select: 'id,title,slug,published,archived', id: `in.(${[...courseIds].join(',')})`, limit: String(courseIds.size) })
        : [],
      profileIds.size
        ? supabase.rest('profiles', { select: 'id,full_name,email,avatar_url', id: `in.(${[...profileIds].join(',')})`, limit: String(profileIds.size) })
        : [],
      assignmentIds.size
        ? supabase.rest('assignments', { select: 'id,title,max_score,status', id: `in.(${[...assignmentIds].join(',')})`, limit: String(assignmentIds.size) })
        : [],
    ]);
    const courseMap = Object.fromEntries((courses || []).map((c) => [c.id, c]));
    const profileMap = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
    const assignmentMap = Object.fromEntries((assignments || []).map((a) => [a.id, a]));

    res.json({
      success: true,
      data: {
        content: (content || []).map((r) => ({
          ...r,
          course: courseMap[r.course_id] || null,
          lecturer: profileMap[r.lecturer_id] || null,
        })),
        grades: (grades || []).map((r) => ({
          ...r,
          course: courseMap[r.course_id] || null,
          lecturer: profileMap[r.lecturer_id] || null,
          student: profileMap[r.student_id] || null,
          assignment: assignmentMap[r.assignment_id] || null,
        })),
        workflow: 'Approving publishes the exact submitted version; rejecting/requesting changes sends it back to the lecturer.',
      },
    });
  }

  /**
   * After a lesson/assignment revision is approved, move the lecturer's file
   * from resources-pending to the live resources bucket and index it on the
   * published row. Failures here must NOT mask the already-committed approval.
   */
  async function promoteApprovedFile({ revision, targetId }) {
    const file = revision?.payload?.file;
    if (!file?.path || !targetId) return null;
    try {
      const livePath = `${revision.course_id}/${targetId}/${file.name || 'resource'}`;
      const object = await supabase.storageDownload('resources-pending', file.path);
      await supabase.storageUpload('resources', livePath, object.buffer, file.type || object.contentType, { upsert: true });

      if (revision.kind.startsWith('lesson')) {
        const rows = await supabase.rest('course_lessons', {
          select: 'id,resources',
          id: `eq.${targetId}`,
          limit: '1',
        });
        const current = Array.isArray(rows) && rows.length ? rows[0].resources || [] : [];
        const entry = { label: file.name || 'Course resource', storage_path: livePath, type: file.type || null, size: file.size ?? null };
        await supabase.updateRows('course_lessons', { id: `eq.${targetId}` }, { resources: [...current, entry] });
      }
      return { livePath };
    } catch (error) {
      logger.warn?.({ route: 'admin-review', stage: 'promote-file', error: error?.message });
      return { error: 'The content was published, but copying the attached file to the live library failed. Copy it manually from the pending bucket.' };
    }
  }

  async function decideContent(req, res) {
    const revisionId = assertUuid(req.params.revisionId, 'revisionId');
    const { action, notes } = parseReviewDecision(req.body);

    const revision = await supabase
      .rest('lecturer_content_revisions', { select: '*', id: `eq.${revisionId}`, limit: '1' })
      .then((rows) => (Array.isArray(rows) && rows.length ? rows[0] : null));
    if (!revision) throw notFound('Review item not found.', 'REVIEW_NOT_FOUND');

    let result;
    try {
      result = await supabase.rpc('admin_review_content_approval', {
        p_revision_id: revisionId,
        p_action: action,
        p_notes: notes,
      });
    } catch (err) {
      throw httpError(err.status === 400 ? 400 : 502, 'REVIEW_FAILED', err.message);
    }

    let file = null;
    if (action === 'approved' && result?.targetId) {
      file = await promoteApprovedFile({ revision, targetId: result.targetId });
    }

    res.json({
      success: true,
      data: {
        result,
        file,
        message:
          action === 'approved'
            ? 'Approved — the exact submitted version is now live for students.'
            : action === 'rejected'
              ? 'Rejected — the lecturer has been notified with your reason.'
              : 'Changes requested — the lecturer can revise and resubmit.',
      },
    });
  }

  async function decideGrade(req, res) {
    const gradingId = assertUuid(req.params.gradingId, 'gradingId');
    const { action, notes } = parseReviewDecision(req.body);

    const existing = await supabase
      .rest('lecturer_grade_reviews', { select: 'id,status', id: `eq.${gradingId}`, limit: '1' })
      .then((rows) => (Array.isArray(rows) && rows.length ? rows[0] : null));
    if (!existing) throw notFound('Grade review not found.', 'REVIEW_NOT_FOUND');

    let result;
    try {
      result = await supabase.rpc('admin_review_grade_approval', {
        p_grading_id: gradingId,
        p_action: action,
        p_notes: notes,
      });
    } catch (err) {
      throw httpError(err.status === 400 ? 400 : 502, 'REVIEW_FAILED', err.message);
    }

    res.json({
      success: true,
      data: {
        result,
        message:
          action === 'approved'
            ? 'Released — the student now sees the grade and feedback, and completion/certificate rules were re-evaluated.'
            : action === 'rejected'
              ? 'Rejected — the grade was NOT released; the lecturer has your reason.'
              : 'Changes requested — the lecturer can adjust the grade and resubmit.',
      },
    });
  }

  return { listLecturers, assignCourse, unassignCourse, queue, decideContent, decideGrade };
}

export default createFrontendReviewHandlers;
