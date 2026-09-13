/**
 * WOLI DAN TECH HUB — Admin Content Review Pipeline
 * Per spec sections 19-21, 30
 * Statuses: DRAFT, IN_REVIEW, APPROVED, PUBLISHED, UNPUBLISHED, ARCHIVED
 * Never auto-publish unreviewed AI content
 */

import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { parsePagination } from '../utils/helpers.js';
import { logAudit } from '../services/audit.service.js';
import * as aiCourseService from '../services/ai-course.service.js';
import * as aiResourceService from '../services/ai-resource.service.js';

// -----------------------------------------------------------------
// GET /api/admin/content — list AI generated content for review
// -----------------------------------------------------------------
export const listContent = asyncHandler(async (req, res) => {
  const { course_id, module_id, lesson_id, content_type, status = 'DRAFT', page = 1, limit = 20 } = req.query;

  const result = await aiCourseService.listContent({
    courseId: course_id,
    moduleId: module_id,
    lessonId: lesson_id,
    contentType: content_type,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json({ success: true, data: result });
});

// -----------------------------------------------------------------
// GET /api/admin/content/:id — content detail with quality flags
// -----------------------------------------------------------------
export const getContent = asyncHandler(async (req, res) => {
  const content = await aiCourseService.getContentById(req.params.id);
  if (!content) throw ApiError.notFound('Content not found', 'CONTENT_NOT_FOUND');

  res.json({ success: true, data: { content } });
});

// -----------------------------------------------------------------
// POST /api/admin/content/:id/approve — DRAFT → APPROVED
// -----------------------------------------------------------------
export const approveContent = asyncHandler(async (req, res) => {
  const contentId = req.params.id;
  const existing = await aiCourseService.getContentById(contentId);
  if (!existing) throw ApiError.notFound('Content not found', 'CONTENT_NOT_FOUND');
  if (existing.status !== 'DRAFT' && existing.status !== 'IN_REVIEW') {
    throw ApiError.badRequest(`Content is ${existing.status}, only DRAFT or IN_REVIEW can be approved`, 'INVALID_STATUS');
  }

  const approved = await aiCourseService.approveContent(contentId, req.profile.id);

  await logAudit({
    adminId: req.profile.id,
    action: 'AI_CONTENT_APPROVED',
    targetType: 'ai_generated_content',
    targetId: contentId,
    description: `AI content ${existing.content_type} v${existing.version} for course ${existing.course_id} approved`,
  });

  res.json({ success: true, message: 'Content approved — ready for publishing', data: { content: approved } });
});

// -----------------------------------------------------------------
// POST /api/admin/content/:id/publish — APPROVED → PUBLISHED
// -----------------------------------------------------------------
export const publishContent = asyncHandler(async (req, res) => {
  const contentId = req.params.id;
  const existing = await aiCourseService.getContentById(contentId);
  if (!existing) throw ApiError.notFound('Content not found', 'CONTENT_NOT_FOUND');

  try {
    const published = await aiCourseService.publishContent(contentId, req.profile.id);

    await logAudit({
      adminId: req.profile.id,
      action: 'AI_CONTENT_PUBLISHED',
      targetType: 'ai_generated_content',
      targetId: contentId,
      description: `AI content ${existing.content_type} v${existing.version} published`,
    });

    res.json({ success: true, message: 'Content published — now visible to students', data: { content: published } });
  } catch (e) {
    throw ApiError.badRequest(e.message, 'PUBLISH_FAILED');
  }
});

// -----------------------------------------------------------------
// POST /api/admin/content/:id/unpublish — PUBLISHED → UNPUBLISHED
// -----------------------------------------------------------------
export const unpublishContent = asyncHandler(async (req, res) => {
  const content = await aiCourseService.unpublishContent(req.params.id);

  await logAudit({
    adminId: req.profile.id,
    action: 'AI_CONTENT_UNPUBLISHED',
    targetType: 'ai_generated_content',
    targetId: req.params.id,
    description: `AI content ${content.content_type} unpublished`,
  });

  res.json({ success: true, message: 'Content unpublished', data: { content } });
});

// -----------------------------------------------------------------
// POST /api/admin/content/:id/regenerate — creates new version
// -----------------------------------------------------------------
export const regenerateContent = asyncHandler(async (req, res) => {
  const existing = await aiCourseService.getContentById(req.params.id);
  if (!existing) throw ApiError.notFound('Content not found', 'CONTENT_NOT_FOUND');

  // Create new job for same type
  const job = await aiCourseService.createGenerationJob({
    jobType: existing.content_type === 'QUIZ' ? 'QUIZ' : existing.content_type === 'LESSON_TEXT' ? 'LESSON_TEXT' : 'COURSE',
    input: { regenerateFrom: existing.id, ...existing.content, ...req.body },
    courseId: existing.course_id,
    moduleId: existing.module_id,
    lessonId: existing.lesson_id,
    contentType: existing.content_type,
    createdBy: req.profile.id,
  });

  await logAudit({
    adminId: req.profile.id,
    action: 'AI_CONTENT_REGENERATE_QUEUED',
    targetType: 'ai_generated_content',
    targetId: existing.id,
    description: `Regeneration queued for ${existing.content_type} v${existing.version}`,
  });

  res.status(202).json({ success: true, message: 'Regeneration queued — new version will be DRAFT', data: { job, previous_version: existing.version } });
});

// -----------------------------------------------------------------
// DELETE /api/admin/content/:id — delete DRAFT only, or archive if published
// -----------------------------------------------------------------
export const deleteContent = asyncHandler(async (req, res) => {
  const existing = await aiCourseService.getContentById(req.params.id);
  if (!existing) throw ApiError.notFound('Content not found', 'CONTENT_NOT_FOUND');

  if (['PUBLISHED', 'APPROVED'].includes(existing.status)) {
    // Archive instead of delete
    const { data, error } = await supabaseAdmin
      .from('ai_generated_content')
      .update({ status: 'ARCHIVED', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw ApiError.internal('Unable to archive content');

    await logAudit({
      adminId: req.profile.id,
      action: 'AI_CONTENT_ARCHIVED',
      targetType: 'ai_generated_content',
      targetId: req.params.id,
      description: `AI content ${existing.content_type} archived (was ${existing.status})`,
    });

    return res.json({ success: true, message: 'Content has been published before, archived instead of deleted', data: { content: data } });
  }

  const { error } = await supabaseAdmin.from('ai_generated_content').delete().eq('id', req.params.id);
  if (error) throw ApiError.internal('Unable to delete content');

  await logAudit({
    adminId: req.profile.id,
    action: 'AI_CONTENT_DELETED',
    targetType: 'ai_generated_content',
    targetId: req.params.id,
    description: `AI content ${existing.content_type} v${existing.version} deleted`,
  });

  res.json({ success: true, message: 'Content deleted' });
});

// -----------------------------------------------------------------
// GET /api/admin/content/:id/versions — list versions
// -----------------------------------------------------------------
export const listVersions = asyncHandler(async (req, res) => {
  const existing = await aiCourseService.getContentById(req.params.id);
  if (!existing) throw ApiError.notFound('Content not found', 'CONTENT_NOT_FOUND');

  const { data, error, count } = await supabaseAdmin
    .from('ai_generated_content')
    .select('*', { count: 'exact' })
    .eq('course_id', existing.course_id)
    .eq('content_type', existing.content_type)
    .eq('module_id', existing.module_id || null)
    .eq('lesson_id', existing.lesson_id || null)
    .order('version', { ascending: false });

  if (error) throw ApiError.internal('Unable to list versions');

  res.json({ success: true, data: { versions: data, total: count } });
});

// -----------------------------------------------------------------
// POST /api/admin/content/:id/restore — restore previous version
// -----------------------------------------------------------------
export const restoreVersion = asyncHandler(async (req, res) => {
  const { version } = req.body;
  if (!version) throw ApiError.badRequest('version required', 'VALIDATION_ERROR');

  const existing = await aiCourseService.getContentById(req.params.id);
  if (!existing) throw ApiError.notFound('Content not found', 'CONTENT_NOT_FOUND');

  const { data: targetVersion } = await supabaseAdmin
    .from('ai_generated_content')
    .select('*')
    .eq('course_id', existing.course_id)
    .eq('content_type', existing.content_type)
    .eq('version', version)
    .maybeSingle();

  if (!targetVersion) throw ApiError.notFound('Version not found', 'VERSION_NOT_FOUND');

  // Create new version with old content
  const newContent = await aiCourseService.createGeneratedContent({
    jobId: null,
    courseId: targetVersion.course_id,
    moduleId: targetVersion.module_id,
    lessonId: targetVersion.lesson_id,
    contentType: targetVersion.content_type,
    content: targetVersion.content,
    generatedBy: req.profile.id,
  });

  await logAudit({
    adminId: req.profile.id,
    action: 'AI_CONTENT_RESTORED',
    targetType: 'ai_generated_content',
    targetId: newContent.content.id,
    description: `Restored version ${version} of ${targetVersion.content_type} as new DRAFT v${newContent.content.version}`,
  });

  res.status(201).json({ success: true, message: `Version ${version} restored as new DRAFT v${newContent.content.version}`, data: newContent });
});

// -----------------------------------------------------------------
// Resource review
// -----------------------------------------------------------------
export const listResources = asyncHandler(async (req, res) => {
  const { course_id, module_id, lesson_id, resource_type, is_approved, page, limit } = req.query;
  const result = await aiResourceService.listResources({
    courseId: course_id,
    moduleId: module_id,
    lessonId: lesson_id,
    resourceType: resource_type,
    isApproved: is_approved !== undefined ? is_approved === 'true' : undefined,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
  });
  res.json({ success: true, data: result });
});

export const approveResource = asyncHandler(async (req, res) => {
  const resource = await aiResourceService.approveResource(req.params.id, req.profile.id);
  await logAudit({
    adminId: req.profile.id,
    action: 'RESOURCE_APPROVED',
    targetType: 'course_resources',
    targetId: req.params.id,
    description: `Resource ${resource.title} approved`,
  });
  res.json({ success: true, message: 'Resource approved', data: { resource } });
});
