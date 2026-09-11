import { supabaseAdmin } from '../config/supabase.js';
import { ApiError } from '../utils/errors.js';

/** Uploads a buffer to a bucket using the service role. */
export async function uploadObject(bucket, path, buffer, contentType, { upsert = true } = {}) {
  const { error } = await supabaseAdmin.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert,
    cacheControl: '3600',
  });
  if (error) {
    console.error('[storage] upload failed', { bucket, error: error.message });
    throw ApiError.internal('File upload failed. Please try again.');
  }
  return path;
}

export async function removeObject(bucket, path) {
  const { error } = await supabaseAdmin.storage.from(bucket).remove([path]);
  if (error) console.warn('[storage] remove failed (non-fatal)', { bucket, path, error: error.message });
}

/**
 * Creates a short-lived signed URL for a PRIVATE file. Used for
 * receipts, certificates and lesson resources — these files must
 * never be publicly accessible.
 */
export async function createSignedUrl(bucket, path, expiresInSeconds = 600) {
  const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) {
    console.error('[storage] signed url failed', { bucket, error: error?.message });
    throw ApiError.notFound('File not found or unavailable', 'FILE_NOT_FOUND');
  }
  return data.signedUrl;
}

export function getPublicUrl(bucket, path) {
  const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}
