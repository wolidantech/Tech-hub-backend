import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

process.env.SKIP_ENV_VALIDATION ||= 'true';
const { buildCertificatePdf } = await import('../src/services/certificate.service.js');

const certificateNumber = 'WDTH-2026-000001';
const verificationCode = 'WDTH-ABCD-1234';
const pdf = await buildCertificatePdf({
  studentName: 'Ada Student',
  courseName: 'Video Editing with CapCut',
  issuedAt: '2026-10-06T00:00:00.000Z',
  certificateNumber,
  verificationCode,
});

assert.ok(pdf.subarray(0, 8).toString('ascii').startsWith('%PDF-'), 'certificate output is a PDF');
const rawPdf = pdf.toString('latin1');
assert.ok(rawPdf.includes('DANQEL DIGITAL INSTITUTE'), 'PDF metadata uses the current institution');

// PDFKit compresses page streams and hex-encodes built-in-font glyphs. Decode
// those streams to check the visible document text rather than only comments.
const visibleText = [];
for (const match of rawPdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
  try {
    const content = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
    for (const [, hex] of content.matchAll(/<([0-9a-f]+)>/gi)) {
      visibleText.push(Buffer.from(hex, 'hex').toString('latin1').replaceAll('\u0095', '•'));
    }
  } catch {
    // Metadata/font streams need not be compressed page text.
  }
}
const rendered = visibleText.join('');
assert.ok(rendered.includes('DANQEL'), 'the vector logo wordmark is visible on the certificate');
assert.ok(rendered.includes('DIGITAL INSTITUTE'), 'the vector logo institutional line is visible');
assert.ok(rendered.includes('DANQEL DIGITAL INSTITUTE'), 'visible certificate issuer is rebranded');
assert.ok(rendered.includes('Technology • Science • Digital Learning'), 'visible certificate logo carries the new tagline');
assert.ok(rendered.includes('Olowoake Daniel Ayomide'), 'named director identity is preserved');
assert.ok(rendered.includes('Director'), 'director title is preserved');
assert.ok(rendered.includes(certificateNumber), 'certificate ID remains unchanged');
assert.ok(rendered.includes(verificationCode), 'verification code remains unchanged');

console.log('✓ certificate PDF contains the DANQEL vector logo/tagline, preserved director, and unchanged verification identifiers');
