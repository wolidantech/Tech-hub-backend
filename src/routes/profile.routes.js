import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { avatarUpload } from '../middleware/upload.js';
import * as auth from '../controllers/auth.controller.js';
import { updateProfileSchema } from '../validation/schemas.js';

const router = Router();

router.get('/me', authenticate, auth.getProfile);
router.put('/me', authenticate, avatarUpload.single('photo'), validate({ body: updateProfileSchema }), auth.updateProfile);

export default router;
