import multer from 'multer';
import { env, RECEIPT_MIME_TYPES } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

const memoryStorage = multer.memoryStorage();

function makeUploader({ maxMb, mimeTypes }) {
  return multer({
    storage: memoryStorage,
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (!mimeTypes.includes(file.mimetype)) {
        return cb(
          ApiError.badRequest(
            `Invalid file type. Allowed types: ${mimeTypes.join(', ')}`,
            'INVALID_FILE_TYPE'
          )
        );
      }
      cb(null, true);
    },
  });
}

export const receiptUpload = makeUploader({ maxMb: env.maxReceiptSizeMb, mimeTypes: RECEIPT_MIME_TYPES });

export const avatarUpload = makeUploader({
  maxMb: 2,
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
});

export const thumbnailUpload = makeUploader({
  maxMb: 5,
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
});

export const resourceUpload = makeUploader({
  maxMb: env.maxResourceSizeMb,
  mimeTypes: [
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
  ],
});
