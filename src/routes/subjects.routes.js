import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import * as subjectsController from '../controllers/subjects.controller.js';

const router = Router();

// Public taxonomy — scalable global learning platform
router.get('/fields', subjectsController.listFields);
router.get('/fields/:fieldId/subjects', subjectsController.listSubjects);
router.get('/subjects', subjectsController.listSubjects);
router.get('/specializations', subjectsController.listSpecializations);
router.get('/:subjectId/specializations', subjectsController.listSpecializations);
router.get('/taxonomy', subjectsController.getFullTaxonomy);
router.get('/taxonomy/full', subjectsController.getFullTaxonomy);

// Admin management
router.post('/fields', authenticate, requireAdmin, subjectsController.createField);
router.post('/', authenticate, requireAdmin, subjectsController.createSubject);
router.post('/specializations', authenticate, requireAdmin, subjectsController.createSpecialization);

export default router;
