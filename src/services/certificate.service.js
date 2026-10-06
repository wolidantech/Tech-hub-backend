import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { readFileSync } from 'node:fs';
import { supabaseAdmin } from '../config/supabase.js';
import { BUCKETS } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { INSTITUTION_NAME } from '../config/brand.js';
import { uploadObject, createSignedUrl } from './storage.service.js';

const BRAND = '#0b3d91';
const GOLD = '#c9a227';
const CERTIFICATE_PDF_BRAND_VERSION = 2;
const DANQEL_LOGO_SVG = readFileSync(
  new URL('../../assets/brand/danqel-digital-institute.svg', import.meta.url),
  'utf8',
);

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Renders the DANQEL DIGITAL INSTITUTE certificate of completion as a
 * landscape A4 PDF with the reusable DANQEL vector logo and retained certificate details.
 */
function buildCertificatePdf({ studentName, courseName, issuedAt, certificateNumber, verificationCode }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 0,
      info: { Title: 'Certificate of Completion', Author: INSTITUTION_NAME },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width; // 841.89
    const H = doc.page.height; // 595.28

    // Background + border frame
    doc.rect(0, 0, W, H).fill('#ffffff');
    doc.lineWidth(6).rect(24, 24, W - 48, H - 48).stroke(BRAND);
    doc.lineWidth(1.5).rect(34, 34, W - 68, H - 68).stroke(GOLD);

    // Full vector logo lockup: the background remains transparent so the mark
    // sits cleanly above the existing certificate frame.
    const logoWidth = 190;
    const logoHeight = logoWidth * (925 / 1000);
    SVGtoPDF(doc, DANQEL_LOGO_SVG, (W - logoWidth) / 2, 24, {
      width: logoWidth,
      height: logoHeight,
    });

    doc.moveTo(W / 2 - 120, 209).lineTo(W / 2 + 120, 209).lineWidth(1).stroke(GOLD);

    doc.fillColor('#333333').font('Helvetica').fontSize(15)
      .text('CERTIFICATE OF COMPLETION', 0, 220, { align: 'center', width: W, characterSpacing: 4 });

    doc.fillColor('#666666').fontSize(12)
      .text('This is to certify that', 0, 260, { align: 'center', width: W });

    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(32)
      .text(studentName, 60, 284, { align: 'center', width: W - 120 });

    doc.fillColor('#666666').font('Helvetica').fontSize(12)
      .text('has successfully completed the course', 0, 329, { align: 'center', width: W });

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(23)
      .text(courseName, 60, 353, { align: 'center', width: W - 120 });

    doc.fillColor('#666666').font('Helvetica').fontSize(12)
      .text(`Awarded on ${formatDate(issuedAt)}`, 0, 394, { align: 'center', width: W });

    // Signature lines
    const lineY = 452;
    doc.moveTo(110, lineY).lineTo(310, lineY).lineWidth(1).stroke('#999999');
    doc.moveTo(W - 310, lineY).lineTo(W - 110, lineY).stroke('#999999');
    doc.fillColor('#555555').fontSize(11)
      .text('Director', 110, lineY + 8, { width: 200, align: 'center' })
      .text('Authorized Signature', W - 310, lineY + 8, { width: 200, align: 'center' });
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(12)
      .text('Olowoake Daniel Ayomide', 110, lineY - 16, { width: 200, align: 'center' })
      .text(INSTITUTION_NAME, W - 310, lineY - 16, { width: 200, align: 'center' });

    // Footer: certificate id + verification code
    doc.fillColor('#888888').font('Helvetica').fontSize(9)
      .text(`Certificate ID: ${certificateNumber}`, 60, H - 70, { width: 300, align: 'left' })
      .text(`Verify with ${INSTITUTION_NAME} using code: ${verificationCode}`, W - 360, H - 70, {
        width: 300,
        align: 'right',
      });

    doc.end();
  });
}

/**
 * Ensures the PDF for a certificate row exists in the private
 * "certificates" bucket and returns its storage path.
 */
export async function ensureCertificatePdf(certificate) {
  if (certificate.certificate_url && certificate.pdf_brand_version === CERTIFICATE_PDF_BRAND_VERSION) {
    return certificate.certificate_url;
  }

  const [{ data: student, error: sErr }, { data: course, error: cErr }] = await Promise.all([
    supabaseAdmin.from('profiles').select('full_name').eq('id', certificate.student_id).single(),
    supabaseAdmin.from('courses').select('title').eq('id', certificate.course_id).single(),
  ]);

  if (sErr || cErr) throw ApiError.internal('Unable to prepare certificate');

  const pdf = await buildCertificatePdf({
    studentName: student.full_name,
    courseName: course.title,
    issuedAt: certificate.issued_at,
    certificateNumber: certificate.certificate_number,
    verificationCode: certificate.verification_code,
  });

  // Rebrand the existing object in place when a legacy certificate already
  // has a stored path; certificate IDs, verification codes and statuses stay put.
  const path = certificate.certificate_url || `${certificate.id}.pdf`;
  await uploadObject(BUCKETS.certificates, path, pdf, 'application/pdf', { upsert: true });

  const { error } = await supabaseAdmin
    .from('certificates')
    .update({ certificate_url: path, pdf_brand_version: CERTIFICATE_PDF_BRAND_VERSION })
    .eq('id', certificate.id);
  if (error) throw ApiError.internal('Unable to store certificate file');

  return path;
}

/** Signed, short-lived download URL for a student's certificate. */
export async function certificateDownloadUrl(certificate, expiresInSeconds = 600) {
  const path = await ensureCertificatePdf(certificate);
  return createSignedUrl(BUCKETS.certificates, path, expiresInSeconds);
}

// Exported for the local PDF rendering regression test; not exposed as an API route.
export { buildCertificatePdf };
