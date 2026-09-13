import { Router } from 'express';
import { authenticate, requireAdmin, optionalAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';

const router = Router();

// Public search — scalable occupation database, thousands support
router.get('/search', optionalAuth, asyncHandler(async (req, res) => {
  const { q, query, category, limit = 20, featured } = req.query;
  const searchQuery = (q || query || '').toLowerCase().trim();
  let dbQuery = supabaseAdmin.from('occupations').select('*').eq('is_active', true).limit(Math.min(parseInt(limit, 10) || 20, 50));

  if (searchQuery) dbQuery = dbQuery.or(`title.ilike.%${searchQuery}%,normalized_title.ilike.%${searchQuery}%,category.ilike.%${searchQuery}%`);
  if (category) dbQuery = dbQuery.eq('category', category);
  if (featured === 'true') dbQuery = dbQuery.eq('is_featured', true);

  dbQuery = dbQuery.order('is_featured', { ascending: false }).order('title');
  const { data, error } = await dbQuery;
  if (error) throw error;
  res.json({ success: true, data: { occupations: data, query: searchQuery } });
}));

router.get('/categories', optionalAuth, asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('occupations').select('category').eq('is_active', true);
  if (error) throw error;
  const categories = [...new Set((data || []).map(d => d.category).filter(Boolean))].sort();
  res.json({ success: true, data: { categories } });
}));

router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('occupations').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) throw ApiError.notFound('Occupation not found', 'OCCUPATION_NOT_FOUND');
  res.json({ success: true, data: { occupation: data } });
}));

// Admin CRUD
router.post('/', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { code, title, description, category, subcategory, skills, is_featured } = req.body;
  if (!title) throw ApiError.badRequest('Title required', 'VALIDATION_ERROR');

  const { data, error } = await supabaseAdmin
    .from('occupations')
    .insert({
      code: code || `OCC-${Date.now()}`,
      title,
      normalized_title: title.toLowerCase(),
      description,
      category,
      subcategory,
      skills: skills || [],
      is_featured: !!is_featured,
      created_by: req.profile.id,
    })
    .select()
    .single();

  if (error) throw error;

  await supabaseAdmin.from('audit_logs').insert({
    admin_id: req.profile.id,
    action: 'OCCUPATION_CREATED',
    target_type: 'occupation',
    target_id: data.id,
    description: `Created occupation ${title}`,
  });

  res.status(201).json({ success: true, data: { occupation: data } });
}));

router.put('/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { title, description, category, subcategory, skills, is_featured, is_active } = req.body;
  const payload = {};
  if (title) { payload.title = title; payload.normalized_title = title.toLowerCase(); }
  if (description !== undefined) payload.description = description;
  if (category !== undefined) payload.category = category;
  if (subcategory !== undefined) payload.subcategory = subcategory;
  if (skills !== undefined) payload.skills = skills;
  if (is_featured !== undefined) payload.is_featured = !!is_featured;
  if (is_active !== undefined) payload.is_active = !!is_active;
  payload.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin.from('occupations').update(payload).eq('id', req.params.id).select().single();
  if (error) throw error;

  await supabaseAdmin.from('audit_logs').insert({
    admin_id: req.profile.id,
    action: 'OCCUPATION_UPDATED',
    target_type: 'occupation',
    target_id: data.id,
    description: `Updated occupation ${data.title}`,
  });

  res.json({ success: true, data: { occupation: data } });
}));

router.delete('/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('occupations').delete().eq('id', req.params.id);
  if (error) throw error;

  await supabaseAdmin.from('audit_logs').insert({
    admin_id: req.profile.id,
    action: 'OCCUPATION_DELETED',
    target_type: 'occupation',
    target_id: req.params.id,
    description: `Deleted occupation ${req.params.id}`,
  });

  res.json({ success: true, message: 'Occupation deleted' });
}));

export default router;
