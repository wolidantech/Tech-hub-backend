import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as adminContent from '../controllers/admin-content.controller.js';
import { z } from 'zod';
import { uuidParams } from '../validation/schemas.js';

const router = Router();
router.use(authenticate, requireAdmin);

const contentIdParam = z.object({ id: z.string().uuid() });
const versionSchema = z.object({ version: z.coerce.number().int().positive() });

// Content review pipeline: DRAFT → APPROVED → PUBLISHED
router.get('/content', adminContent.listContent);
router.get('/content/:id', validate({ params: contentIdParam }), adminContent.getContent);
router.get('/content/:id/versions', validate({ params: contentIdParam }), adminContent.listVersions);
router.post('/content/:id/approve', validate({ params: contentIdParam }), adminContent.approveContent);
router.post('/content/:id/publish', validate({ params: contentIdParam }), adminContent.publishContent);
router.post('/content/:id/unpublish', validate({ params: contentIdParam }), adminContent.unpublishContent);
router.post('/content/:id/regenerate', validate({ params: contentIdParam }), adminContent.regenerateContent);
router.post('/content/:id/restore', validate({ params: z.object({ id: z.string().uuid(), version: z.coerce.number().int().positive() }) }), adminContent.restoreVersion);
router.delete('/content/:id', validate({ params: contentIdParam }), adminContent.deleteContent);

// Resources
router.get('/resources', adminContent.listResources);
router.post('/resources/:id/approve', validate({ params: contentIdParam }), adminContent.approveResource);

export default router;
