import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';
import { receiptUpload } from '../middleware/upload.js';
import * as payments from '../controllers/payments.controller.js';
import { enrollSchema, submitPaymentSchema, uuidParams } from '../validation/schemas.js';

const router = Router();
// NOTE: this router is mounted on the bare "/api" prefix, so auth is
// applied PER ROUTE (a router-wide "use(authenticate)" here would
// block every public route as well).

// "enroll-course" — starts the manual bank-transfer flow
router.post('/enrollments', authenticate, validate({ body: enrollSchema }), payments.enrollCourse);
router.get('/enrollments/me', authenticate, payments.getMyCourses);

// "submit-payment" + receipt upload + student payment history
router.post(
  '/payments',
  authenticate,
  paymentLimiter,
  receiptUpload.single('receipt'),
  validate({ body: submitPaymentSchema }),
  payments.submitPayment
);
router.get('/payments/me', authenticate, payments.getMyPayments);
router.get('/payments/:id/receipt-url', authenticate, validate({ params: uuidParams }), payments.getReceiptUrl);

export default router;
