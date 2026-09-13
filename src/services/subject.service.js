/**
 * WOLI DAN TECH HUB — Global Subject Taxonomy Service
 * Hierarchical: FIELD → SUBJECT → SPECIALIZATION → COURSE → MODULE → LESSON
 */

import { supabaseAdmin } from '../config/supabase.js';

export async function listFields({ activeOnly = true } = {}) {
  let q = supabaseAdmin.from('subject_fields').select('*').order('name');
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function listSubjects({ fieldId, activeOnly = true } = {}) {
  let q = supabaseAdmin.from('subjects').select('*, subject_fields(name,code)').order('name');
  if (fieldId) q = q.eq('field_id', fieldId);
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function listSpecializations({ subjectId, activeOnly = true } = {}) {
  let q = supabaseAdmin.from('subject_specializations').select('*, subjects(name, field_id)').order('name');
  if (subjectId) q = q.eq('subject_id', subjectId);
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function getFullTaxonomy() {
  const fields = await listFields();
  const subjects = await listSubjects();
  const specializations = await listSpecializations();

  return fields.map(field => ({
    ...field,
    subjects: subjects.filter(s => s.field_id === field.id).map(sub => ({
      ...sub,
      specializations: specializations.filter(sp => sp.subject_id === sub.id),
    })),
  }));
}

export async function createField({ code, name, description, icon, color }) {
  const { data, error } = await supabaseAdmin.from('subject_fields').insert({ code, name, description, icon, color }).select().single();
  if (error) throw error;
  return data;
}

export async function createSubject({ fieldId, code, name, description, level = 'GENERAL' }) {
  const { data, error } = await supabaseAdmin.from('subjects').insert({ field_id: fieldId, code, name, description, level }).select().single();
  if (error) throw error;
  return data;
}

export async function createSpecialization({ subjectId, code, name, description }) {
  const { data, error } = await supabaseAdmin.from('subject_specializations').insert({ subject_id: subjectId, code, name, description }).select().single();
  if (error) throw error;
  return data;
}
