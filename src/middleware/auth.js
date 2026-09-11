import { supabaseAdmin, supabaseAnon, supabaseForUser } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

async function loadProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, user_id, full_name, email, phone, profile_photo_url, role, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw ApiError.internal('Unable to load user profile');
  return data;
}

/**
 * Verifies the Supabase access token, then attaches:
 *   req.user     - Supabase auth user
 *   req.profile  - row from public.profiles (source of truth for roles)
 *   req.supabase - user-scoped client (queries run under THIS user's RLS)
 */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Missing access token', 'MISSING_TOKEN');

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data?.user) {
    throw ApiError.unauthorized('Invalid or expired session. Please log in again.', 'INVALID_TOKEN');
  }

  const profile = await loadProfile(data.user.id);
  if (!profile) {
    throw ApiError.forbidden('Your account profile was not found. Contact support.', 'PROFILE_NOT_FOUND');
  }

  req.accessToken = token;
  req.user = data.user;
  req.profile = profile;
  req.supabase = supabaseForUser(token);
  next();
});

/** Optional auth — populates req.profile when a valid token is sent. */
export const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) return next();

  try {
    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (!error && data?.user) {
      const profile = await loadProfile(data.user.id);
      req.accessToken = token;
      req.user = data.user;
      req.profile = profile;
      req.supabase = supabaseForUser(token);
    }
  } catch {
    // ignore — treat as anonymous
  }
  next();
});

/** Role-based access control guard. Roles come from the database. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.profile) return next(ApiError.unauthorized());
    if (!roles.includes(req.profile.role)) {
      return next(
        ApiError.forbidden(
          'Administrator privileges are required for this action',
          'UNAUTHORIZED_ADMIN_ACTION'
        )
      );
    }
    next();
  };
}

export const requireAdmin = requireRole('admin');
export const requireAdminOrInstructor = requireRole('admin', 'instructor');
