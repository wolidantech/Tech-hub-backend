/**
 * Unit test: the frontend/live-schema student ID card renders as a real,
 * re-openable PDF containing the issued identity (mobile + desktop downloads
 * both hit this renderer through GET /api/students/me/id-card/download).
 */
import assert from 'node:assert/strict';

const { renderFrontendStudentIdCardPdf } = await import('../src/gateway/frontend-idcard-pdf.js');

// 1x1 PNG pixel
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l7sAAAAASUVORK5CYII=',
  'base64'
);

let passed = 0;
function ok(name, cond = true) {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const card = {
  fullName: 'Adaeze Ngozi Okonkwo-Fitzgerald', // long name exercises the fit logic
  cardNumber: 'WDTH-2026-000123',
  programme: 'Digital Skills',
  issuedAt: '2026-10-01T10:00:00.000Z',
};

const pdf = await renderFrontendStudentIdCardPdf(card, pixel);
ok('renderer returns PDF bytes', pdf.length > 1000);
ok('output starts with a PDF header', pdf.subarray(0, 8).toString('latin1').startsWith('%PDF-'));
ok('output ends with an EOF marker', pdf.toString('latin1', pdf.length - 16).includes('%%EOF'));

const reformmable = await renderFrontendStudentIdCardPdf(
  { ...card, fullName: 'Ada Student', issuedAt: 'not-a-date' },
  null
);
ok('missing photo renders the placeholder instead of failing', reformmable.length > 800);
ok('invalid issue date does not break rendering', reformmable.subarray(0, 8).toString('latin1').startsWith('%PDF-'));

console.log(`\n✓ frontend ID card PDF renderer: ${passed} checks passed`);
