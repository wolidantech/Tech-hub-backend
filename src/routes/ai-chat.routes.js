import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { aiUpload } from '../middleware/upload.js';
import * as aiChat from '../controllers/ai-chat.controller.js';
import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';

const router = Router();

router.use(authenticate);

// Core chat — general, study, coding, research, career, deep explanation
router.post('/chat', aiChat.chat);
router.post('/chat/stream', aiChat.chatStream);

// Conversations
router.get('/conversations', aiChat.listConversations);
router.get('/conversations/:id', aiChat.getConversation);
router.delete('/conversations/:id', aiChat.deleteConversation);

// File analysis — upload file to Supabase storage then record
router.post('/files/upload', aiUpload.single('file'), asyncHandler(async (req, res) => {
  const userId = req.profile.id;
  if (!req.file) throw ApiError.badRequest('File required', 'VALIDATION_ERROR');

  const fileName = req.file.originalname;
  const filePath = `${userId}/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  const { error: uploadError } = await supabaseAdmin.storage.from('ai-uploads').upload(filePath, req.file.buffer, {
    contentType: req.file.mimetype,
    upsert: false,
  });
  if (uploadError) throw ApiError.internal(`Upload failed: ${uploadError.message}`);

  // Try to extract text if plain text or pdf (basic)
  let extractedText = null;
  if (req.file.mimetype === 'text/plain' || req.file.mimetype === 'text/markdown' || req.file.mimetype === 'text/csv') {
    extractedText = req.file.buffer.toString('utf8').slice(0, 20000);
  }

  const { data, error } = await supabaseAdmin
    .from('ai_uploaded_files')
    .insert({
      user_id: userId,
      conversation_id: req.body.conversationId || null,
      file_name: fileName,
      file_path: filePath,
      file_type: req.file.mimetype,
      file_size: req.file.size,
      extracted_text: extractedText,
    })
    .select()
    .single();

  if (error) throw error;

  res.status(201).json({ success: true, data: { file: data } });
}));

router.post('/files/analyze', aiChat.analyzeFile);

// Web research with citations
router.post('/research', aiChat.webResearch);

export default router;
