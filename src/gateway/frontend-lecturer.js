/**
 * Lecturer dashboard endpoints (live/frontend schema).
 *
 *   GET  /api/lecturer/inbox      — assigned courses, students, submissions
 *   POST /api/lecturer/content    — save a draft change; optionally submit it
 *   POST /api/lecturer/grades     — propose a grade for a submission
 *
 * Authorisation: the caller must be profiles.role='instructor' AND have a
 * lecturer_course_assignments row for the course. Nothing here publishes:
 * drafts flow to the admin review RPCs from migration 015, and live content
 * is only written when an admin approves (admin_review_content_approval).
 * The one exception is files attached to drafts: they land in the PRIVATE
 * `resources-pending` bucket and are copied to the live bucket by the backend
 * only after approval (see admin-review handlers).
 */
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import {
  assertUuid,
  badRequest,
  httpError,
  notFound,
} from './frontend-access.js';
import {
  validate,
  gradeRequestSchema,
} from './frontend-validation.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB — documents, images and short clips
const ALLOWED_FILE_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
]);

const draftUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_FILE_TYPES.has(file.mimetype)) return cb(null, true);
    return cb(Object.assign(new Error(`Unsupported file type: ${file.mimetype}`), { status: 400, code: 'UNSUPPORTED_TYPE' }));
  },
});

/** Multer middleware with consistent machine-readable errors. */
export function contentUpload(req, res, next) {
  draftUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(httpError(413, 'FILE_TOO_LARGE', 'Files must be 20MB or smaller. Large videos should be hosted and linked by URL.'));
    }
    return next(httpError(err.status || 400, err.code || 'UPLOAD_INVALID', err.message || 'The uploaded file could not be accepted.'));
  });
}

function safeFileName(name) {
  const base = String(name || 'file').split('/').pop().split('\\').pop();
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return (cleaned || 'file').slice(0, 120);
}

function coalesceFields(req) {
  // multipart fields arrive as strings; JSON bodies are already typed.
  if (!req.is?.('multipart/form-data')) return req.body || {};
  const out = { ...(req.body || {}) };
  for (const jsonKey of ['payload']) {
    if (typeof out[jsonKey] === 'string') {
      try {
        out[jsonKey] = JSON.parse(out[jsonKey]);
      } catch {
        throw badRequest(`${jsonKey} must be valid JSON.`);
      }
    }
  }
  for (const boolKey of ['submit']) {
    if (typeof out[boolKey] === 'string') out[boolKey] = out[boolKey] === 'true';
  }
  return out;
}

export function createFrontendLecturerHandlers({ supabase, access, logger = console }) {
  /** All courses the lecturer teaches, plus people & work to mark. */
  async function inbox(req, res) {
    const lecturerId = req.userId;
    const assignments = await supabase.rest('lecturer_course_assignments', {
      select: 'id,course_id,created_at,courses(id,title,slug,published,archived,category,level)',
      lecturer_id: `eq.${lecturerId}`,
      order: 'created_at.asc',
      limit: '200',
    });

    const courses = (assignments || [])
      .filter((a) => a.courses)
      .map((a) => ({
        assignmentId: a.id,
        assignedAt: a.created_at,
        ...a.courses,
      }));
    const courseIds = courses.map((c) => c.id);

    let students = [];
    let submissions = [];
    let contentReviews = [];
    let gradeReviews = [];

    if (courseIds.length) {
      const inList = `in.(${courseIds.join(',')})`;
      const [enrollments, subs, content, grades] = await Promise.all([
        supabase.rest('enrollments', {
          select: 'id,course_id,user_id,status,enrolled_at,profiles(id,full_name,email,avatar_url)',
          course_id: inList,
          order: 'enrolled_at.desc',
          limit: '500',
        }),
        supabase.rest('assignment_submissions', {
          select: 'id,course_id,assignment_id,user_id,status,score,feedback,kind,file_name,submitted_at,reviewed_at,assignments(id,title,max_score),profiles(id,full_name,email)',
          course_id: inList,
          order: 'submitted_at.desc',
          limit: '300',
        }),
        supabase.rest('lecturer_content_revisions', {
          select: 'id,kind,course_id,module_id,lesson_id,target_id,title,status,version,review_notes,submitted_at,updated_at',
          lecturer_id: `eq.${lecturerId}`,
          order: 'updated_at.desc',
          limit: '200',
        }),
        supabase.rest('lecturer_grade_reviews', {
          select: 'id,assignment_id,submission_id,course_id,student_id,decision,score,status,version,review_notes,submitted_at,updated_at',
          lecturer_id: `eq.${lecturerId}`,
          order: 'updated_at.desc',
          limit: '200',
        }),
      ]);
      students = enrollments || [];
      submissions = subs || [];
      contentReviews = content || [];
      gradeReviews = grades || [];
    }

    res.json({
      success: true,
      data: {
        lecturer: {
          id: lecturerId,
          fullName: req.profile?.full_name || '',
          email: req.profile?.email || '',
        },
        courses,
        students,
        submissions,
        reviews: { content: contentReviews, grades: gradeReviews },
        workflow: 'Draft → Pending review → Admin decision. Approved content and grades are released by administrators only.',
      },
    });
  }

  /** Save (or save+submit) a content change. */
  async function saveContent(req, res) {
    const lecturerId = req.userId;
    const raw = coalesceFields(req);
    const { error, body } = validate(raw);
    if (error) throw badRequest(error);

    await access.assertAssigned(lecturerId, body.courseId);

    const payload = { ...(body.payload || {}) };

    if (req.file) {
      const requestId = randomUUID();
      const storedName = `${Date.now()}-${safeFileName(req.file.originalname)}`;
      const objectPath = `${lecturerId}/${requestId}/${storedName}`;
      await supabase.storageUpload('resources-pending', objectPath, req.file.buffer, req.file.mimetype, { upsert: false });
      payload.file = {
        path: objectPath,
        name: safeFileName(req.file.originalname),
        type: req.file.mimetype,
        size: req.file.size,
      };
      logger.info?.({ route: 'lecturer-content', stage: 'pending-file', size: req.file.size });
    }

    let saved;
    try {
      saved = await supabase.rpc('lecturer_save_content_draft', {
        p_revision_id: body.revisionId || null,
        p_kind: body.kind,
        p_course_id: body.courseId,
        p_module_id: body.moduleId || null,
        p_lesson_id: body.lessonId || null,
        p_target_id: body.targetId || null,
        p_title: body.title,
        p_payload: payload,
      });
    } catch (err) {
      throw httpError(err.status === 400 ? 400 : 502, 'DRAFT_SAVE_FAILED', err.message);
    }

    let submitted = null;
    if (body.submit && saved?.id) {
      try {
        submitted = await supabase.rpc('lecturer_submit_content_for_review', {
          p_revision_id: saved.id,
        });
      } catch (err) {
        throw httpError(err.status === 400 ? 400 : 502, 'REVIEW_SUBMIT_FAILED', err.message);
      }
    }

    res.status(201).json({
      success: true,
      data: {
        revision: submitted || saved,
        submitted: Boolean(submitted),
        message: submitted
          ? 'Submitted for administrator review. It will go live only after approval.'
          : 'Draft saved privately. Submit it for administrator review when ready.',
      },
    });
  }

  /** Propose a grade; an administrator releases it to the student. */
  async function saveGrade(req, res) {
    const lecturerId = req.userId;
    const parsed = gradeRequestSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(`${issue.path.join('.')}: ${issue.message}`.replace(/^:\s*/, ''));
    }
    const body = parsed.data;

    if (body.decision === 'approved' && (body.score === null || body.score === undefined)) {
      throw badRequest('A score is required to approve work.', 'SCORE_REQUIRED');
    }
    if (body.decision === 'changes_requested' && !body.feedback) {
      throw badRequest('Feedback is required when requesting changes.', 'FEEDBACK_REQUIRED');
    }

    const submission = await supabase
      .rest('assignment_submissions', {
        select: 'id,course_id,assignment_id,user_id,status',
        id: `eq.${body.submissionId}`,
        limit: '1',
      })
      .then((rows) => (Array.isArray(rows) && rows.length ? rows[0] : null));
    if (!submission) throw notFound('Submission not found.', 'SUBMISSION_NOT_FOUND');

    await access.assertAssigned(lecturerId, submission.course_id);

    let review;
    try {
      review = await supabase.rpc('lecturer_submit_grade_for_review', {
        p_submission_id: body.submissionId,
        p_assignment_id: null,
        p_student_id: null,
        p_decision: body.decision,
        p_score: body.score ?? null,
        p_feedback: body.feedback || '',
      });
    } catch (err) {
      throw httpError(err.status === 400 ? 400 : 502, 'GRADE_SUBMIT_FAILED', err.message);
    }

    res.status(201).json({
      success: true,
      data: {
        review,
        message: 'Grade sent for administrator review. The student sees it only after an administrator releases it.',
      },
    });
  }

  return { inbox, saveContent, saveGrade };
}

export default createFrontendLecturerHandlers;
