import multer from 'multer';
import { ApiError } from '../utils/errors.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const allowedMimeTypes = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'text/markdown',
]);

export const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (allowedMimeTypes.has(file.mimetype)) cb(null, true);
    else cb(ApiError.badRequest(`Unsupported file type: ${file.mimetype}`, 'UNSUPPORTED_TYPE'));
  },
});

export const cvPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(ApiError.badRequest(`Unsupported photo type: ${file.mimetype}`, 'UNSUPPORTED_TYPE'));
  },
});

// Legacy avatar upload for auth routes
export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(ApiError.badRequest(`Unsupported avatar type: ${file.mimetype}`, 'UNSUPPORTED_TYPE'));
  },
});

export const paymentReceiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'application/pdf']);
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(ApiError.badRequest(`Unsupported receipt type: ${file.mimetype}`, 'UNSUPPORTED_TYPE'));
  },
});

// Alias for backwards compatibility
export const receiptUpload = paymentReceiptUpload;

export const thumbnailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(ApiError.badRequest(`Unsupported thumbnail type: ${file.mimetype}`, 'UNSUPPORTED_TYPE'));
  },
});

export const resourceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/zip',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]);
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(ApiError.badRequest(`Unsupported resource type: ${file.mimetype}`, 'UNSUPPORTED_TYPE'));
  },
});
