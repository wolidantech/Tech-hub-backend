import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import * as certificates from '../controllers/certificates.controller.js';
import * as auth from '../controllers/auth.controller.js';
import { verifyCertificateParams } from '../validation/schemas.js';

const router = Router();

// Public certificate verification — no account required
router.get(
  '/verify-certificate/:identifier',
  validate({ params: verifyCertificateParams }),
  certificates.verifyCertificate
);

// Platform bank details for the payment page (requires a login so the
// data is not scraped, but it holds no secrets anyway)
router.get('/settings/bank-details', authenticate, auth.getBankDetails);

export default router;
