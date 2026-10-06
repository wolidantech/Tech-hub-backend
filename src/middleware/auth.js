import { supabaseAdmin, supabaseAnon, supabaseForUser } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { env } from '../config/env.js';

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

// The caller only trusts this claim after Supabase Auth has verified the token
// with getUser(token) below.
function readAalClaim(token) {
  try {
    const payload = token.split('.')[1];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.aal === 'aal2' ? 'aal2' : 'aal1';
  } catch {
    return 'aal1';
  }
}

async function loadProfile(userId) {
  const legacy = await supabaseAdmin
    .from('profiles')
    .select('id, user_id, full_name, email, phone, profile_photo_url, student_number, role, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (!legacy.error && legacy.data) return legacy.data;
  const legacyColumnsMissing = legacy.error
    && /column|schema cache|user_id|profile_photo_url|student_number/i.test(String(legacy.error.message || ''));
  if (legacy.error && !legacyColumnsMissing) {
    throw ApiError.internal('Unable to load user profile');
  }

  // The live frontend project uses profiles.id = auth.uid() and avatar_url,
  // not the dormant backend's user_id/profile_photo_url columns. Normalize
  // this schema to the same internal shape without changing role authority.
  const frontend = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, phone, avatar_url, role, created_at')
    .eq('id', userId)
    .maybeSingle();
  if (frontend.error) throw ApiError.internal('Unable to load user profile');
  if (!frontend.data) return null;
  return {
    ...frontend.data,
    user_id: frontend.data.id,
    profile_photo_url: frontend.data.avatar_url || null,
    student_number: null,
    updated_at: frontend.data.updated_at || frontend.data.created_at,
  };
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
  req.authAal = readAalClaim(token);
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
      req.authAal = readAalClaim(token);
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
    if (req.profile.role === 'admin' && env.requireAdminMfa && req.authAal !== 'aal2') {
      return next(ApiError.forbidden('Verify your Google Authenticator code before using administrator tools', 'MFA_REQUIRED'));
    }
    next();
  };
}

export const requireAdmin = requireRole('admin');
export const requireAdminOrInstructor = requireRole('admin', 'instructor');
