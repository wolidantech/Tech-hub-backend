import assert from 'node:assert/strict';

process.env.SKIP_ENV_VALIDATION ||= 'true';
const { renderStudentIdCardPdf } = await import('../src/services/student-id-card.service.js');

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=',
  'base64'
);
const pdf = await renderStudentIdCardPdf({
  full_name: 'Ada Student',
  student_number: 'WDTH-2026-000001',
}, pixel);
assert.ok(pdf.subarray(0, 8).toString('ascii').startsWith('%PDF-'), 'ID card output is a PDF');
assert.ok(pdf.length > 500, 'ID card contains rendered content and photo');
console.log('✓ student ID card PDF rendering check passed');
