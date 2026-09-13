/**
 * WOLI DAN TECH HUB — CV Builder Controller
 * Public CV generation (guest + authenticated)
 * Per spec: unauthenticated can create/edit/preview/AI improve/export PDF
 */

import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import * as cvService from '../services/cv.service.js';
import { env } from '../config/env.js';

function getGuestSessionId(req) {
  return req.headers['x-guest-session'] || req.body?.guestSessionId || req.query?.guestSessionId || null;
}

function getUserId(req) {
  return req.profile?.id || null;
}

// POST /api/cv/create
export const createCv = asyncHandler(async (req, res) => {
  const { templateCode = 'professional', title, occupationId, personalInfo, summary, sections } = req.body;
  const userId = getUserId(req);
  const guestSessionId = getGuestSessionId(req);

  const { cv, guestSessionId: newGuestId } = await cvService.createCvDocument({
    userId,
    guestSessionId: guestSessionId || (userId ? null : undefined),
    templateCode,
    title: title || 'My CV',
    occupationId,
    personalInfo,
    summary,
    sections,
  });

  const full = await cvService.getCvDocument({ cvId: cv.id, userId, guestSessionId: newGuestId || guestSessionId });

  res.status(201).json({
    success: true,
    data: {
      cv: full,
      guestSessionId: newGuestId || guestSessionId,
    },
    message: 'CV created',
  });
});

// GET /api/cv/:id
export const getCv = asyncHandler(async (req, res) => {
  const cvId = req.params.id;
  const userId = getUserId(req);
  const guestSessionId = getGuestSessionId(req);

  const cv = await cvService.getCvDocument({ cvId, userId, guestSessionId });
  if (!cv) throw ApiError.notFound('CV not found', 'CV_NOT_FOUND');

  res.json({ success: true, data: { cv } });
});

// PUT /api/cv/:id
export const updateCv = asyncHandler(async (req, res) => {
  const cvId = req.params.id;
  const userId = getUserId(req);
  const guestSessionId = getGuestSessionId(req);

  const updated = await cvService.updateCvDocument({
    cvId,
    userId,
    guestSessionId,
    updates: req.body,
  });

  const full = await cvService.getCvDocument({ cvId, userId, guestSessionId });

  res.json({ success: true, data: { cv: full }, message: 'CV updated' });
});

// DELETE /api/cv/:id
export const deleteCv = asyncHandler(async (req, res) => {
  const cvId = req.params.id;
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required to delete CV');

  await cvService.deleteCvDocument({ cvId, userId });
  res.json({ success: true, message: 'CV deleted' });
});

// POST /api/cv/preview — returns structured preview data (no PDF)
export const previewCv = asyncHandler(async (req, res) => {
  const { cvId, templateCode } = req.body;
  const userId = getUserId(req);
  const guestSessionId = getGuestSessionId(req);

  if (!cvId) throw ApiError.badRequest('cvId required', 'VALIDATION_ERROR');

  const cv = await cvService.getCvDocument({ cvId, userId, guestSessionId });
  if (!cv) throw ApiError.notFound('CV not found', 'CV_NOT_FOUND');

  // If templateCode provided, fetch template config for preview
  let template = cv.cv_templates;
  if (templateCode) {
    const { data: tmpl } = await supabaseAdmin.from('cv_templates').select('*').eq('code', templateCode).eq('is_active', true).maybeSingle();
    if (tmpl) template = tmpl;
  }

  res.json({
    success: true,
    data: {
      cv,
      template,
      preview: {
        personal: cv.personal_info,
        summary: cv.summary,
        sections: cv.sections,
        templateConfig: template?.config || {},
      },
    },
  });
});

// POST /api/cv/export — PDF generation
export const exportCv = asyncHandler(async (req, res) => {
  const { cvId, templateCode } = req.body;
  const userId = getUserId(req);
  const guestSessionId = getGuestSessionId(req);

  if (!cvId) throw ApiError.badRequest('cvId required', 'VALIDATION_ERROR');

  const { exportRecord, downloadUrl, filePath } = await cvService.generateCvPdf({
    cvId,
    userId,
    guestSessionId,
    templateCode,
  });

  // For direct PDF download if requested ?format=pdf
  if (req.query.format === 'pdf' || req.body.format === 'pdf') {
    // Return signed URL and also allow direct stream if needed
    return res.json({
      success: true,
      data: {
        export: exportRecord,
        downloadUrl,
        filePath,
        expiresAt: exportRecord.expires_at,
      },
      message: 'CV exported to PDF',
    });
  }

  res.json({
    success: true,
    data: {
      export: exportRecord,
      downloadUrl,
      filePath,
      expiresAt: exportRecord.expires_at,
    },
    message: 'CV exported to PDF',
  });
});

// GET /api/cv/export/:id/download — secure download reference
export const downloadExport = asyncHandler(async (req, res) => {
  const exportId = req.params.id;
  const userId = getUserId(req);
  const guestSessionId = getGuestSessionId(req);

  const { data: exp, error } = await supabaseAdmin.from('cv_exports').select('*, cv_documents!inner(user_id, guest_session_id)').eq('id', exportId).maybeSingle();
  if (error || !exp) throw ApiError.notFound('Export not found', 'EXPORT_NOT_FOUND');

  // Access check
  const cvDoc = exp.cv_documents;
  if (cvDoc.user_id) {
    if (!userId || (cvDoc.user_id !== userId && req.profile?.role !== 'admin')) {
      throw ApiError.forbidden('Access denied', 'ACCESS_DENIED');
    }
  } else {
    if (cvDoc.guest_session_id !== guestSessionId && req.profile?.role !== 'admin') {
      // For guest, require matching session or admin
      if (!guestSessionId || cvDoc.guest_session_id !== guestSessionId) {
        throw ApiError.forbidden('Access denied', 'ACCESS_DENIED');
      }
    }
  }

  if (exp.status !== 'COMPLETED' || !exp.file_path) throw ApiError.badRequest('Export not ready', 'EXPORT_NOT_READY');

  // Check expiry for guest
  if (exp.expires_at && new Date(exp.expires_at) < new Date()) {
    throw ApiError.badRequest('Export expired, please re-export', 'EXPORT_EXPIRED');
  }

  const expiresIn = exp.user_id ? 3600 : 600;
  const { data: signed, error: signError } = await supabaseAdmin.storage.from('cv-exports').createSignedUrl(exp.file_path, expiresIn);
  if (signError) throw ApiError.internal('Unable to generate download URL');

  // Increment download count
  await supabaseAdmin.from('cv_exports').update({ download_count: (exp.download_count || 0) + 1 }).eq('id', exportId);

  res.json({ success: true, data: { downloadUrl: signed.signedUrl, expiresIn } });
});

// GET /api/cv/templates
export const listTemplates = asyncHandler(async (req, res) => {
  const templates = await cvService.listTemplates();
  res.json({ success: true, data: { templates } });
});

// GET /api/cv/occupations/search
export const searchOccupations = asyncHandler(async (req, res) => {
  const { q, query, category, limit, featured } = req.query;
  const searchQuery = q || query || '';
  const results = await cvService.searchOccupations({
    query: searchQuery,
    category,
    limit: limit ? parseInt(limit, 10) : 20,
    featured: featured === 'true',
  });
  res.json({ success: true, data: { occupations: results, query: searchQuery } });
});

// GET /api/cv/occupations/categories
export const listOccupationCategories = asyncHandler(async (req, res) => {
  const categories = await cvService.getOccupationCategories();
  res.json({ success: true, data: { categories } });
});

// POST /api/cv/ai/improve — AI-assisted wording, never fabricate
export const improveCvSection = asyncHandler(async (req, res) => {
  const { cvId, sectionType, content, occupationId } = req.body;
  if (!sectionType || !content) throw ApiError.badRequest('sectionType and content required', 'VALIDATION_ERROR');

  const userId = getUserId(req);
  const guestSessionId = getGuestSessionId(req);

  let occupation = null;
  if (occupationId) {
    const { data } = await supabaseAdmin.from('occupations').select('*').eq('id', occupationId).maybeSingle();
    occupation = data;
  }

  const prompt = await cvService.improveCvSection({ sectionType, content, occupation });

  // Call AI provider via gateway or direct
  // For now, return prompt and attempt to call OpenAI if key configured
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    // If no AI key, return improved via simple rules (fallback) — never fabricate
    return res.json({
      success: true,
      data: {
        improved: typeof content === 'string' ? content.trim() : JSON.stringify(content),
        note: 'AI key not configured, returning original with basic formatting. Configure OPENAI_API_KEY for AI improvement.',
        prompt, // for debugging, remove in production if needed
      },
    });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: cvService.AI_IMPROVE_PROMPT },
          { role: 'user', content: `Occupation: ${occupation?.title || 'General'}\nSection: ${sectionType}\nContent: ${typeof content === 'string' ? content : JSON.stringify(content)}` },
        ],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${errText.slice(0, 500)}`);
    }

    const json = await response.json();
    const improved = json.choices?.[0]?.message?.content?.trim() || content;

    // Audit log for AI improvement
    await supabaseAdmin.from('audit_logs').insert({
      admin_id: userId,
      action: 'CV_AI_IMPROVE',
      target_type: 'cv_document',
      target_id: cvId,
      description: `Improved ${sectionType} section via AI`,
    });

    res.json({ success: true, data: { improved, original: content, sectionType } });
  } catch (e) {
    console.error('AI improve error:', e.message);
    throw ApiError.internal('AI improvement failed, please try again', 'AI_ERROR');
  }
});

// GET /api/cv/my — list user's CVs
export const listMyCvs = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) throw ApiError.unauthorized('Authentication required');

  const { data, error } = await supabaseAdmin
    .from('cv_documents')
    .select('id, title, status, version, created_at, updated_at, cv_templates(code,name), occupations(title)')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) throw error;

  res.json({ success: true, data: { cvs: data } });
});
