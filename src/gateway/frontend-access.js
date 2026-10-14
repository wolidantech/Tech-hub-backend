/**
 * Shared helpers for the frontend-facing Lecturer/Admin/ID-card endpoints.
 *
 * These routes sit in the DEPLOYED gateway (npm start) and talk to the
 * live/frontend Supabase schema. Authorisation is always resolved server-side
 * from profiles.role plus lecturer_course_assignments — never from JWT claims,
 * request params or UI state. The service-role key stays in this process.
 */
import { randomUUID } from 'node:crypto';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function badRequest(message, code = 'VALIDATION') {
  return httpError(400, code, message);
}

export function forbidden(message, code = 'FORBIDDEN') {
  return httpError(403, code, message);
}

export function notFound(message, code = 'NOT_FOUND') {
  return httpError(404, code, message);
}

export function assertUuid(value, label = 'id') {
  if (!UUID_RE.test(String(value || ''))) {
    throw badRequest(`${label} must be a valid UUID.`, 'INVALID_ID');
  }
  return value;
}

/** Require one of the given database roles. Runs after auth.requireAuth(). */
export function createFrontendAccess({ auth, supabase }) {
  function requireRole(roles, message) {
    const allowed = Array.isArray(roles) ? roles : [roles];
    return (req, res, next) => {
      auth
        .resolveRole(req.userId)
        .then(({ role, profile }) => {
          if (!allowed.includes(role)) {
            return res.status(403).json({
              success: false,
              error: {
                code: 'FORBIDDEN_ROLE',
                message: message || 'You do not have access to this area.',
              },
            });
          }
          req.profile = profile;
          req.role = role;
          return next();
        })
        .catch(() =>
          res.status(503).json({
            success: false,
            error: {
              code: 'ROLE_LOOKUP_FAILED',
              message: 'Could not confirm your role right now. Please try again.',
            },
          })
        );
    };
  }

  /** True when lecturerId has an active assignment for courseId. */
  async function teaches(lecturerId, courseId) {
    const rows = await supabase.rest('lecturer_course_assignments', {
      select: 'id',
      lecturer_id: `eq.${lecturerId}`,
      course_id: `eq.${courseId}`,
      limit: '1',
    });
    return Array.isArray(rows) && rows.length > 0;
  }

  async function assertAssigned(lecturerId, courseId) {
    const ok = await teaches(lecturerId, courseId).catch(() => false);
    if (!ok) {
      throw forbidden('You are not assigned to this course.', 'COURSE_NOT_ASSIGNED');
    }
  }

  /** Fetch a single row (or null) from a table with eq filters. */
  async function getOne(table, match, select = '*') {
    const rows = await supabase.rest(table, { select, ...match, limit: '1' });
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  return { requireRole, teaches, assertAssigned, getOne };
}

export { randomUUID };
