import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as certificates from '../controllers/certificates.controller.js';
import { uuidParams } from '../validation/schemas.js';

const router = Router();

router.get('/me', authenticate, certificates.getMyCertificates);
router.get('/:id', authenticate, validate({ params: uuidParams }), certificates.getCertificate);

export default router;
