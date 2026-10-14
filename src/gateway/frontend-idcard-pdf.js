/**
 * Print-ready PDF for the FRONTEND/live student ID card
 * (student_id_cards, migration 011 — the card the React UI displays).
 *
 * It renders the identity exactly as issued by the database: same card
 * number, name, programme, photo and issue date. The backend never allocates
 * numbers here; issuing stays with issue_student_id_card().
 */
import PDFDocument from 'pdfkit';
import { PassThrough } from 'node:stream';

const CARD_W = 540; // points — CR80 landscape scaled for a detailed A4 print
const CARD_H = 340;

const NAVY = '#071233';
const NAVY_2 = '#0a1a4a';
const CYAN = '#22d3ee';
const CYAN_DARK = '#0891b2';
const WHITE = '#f8fafc';
const MUTED = '#94a3c6';

const PROGRAMME_FALLBACK = 'Digital Skills';

function fitText(doc, text, maxChars) {
  const value = String(text || '');
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

/**
 * @param {object} card   - row from student_id_cards (camelCase keys)
 * @param {Buffer|null} photo - JPEG/PNG photo, or null to draw the placeholder
 * @returns {Promise<Buffer>}
 */
export async function renderFrontendStudentIdCardPdf(card, photo) {
  const doc = new PDFDocument({ size: [CARD_W, CARD_H], margin: 0, info: { Title: `DANQEL Student ID — ${card.cardNumber}` } });
  const stream = new PassThrough();
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  doc.pipe(stream);

  // ---------- background ----------
  doc.save();
  doc.roundedRect(10, 10, CARD_W - 20, CARD_H - 20, 22).fill(NAVY);
  doc.restore();

  // accent glows
  doc.save();
  doc.circle(CARD_W - 30, 20, 130).fillOpacity(0.16).fill(CYAN_DARK);
  doc.circle(20, CARD_H - 10, 90).fillOpacity(0.10).fill(CYAN);
  doc.restore();
  doc.fillOpacity(1); // reset for text

  // frame
  doc.save();
  doc.roundedRect(10, 10, CARD_W - 20, CARD_H - 20, 22)
    .lineWidth(1.4)
    .strokeColor('#1e3a8a')
    .stroke();
  doc.restore();

  // ---------- header ----------
  doc.save();
  doc.roundedRect(34, 32, 22, 22, 6).fill(CYAN);
  doc
    .fillColor(NAVY)
    .font('Helvetica-Bold')
    .fontSize(13)
    .text('D', 34, 36.5, { width: 22, align: 'center' });
  doc.restore();

  doc
    .fillColor(CYAN)
    .font('Helvetica-Bold')
    .fontSize(11.5)
    .text('DANQEL DIGITAL INSTITUTE', 64, 34, { characterSpacing: 1.2 });
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(7.5)
    .text('Technology • Science • Digital Learning', 64, 48, { characterSpacing: 0.6 });

  doc
    .fillColor(MUTED)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text('STUDENT ID CARD', CARD_W - 34 - 130, 38, { width: 130, align: 'right', characterSpacing: 1.4 });

  // ---------- photo ----------
  const px = 34;
  const py = 78;
  const pw = 108;
  const ph = 138;
  doc.save();
  doc.roundedRect(px - 3, py - 3, pw + 6, ph + 6, 14).lineWidth(1).strokeColor('#334f9e').stroke();
  doc.roundedRect(px, py, pw, ph, 11).clip();
  doc.rect(px, py, pw, ph).fill('#0e1c44');
  if (photo && photo.length > 32) {
    try {
      doc.image(photo, px, py, { fit: [pw, ph], align: 'center', valign: 'center' });
    } catch {
      // Corrupt/unsupported image: keep the neutral placeholder instead of failing the download.
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(9)
        .text('PHOTO', px, py + ph / 2 - 5, { width: pw, align: 'center' });
    }
  } else {
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(9)
      .text('PHOTO', px, py + ph / 2 - 5, { width: pw, align: 'center' });
  }
  doc.restore();

  // ---------- identity ----------
  const ix = px + pw + 26;
  const iw = CARD_W - ix - 34;

  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('FULL NAME', ix, py + 4, { characterSpacing: 1.2 });
  doc
    .fillColor(WHITE)
    .font('Helvetica-Bold')
    .fontSize(19)
    .text(fitText(doc, card.fullName, 34), ix, py + 16, { width: iw });

  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('PROGRAMME', ix, py + 52, { characterSpacing: 1.2 });
  doc
    .fillColor('#cbd5f5')
    .font('Helvetica')
    .fontSize(11.5)
    .text(fitText(doc, card.programme || PROGRAMME_FALLBACK, 42), ix, py + 63, { width: iw });

  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('CARD NUMBER', ix, py + 92, { characterSpacing: 1.2 });
  doc
    .fillColor(CYAN)
    .font('Courier-Bold')
    .fontSize(14.5)
    .text(card.cardNumber, ix, py + 103, { width: iw, characterSpacing: 1 });

  const issued = card.issuedAt ? new Date(card.issuedAt) : null;
  const issuedText =
    issued && !Number.isNaN(issued.getTime())
      ? issued.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: '2-digit' })
      : '—';
  doc
    .fillColor(MUTED)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text('ISSUED', CARD_W - 34 - 110, py + 92, { width: 110, align: 'right', characterSpacing: 1.2 });
  doc
    .fillColor('#cbd5f5')
    .font('Helvetica')
    .fontSize(10.5)
    .text(issuedText, CARD_W - 34 - 110, py + 103, { width: 110, align: 'right' });

  // ---------- footer band ----------
  doc.save();
  doc.moveTo(34, CARD_H - 84).lineTo(CARD_W - 34, CARD_H - 84).lineWidth(0.8).strokeColor('#1e3a8a').stroke();
  doc.restore();
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(8.4)
    .text('This card confirms that the holder is an enrolled student of DANQEL DIGITAL INSTITUTE.',
      34, CARD_H - 70, { width: CARD_W - 68 });
  doc
    .fillColor('#5b6ea3')
    .font('Helvetica')
    .fontSize(7.4)
    .text('Verify this card against the student records held by the institute. If found, please return it to the institute.',
      34, CARD_H - 55, { width: CARD_W - 68 });

  doc.save();
  doc.roundedRect(34, CARD_H - 38, 96, 20, 10).lineWidth(1).strokeColor(CYAN_DARK).stroke();
  doc
    .fillColor(CYAN)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text('VALID ID', 34, CARD_H - 32, { width: 96, align: 'center', characterSpacing: 1.6 });
  doc.restore();

  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(7.6)
    .text('danqel.edu • Student Records', CARD_W - 34 - 220, CARD_H - 32, { width: 220, align: 'right' });

  doc.end();
  return done;
}

export default renderFrontendStudentIdCardPdf;
