/**
 * Frontend student ID card downloads (live schema: student_id_cards, migration 011).
 *
 * The frontend issues card ROWS via issue_student_id_card() but has no PDF.
 * These routes build the PDF on demand from the exact issued row — the
 * download never mints a new identity:
 *
 *   GET /api/students/me/id-card/download              (student)
 *   GET /api/admin/students/:userId/id-card/download   (admin)
 *
 * The photo lives in the `avatars` bucket and is fetched with the service
 * role, so the same endpoint works on phones and desktops with normal
 * browser download behaviour (Content-Disposition: attachment).
 */
import { renderFrontendStudentIdCardPdf } from './frontend-idcard-pdf.js';
import { httpError, assertUuid } from './frontend-access.js';

const CARD_SELECT =
  'id,user_id,card_number,full_name,photo_path,programme,issued_at,status';

async function loadCard(supabase, userId) {
  const rows = await supabase.rest('student_id_cards', {
    select: CARD_SELECT,
    user_id: `eq.${userId}`,
    limit: '1',
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createFrontendIdCardHandlers({ supabase, logger = console }) {
  async function sendCardPdf(res, userId) {
    const row = await loadCard(supabase, userId);
    if (!row) {
      throw httpError(
        404,
        'ID_CARD_NOT_FOUND',
        'No student ID card has been issued yet. Generate your card first — it requires a profile photo.'
      );
    }
    if (row.status !== 'active') {
      throw httpError(
        410,
        'ID_CARD_REVOKED',
        'This student ID card has been revoked. Please contact the institute.'
      );
    }

    let photo = null;
    if (row.photo_path) {
      try {
        const object = await supabase.storageDownload('avatars', row.photo_path);
        photo = object.buffer;
      } catch (error) {
        logger.warn?.({ route: 'id-card-download', outcome: 'photo_unavailable', status: error?.status });
        throw httpError(
          409,
          'CARD_PHOTO_UNAVAILABLE',
          'The photo attached to this ID card could not be loaded. Re-upload your profile photo and try again.'
        );
      }
    } else {
      throw httpError(
        409,
        'CARD_PHOTO_UNAVAILABLE',
        'This ID card has no photo attached. Upload a profile photo before downloading.'
      );
    }

    const pdf = await renderFrontendStudentIdCardPdf(
      {
        fullName: row.full_name,
        cardNumber: row.card_number,
        programme: row.programme,
        issuedAt: row.issued_at,
      },
      photo
    );

    const filename = `DANQEL-Student-ID-${row.card_number}.pdf`;
    res.status(200);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(pdf.length),
      'Cache-Control': 'private, no-store',
    });
    res.end(pdf);
  }

  return {
    /** The signed-in student downloads their own card. */
    async downloadMine(req, res) {
      await sendCardPdf(res, req.userId);
    },

    /** An administrator downloads any student's card (support/printing desk). */
    async downloadForAdmin(req, res) {
      const userId = assertUuid(req.params.userId, 'userId');
      await sendCardPdf(res, userId);
    },
  };
}

export default createFrontendIdCardHandlers;
