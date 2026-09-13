import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import * as cvController from '../controllers/cv.controller.js';

const router = Router();

// Public CV builder — unauthenticated can create/edit/preview/export per spec
// We use optionalAuth so both guest and registered work
router.post('/create', optionalAuth, cvController.createCv);
router.post('/preview', optionalAuth, cvController.previewCv);
router.post('/export', optionalAuth, cvController.exportCv);
router.get('/export/:id/download', optionalAuth, cvController.downloadExport);
router.post('/ai/improve', optionalAuth, cvController.improveCvSection);

// Templates & occupations — public
router.get('/templates', cvController.listTemplates);
router.get('/occupations/search', cvController.searchOccupations);
router.get('/occupations/categories', cvController.listOccupationCategories);

// Authenticated user's CVs
router.get('/my', authenticate, cvController.listMyCvs);
router.get('/:id', optionalAuth, cvController.getCv);
router.put('/:id', optionalAuth, cvController.updateCv);
router.delete('/:id', authenticate, cvController.deleteCv);

export default router;
