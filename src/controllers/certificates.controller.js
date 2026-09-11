import { supabaseAdmin, supabaseAnon } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { certificateDownloadUrl } from '../services/certificate.service.js';

const CERT_SELECT = `
  id, certificate_number, verification_code, issued_at, status,
  courses ( id, title, slug )
`;

/** GET /api/certificates/me — student's own certificates */
export const getMyCertificates = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('certificates')
    .select(CERT_SELECT)
    .eq('student_id', req.profile.id)
    .order('issued_at', { ascending: false });

  if (error) throw ApiError.internal('Unable to load certificates');
  res.json({ success: true, data: { certificates: data } });
});

/** GET /api/certificates/:id — metadata + signed download URL */
export const getCertificate = asyncHandler(async (req, res) => {
  const { data: certificate } = await supabaseAdmin
    .from('certificates')
    .select(
      `id, student_id, course_id, certificate_number, certificate_url, verification_code,
       issued_at, status, courses ( id, title, slug )`
    )
    .eq('id', req.validatedParams.id)
    .maybeSingle();

  if (!certificate || certificate.status !== 'ACTIVE') {
    throw ApiError.notFound('Certificate not found', 'CERTIFICATE_NOT_FOUND');
  }

  const isOwner = certificate.student_id === req.profile.id;
  if (!isOwner && req.profile.role !== 'admin') {
    throw ApiError.forbidden('You cannot view this certificate', 'FORBIDDEN');
  }

  const downloadUrl = await certificateDownloadUrl(certificate);

  res.json({
    success: true,
    data: {
      certificate: {
        id: certificate.id,
        certificate_number: certificate.certificate_number,
        verification_code: certificate.verification_code,
        issued_at: certificate.issued_at,
        status: certificate.status,
        course: certificate.courses,
        download_url: downloadUrl,
      },
    },
  });
});

/**
 * GET /api/public/verify-certificate/:identifier — PUBLIC.
 * identifier = certificate number (WDTH-2026-000001) or the
 * verification code printed on the PDF.
 */
export const verifyCertificate = asyncHandler(async (req, res) => {
  const { identifier } = req.validatedParams;

  const { data, error } = await supabaseAnon.rpc('verify_certificate', {
    p_identifier: identifier,
  });

  if (error) {
    console.error('[verify-certificate]', error.message);
    throw ApiError.internal('Verification failed. Please try again.');
  }

  if (!data) {
    return res.status(404).json({
      success: false,
      error: { code: 'CERTIFICATE_NOT_FOUND', message: 'Certificate not found. Check the ID and try again.' },
    });
  }

  res.json({ success: true, data: { verification: data } });
});
