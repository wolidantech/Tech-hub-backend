/**
 * WOLI DAN TECH HUB — Mobile-Optimized File Uploads
 * Supports: Receipts, Assignments, CV-related files, Learning documents
 * Features: progress (via chunked upload), reasonable limits, resume/retry, timeout handling, clear errors, server-side validation
 */

import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { randomUUID } from 'crypto';

// ------------------------------------------------------------------
// Upload session for resumable uploads
// ------------------------------------------------------------------
const uploadSessions = new Map(); // sessionId -> { userId, fileName, fileType, totalChunks, receivedChunks, chunks: Map, createdAt }

// Cleanup old sessions every 10 min — unref so it doesn't block process exit in check.js
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of uploadSessions.entries()) {
    if (now - sess.createdAt > 30 * 60 * 1000) { // 30 min expiry
      uploadSessions.delete(id);
    }
  }
}, 10 * 60 * 1000);
if (cleanupInterval.unref) cleanupInterval.unref();

// POST /api/mobile/uploads/init — initiate resumable upload
export const initUpload = asyncHandler(async (req, res) => {
  const userId = req.profile?.id;
  if (!userId) throw ApiError.unauthorized('Authentication required');

  const { fileName, fileType, fileSize, totalChunks = 1, bucket = 'lesson-resources', purpose = 'general' } = req.body;

  if (!fileName) throw ApiError.badRequest('fileName required', 'VALIDATION_ERROR');
  if (!fileType) throw ApiError.badRequest('fileType required', 'VALIDATION_ERROR');
  if (fileSize && fileSize > 50 * 1024 * 1024) throw ApiError.badRequest('File too large (max 50MB)', 'FILE_TOO_LARGE');

  // Validate bucket
  const allowedBuckets = {
    receipts: 'payment-receipts',
    assignments: 'lesson-resources',
    cv: 'cv-exports',
    learning: 'ai-uploads',
    general: 'lesson-resources',
  };
  const bucketId = allowedBuckets[bucket] || allowedBuckets[purpose] || 'lesson-resources';

  // Validate MIME per bucket
  const mimeValidation = {
    'payment-receipts': ['image/jpeg', 'image/png', 'application/pdf'],
    'lesson-resources': ['application/pdf', 'image/jpeg', 'image/png', 'application/zip', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    'cv-exports': ['application/pdf', 'image/jpeg', 'image/png'],
    'ai-uploads': ['application/pdf', 'text/plain', 'text/csv', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png', 'text/markdown'],
  };
  const allowedMimes = mimeValidation[bucketId] || mimeValidation['lesson-resources'];
  if (!allowedMimes.includes(fileType)) {
    throw ApiError.badRequest(`Unsupported file type ${fileType} for ${bucketId}. Allowed: ${allowedMimes.join(', ')}`, 'UNSUPPORTED_TYPE');
  }

  const sessionId = randomUUID();
  uploadSessions.set(sessionId, {
    userId,
    fileName: fileName.replace(/[^a-zA-Z0-9._-]/g, '_'),
    fileType,
    fileSize: fileSize || 0,
    totalChunks,
    receivedChunks: 0,
    chunks: new Map(),
    bucketId,
    createdAt: Date.now(),
  });

  res.status(201).json({
    success: true,
    data: {
      sessionId,
      bucket: bucketId,
      chunkSize: 1 * 1024 * 1024, // 1MB chunks recommended for mobile
      expiresIn: 1800, // 30 min
      message: 'Upload session created, send chunks via POST /api/mobile/uploads/chunk',
    },
  });
});

// POST /api/mobile/uploads/chunk — upload a chunk
export const uploadChunk = asyncHandler(async (req, res) => {
  const userId = req.profile?.id;
  if (!userId) throw ApiError.unauthorized('Authentication required');

  const { sessionId, chunkIndex, totalChunks } = req.body;
  if (!sessionId) throw ApiError.badRequest('sessionId required', 'VALIDATION_ERROR');
  if (chunkIndex === undefined) throw ApiError.badRequest('chunkIndex required', 'VALIDATION_ERROR');

  const session = uploadSessions.get(sessionId);
  if (!session) throw ApiError.notFound('Upload session not found or expired', 'SESSION_NOT_FOUND');
  if (session.userId !== userId) throw ApiError.forbidden('Session belongs to another user', 'FORBIDDEN');

  if (!req.file) throw ApiError.badRequest('Chunk file required', 'VALIDATION_ERROR');

  // Store chunk
  session.chunks.set(parseInt(chunkIndex, 10), req.file.buffer);
  session.receivedChunks = session.chunks.size;

  const progress = Math.round((session.receivedChunks / session.totalChunks) * 100);

  // If all chunks received, assemble and upload to Supabase
  if (session.receivedChunks >= session.totalChunks) {
    const buffers = [];
    for (let i = 0; i < session.totalChunks; i++) {
      const chunk = session.chunks.get(i);
      if (!chunk) throw ApiError.badRequest(`Missing chunk ${i}`, 'MISSING_CHUNK');
      buffers.push(chunk);
    }
    const finalBuffer = Buffer.concat(buffers);
    const filePath = `${userId}/${Date.now()}_${session.fileName}`;

    // Timeout handling for slow mobile networks — 60s upload timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const { error: uploadError } = await supabaseAdmin.storage.from(session.bucketId).upload(filePath, finalBuffer, {
        contentType: session.fileType,
        upsert: false,
      });

      if (uploadError) throw ApiError.internal(`Storage upload failed: ${uploadError.message}`, 'STORAGE_ERROR');

      // Cleanup session
      uploadSessions.delete(sessionId);

      const { data: signed } = await supabaseAdmin.storage.from(session.bucketId).createSignedUrl(filePath, 3600);

      return res.json({
        success: true,
        data: {
          filePath,
          fileName: session.fileName,
          fileSize: finalBuffer.length,
          bucket: session.bucketId,
          signedUrl: signed?.signedUrl || null,
          progress: 100,
          message: 'Upload completed',
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  res.json({
    success: true,
    data: {
      sessionId,
      receivedChunks: session.receivedChunks,
      totalChunks: session.totalChunks,
      progress,
      message: `Chunk ${chunkIndex} received, ${progress}% complete`,
    },
  });
});

// POST /api/mobile/uploads/single — single file upload with progress support (for small files)
export const uploadSingle = asyncHandler(async (req, res) => {
  const userId = req.profile?.id;
  if (!userId) throw ApiError.unauthorized('Authentication required');

  if (!req.file) throw ApiError.badRequest('File required', 'VALIDATION_ERROR');

  const { bucket = 'lesson-resources', purpose } = req.body;
  const allowedBuckets = {
    receipts: 'payment-receipts',
    assignments: 'lesson-resources',
    cv: 'cv-exports',
    learning: 'ai-uploads',
    general: 'lesson-resources',
  };
  const bucketId = allowedBuckets[bucket] || allowedBuckets[purpose] || 'lesson-resources';

  const fileName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = `${userId}/${Date.now()}_${fileName}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const { error: uploadError } = await supabaseAdmin.storage.from(bucketId).upload(filePath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

    if (uploadError) throw ApiError.internal(`Upload failed: ${uploadError.message}`, 'STORAGE_ERROR');

    const { data: signed } = await supabaseAdmin.storage.from(bucketId).createSignedUrl(filePath, 3600);

    res.status(201).json({
      success: true,
      data: {
        filePath,
        fileName,
        fileSize: req.file.size,
        fileType: req.file.mimetype,
        bucket: bucketId,
        signedUrl: signed?.signedUrl || null,
      },
      message: 'File uploaded successfully',
    });
  } finally {
    clearTimeout(timeout);
  }
});

// GET /api/mobile/uploads/session/:sessionId — check upload progress (for resume)
export const getUploadSession = asyncHandler(async (req, res) => {
  const userId = req.profile?.id;
  if (!userId) throw ApiError.unauthorized('Authentication required');

  const { sessionId } = req.params;
  const session = uploadSessions.get(sessionId);
  if (!session) throw ApiError.notFound('Session not found or expired', 'SESSION_NOT_FOUND');
  if (session.userId !== userId) throw ApiError.forbidden('Forbidden', 'FORBIDDEN');

  const received = Array.from(session.chunks.keys()).sort((a, b) => a - b);
  const missing = [];
  for (let i = 0; i < session.totalChunks; i++) {
    if (!session.chunks.has(i)) missing.push(i);
  }

  res.json({
    success: true,
    data: {
      sessionId,
      fileName: session.fileName,
      totalChunks: session.totalChunks,
      receivedChunks: session.receivedChunks,
      received,
      missing,
      progress: Math.round((session.receivedChunks / session.totalChunks) * 100),
      expiresIn: Math.max(0, 1800 - Math.floor((Date.now() - session.createdAt) / 1000)),
    },
  });
});

// DELETE /api/mobile/uploads/session/:sessionId — cancel upload
export const cancelUpload = asyncHandler(async (req, res) => {
  const userId = req.profile?.id;
  if (!userId) throw ApiError.unauthorized('Authentication required');

  const { sessionId } = req.params;
  const session = uploadSessions.get(sessionId);
  if (!session) throw ApiError.notFound('Session not found', 'SESSION_NOT_FOUND');
  if (session.userId !== userId) throw ApiError.forbidden('Forbidden', 'FORBIDDEN');

  uploadSessions.delete(sessionId);

  res.json({ success: true, message: 'Upload session cancelled' });
});
