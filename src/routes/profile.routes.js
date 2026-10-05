import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { avatarUpload } from '../middleware/upload.js';
import * as auth from '../controllers/auth.controller.js';
import * as studentIdCard from '../controllers/student-id-card.controller.js';
import { updateProfileSchema } from '../validation/schemas.js';

const router = Router();

router.get('/me', authenticate, auth.getProfile);
router.put('/me', authenticate, avatarUpload.single('photo'), validate({ body: updateProfileSchema }), auth.updateProfile);
router.get('/me/id-card', authenticate, studentIdCard.getMyIdCard);
router.post('/me/id-card/regenerate', authenticate, studentIdCard.regenerateMyIdCard);

export default router;
