import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as notifications from '../controllers/notifications.controller.js';
import { uuidParams } from '../validation/schemas.js';

const router = Router();

router.use(authenticate);

router.get('/', notifications.getNotifications);
router.post('/read-all', notifications.markAllNotificationsRead);
router.post('/:id/read', validate({ params: uuidParams }), notifications.markNotificationRead);

export default router;
