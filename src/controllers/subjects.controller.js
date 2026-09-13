/**
 * WOLI DAN TECH HUB — Subject Taxonomy Controller
 * Global subject/category structure FIELD → SUBJECT → SPECIALIZATION → COURSE → MODULE → LESSON
 */

import { ApiError, asyncHandler } from '../utils/errors.js';
import * as subjectService from '../services/subject.service.js';
import { supabaseAdmin } from '../config/supabase.js';

// GET /api/subjects/fields
export const listFields = asyncHandler(async (req, res) => {
  const fields = await subjectService.listFields();
  res.json({ success: true, data: { fields } });
});

// GET /api/subjects/fields/:id/subjects
export const listSubjects = asyncHandler(async (req, res) => {
  const fieldId = req.params.fieldId || req.query.fieldId;
  const subjects = await subjectService.listSubjects({ fieldId });
  res.json({ success: true, data: { subjects } });
});

// GET /api/subjects/:id/specializations
export const listSpecializations = asyncHandler(async (req, res) => {
  const subjectId = req.params.subjectId || req.query.subjectId;
  const specializations = await subjectService.listSpecializations({ subjectId });
  res.json({ success: true, data: { specializations } });
});

// GET /api/subjects/taxonomy — full hierarchical
export const getFullTaxonomy = asyncHandler(async (req, res) => {
  const taxonomy = await subjectService.getFullTaxonomy();
  res.json({ success: true, data: { taxonomy } });
});

// Admin: POST /api/admin/subjects/fields
export const createField = asyncHandler(async (req, res) => {
  const { code, name, description, icon, color } = req.body;
  if (!name) throw ApiError.badRequest('Name required', 'VALIDATION_ERROR');
  const field = await subjectService.createField({ code, name, description, icon, color });

  await supabaseAdmin.from('audit_logs').insert({
    admin_id: req.profile.id,
    action: 'SUBJECT_FIELD_CREATED',
    target_type: 'subject_field',
    target_id: field.id,
    description: `Created field ${name}`,
  });

  res.status(201).json({ success: true, data: { field } });
});

// Admin: POST /api/admin/subjects
export const createSubject = asyncHandler(async (req, res) => {
  const { fieldId, code, name, description, level } = req.body;
  if (!fieldId || !name) throw ApiError.badRequest('fieldId and name required', 'VALIDATION_ERROR');
  const subject = await subjectService.createSubject({ fieldId, code, name, description, level });

  await supabaseAdmin.from('audit_logs').insert({
    admin_id: req.profile.id,
    action: 'SUBJECT_CREATED',
    target_type: 'subject',
    target_id: subject.id,
    description: `Created subject ${name}`,
  });

  res.status(201).json({ success: true, data: { subject } });
});

// Admin: POST /api/admin/subjects/specializations
export const createSpecialization = asyncHandler(async (req, res) => {
  const { subjectId, code, name, description } = req.body;
  if (!subjectId || !name) throw ApiError.badRequest('subjectId and name required', 'VALIDATION_ERROR');
  const spec = await subjectService.createSpecialization({ subjectId, code, name, description });

  await supabaseAdmin.from('audit_logs').insert({
    admin_id: req.profile.id,
    action: 'SPECIALIZATION_CREATED',
    target_type: 'specialization',
    target_id: spec.id,
    description: `Created specialization ${name}`,
  });

  res.status(201).json({ success: true, data: { specialization: spec } });
});
