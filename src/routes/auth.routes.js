import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { avatarUpload } from '../middleware/upload.js';
import * as auth from '../controllers/auth.controller.js';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  changePasswordSchema,
  updateProfileSchema,
} from '../validation/schemas.js';
import { z } from 'zod';

const router = Router();

// Multer parses the multipart body first so the zod schema sees fields.
const optionalPhoto = avatarUpload.single('photo');

router.post('/register', authLimiter, optionalPhoto, validate({ body: registerSchema }), auth.register);
router.post('/login', authLimiter, validate({ body: loginSchema }), auth.login);
router.post('/forgot-password', authLimiter, validate({ body: forgotPasswordSchema }), auth.forgotPassword);

router.post('/logout', authenticate, auth.logout);
router.post(
  '/change-password',
  authLimiter,
  authenticate,
  validate({ body: changePasswordSchema }),
  auth.changePassword
);
router.post(
  '/reset-password',
  authLimiter,
  authenticate, // recovery access token from the email link
  validate({ body: z.object({ new_password: changePasswordSchema.shape.new_password }) }),
  auth.resetPassword
);

export default router;
