import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { timeoutMiddleware, requestIdMiddleware } from '../middleware/mobile.js';
import { aiUpload } from '../middleware/upload.js';
import * as mobileUploads from '../controllers/mobile-uploads.controller.js';
import multer from 'multer';

const router = Router();

// Mobile upload optimizations
router.use(requestIdMiddleware);
router.use(timeoutMiddleware(60000)); // 60s for uploads
router.use(authenticate);

// Single file upload — small files, with progress support via client XHR
router.post('/single', aiUpload.single('file'), mobileUploads.uploadSingle);

// Resumable chunked upload — for large files and slow/intermittent mobile networks
// Init session
router.post('/init', mobileUploads.initUpload);

// Upload chunk — supports retry, resume
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per chunk
});

router.post('/chunk', chunkUpload.single('chunk'), mobileUploads.uploadChunk);

// Check session progress — for resume after interruption
router.get('/session/:sessionId', mobileUploads.getUploadSession);

// Cancel session
router.delete('/session/:sessionId', mobileUploads.cancelUpload);

export default router;
