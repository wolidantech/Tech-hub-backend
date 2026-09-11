import { supabaseAdmin, supabaseAnon } from '../config/supabase.js';
import { BUCKETS, env } from '../config/env.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { extensionForMime } from '../utils/helpers.js';
import { uploadObject, getPublicUrl } from '../services/storage.service.js';
import { logAudit } from '../services/audit.service.js';

function publicProfile(profile) {
  return {
    id: profile.id,
    user_id: profile.user_id,
    full_name: profile.full_name,
    email: profile.email,
    phone: profile.phone,
    profile_photo_url: profile.profile_photo_url,
    role: profile.role,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

/**
 * POST /api/auth/register
 * Creates a Supabase Auth user. The database trigger creates the
 * matching profile (always role "student") and WELCOME notification.
 * The initial ADMIN is created server-side via scripts/create-admin.js
 * — never through this public endpoint.
 */
export const register = asyncHandler(async (req, res) => {
  const { full_name, email, phone, password } = req.validatedBody;

  const existing = await supabaseAdmin.from('profiles').select('id').eq('email', email).maybeSingle();
  if (existing.data) {
    throw ApiError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: env.autoConfirmEmail,
    user_metadata: { full_name, phone: phone || null },
    app_metadata: { role: 'student' },
  });

  if (error) {
    if (/already (been )?registered/i.test(error.message)) {
      throw ApiError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
    }
    throw ApiError.badRequest(error.message, 'REGISTRATION_FAILED');
  }

  const user = data.user;

  // Upsert the profile (trigger normally creates it; this also covers
  // projects where the trigger was not yet installed).
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert(
      {
        user_id: user.id,
        full_name,
        email,
        phone: phone || null,
        role: 'student',
      },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (profileError) throw ApiError.internal('Account created but profile setup failed');

  // Optional profile photo upload
  if (req.file) {
    const ext = extensionForMime(req.file.mimetype) || '.jpg';
    const path = `${user.id}/avatar${ext}`;
    await uploadObject(BUCKETS.avatars, path, req.file.buffer, req.file.mimetype, { upsert: true });
    const url = getPublicUrl(BUCKETS.avatars, path);
    const { data: updated } = await supabaseAdmin
      .from('profiles')
      .update({ profile_photo_url: url })
      .eq('id', profile.id)
      .select()
      .single();
    if (updated) Object.assign(profile, updated);
  }

  // Sign the user in immediately when confirmations are disabled
  let session = null;
  const { data: loginData } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (loginData?.session) session = loginData.session;

  res.status(201).json({
    success: true,
    message: session
      ? 'Registration successful. Welcome to WOLI DAN TECH HUB!'
      : 'Registration successful. Please check your email to confirm your account, then log in.',
    data: {
      profile: publicProfile(profile),
      requires_email_confirmation: !session,
      session: session
        ? {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_at: session.expires_at,
          }
        : null,
    },
  });
});

/** POST /api/auth/login */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.validatedBody;

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error || !data?.session || !data?.user) {
    // Never reveal which part failed
    throw ApiError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('user_id', data.user.id)
    .maybeSingle();

  if (!profile) throw ApiError.forbidden('Account profile missing. Contact support.', 'PROFILE_NOT_FOUND');

  res.json({
    success: true,
    message: 'Login successful',
    data: {
      profile: publicProfile(profile),
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    },
  });
});

/** POST /api/auth/logout (authenticated) */
export const logout = asyncHandler(async (req, res) => {
  const { error } = await req.supabase.auth.signOut();
  if (error) console.warn('[auth] logout warning', error.message);
  res.json({ success: true, message: 'Logged out successfully' });
});

/** POST /api/auth/forgot-password */
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.validatedBody;
  const redirectTo = `${env.frontendUrls[0]}/reset-password`;

  const { error } = await supabaseAnon.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) console.warn('[auth] password reset request warning', error.message);

  // Always identical response — never leak whether the account exists
  res.json({
    success: true,
    message: 'If an account exists for this email, a password reset link has been sent.',
  });
});

/** POST /api/auth/reset-password (with recovery token as bearer) */
export const resetPassword = asyncHandler(async (req, res) => {
  const { new_password } = req.validatedBody;
  const { error } = await req.supabase.auth.updateUser({ password: new_password });
  if (error) throw ApiError.badRequest('Unable to reset password. The reset link may have expired.', 'RESET_FAILED');
  res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
});

/** POST /api/auth/change-password (authenticated) */
export const changePassword = asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.validatedBody;

  // Re-authenticate to prove possession of the current password
  const { error: verifyError } = await supabaseAnon.auth.signInWithPassword({
    email: req.profile.email,
    password: current_password,
  });
  if (verifyError) {
    throw ApiError.badRequest('Current password is incorrect', 'CURRENT_PASSWORD_INCORRECT');
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
    password: new_password,
  });
  if (error) throw ApiError.internal('Unable to update password');

  if (req.profile.role === 'admin') {
    await logAudit({
      adminId: req.profile.id,
      action: 'PASSWORD_CHANGED',
      targetType: 'user',
      targetId: req.user.id,
      description: 'Admin changed their own password',
    });
  }

  res.json({ success: true, message: 'Password changed successfully' });
});

/** GET /api/profiles/me */
export const getProfile = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { profile: publicProfile(req.profile) } });
});

/** PUT /api/profiles/me (multipart: optional "photo") */
export const updateProfile = asyncHandler(async (req, res) => {
  const updates = { ...req.validatedBody };

  if (req.file) {
    const ext = extensionForMime(req.file.mimetype) || '.jpg';
    const path = `${req.user.id}/avatar${ext}`;
    await uploadObject(BUCKETS.avatars, path, req.file.buffer, req.file.mimetype, { upsert: true });
    updates.profile_photo_url = getPublicUrl(BUCKETS.avatars, path);
  }

  if (Object.keys(updates).length === 0) {
    return res.json({ success: true, message: 'Nothing to update', data: { profile: publicProfile(req.profile) } });
  }

  // Runs under the user's own RLS policies (role escalation blocked
  // by trigger; only own row writable).
  const { data, error } = await req.supabase
    .from('profiles')
    .update(updates)
    .eq('id', req.profile.id)
    .select()
    .single();

  if (error) throw ApiError.internal('Unable to update profile');

  res.json({ success: true, message: 'Profile updated successfully', data: { profile: publicProfile(data) } });
});

/** GET /api/settings/bank-details (authenticated) */
export const getBankDetails = asyncHandler(async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('platform_settings')
    .select('value')
    .eq('key', 'bank_details')
    .eq('is_public', true)
    .maybeSingle();

  if (error || !data) throw ApiError.internal('Payment details are currently unavailable');

  res.json({ success: true, data: { bank_details: data.value } });
});
