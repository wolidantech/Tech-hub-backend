/**
 * WOLI DAN TECH HUB — CV Builder Service
 * Public CV generation, preview, PDF export, AI improve (no fabrication)
 */

import { supabaseAdmin } from '../config/supabase.js';
import PDFDocument from 'pdfkit';
import { randomUUID } from 'crypto';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function sanitizePersonalInfo(info = {}) {
  // Only keep allowed fields, no unnecessary PII for guests beyond what they provide
  const allowed = ['fullName', 'email', 'phone', 'address', 'city', 'country', 'linkedin', 'website', 'photoUrl', 'title'];
  const out = {};
  for (const k of allowed) if (info[k]) out[k] = String(info[k]).slice(0, 500);
  return out;
}

function validateCvData(data) {
  if (!data) throw new Error('CV data required');
  // personal_info is optional for draft but recommended
  return true;
}

// ------------------------------------------------------------------
// CV Documents
// ------------------------------------------------------------------
export async function createCvDocument({ userId = null, guestSessionId = null, templateCode = 'professional', title = 'My CV', occupationId = null, personalInfo = {}, summary = '', sections = [] }) {
  if (!userId && !guestSessionId) {
    guestSessionId = `guest_${randomUUID()}`;
  }

  // Resolve template
  let templateId = null;
  if (templateCode) {
    const { data: tmpl } = await supabaseAdmin.from('cv_templates').select('id').eq('code', templateCode).eq('is_active', true).maybeSingle();
    templateId = tmpl?.id || null;
  }

  const personal = sanitizePersonalInfo(personalInfo);

  const { data: cv, error } = await supabaseAdmin
    .from('cv_documents')
    .insert({
      user_id: userId,
      guest_session_id: guestSessionId,
      template_id: templateId,
      occupation_id: occupationId,
      title: title.slice(0, 200),
      status: 'DRAFT',
      personal_info: personal,
      summary: summary ? summary.slice(0, 5000) : null,
    })
    .select()
    .single();

  if (error) throw error;

  // Create sections if provided
  if (sections && sections.length > 0) {
    const rows = sections.map((s, idx) => ({
      cv_id: cv.id,
      section_type: s.type || s.section_type || 'custom',
      title: (s.title || s.type || 'Section').slice(0, 200),
      content: s.content || s,
      order_number: idx + 1,
      is_visible: s.is_visible !== false,
    }));
    await supabaseAdmin.from('cv_sections').insert(rows);
  }

  return { cv, guestSessionId };
}

export async function getCvDocument({ cvId, userId = null, guestSessionId = null }) {
  let query = supabaseAdmin.from('cv_documents').select('*, cv_templates(code,name,config), occupations(title,category)').eq('id', cvId);
  const { data: cv, error } = await query.maybeSingle();
  if (error) throw error;
  if (!cv) return null;

  // Access check: owner or guest session or admin
  if (cv.user_id) {
    if (userId && cv.user_id === userId) {
      // ok
    } else {
      // check admin
      const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle();
      if (!profile || profile.role !== 'admin') {
        if (guestSessionId !== cv.guest_session_id) return null;
      }
    }
  } else {
    // guest CV
    if (cv.guest_session_id !== guestSessionId) {
      // allow service_role for public preview if guestSessionId matches, else check if user is admin
      if (userId) {
        const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle();
        if (!profile || profile.role !== 'admin') return null;
      } else {
        // For public preview, guest must provide session id; if not, allow read if is_public? For now require session
        if (guestSessionId !== cv.guest_session_id) return null;
      }
    }
  }

  const { data: sections } = await supabaseAdmin
    .from('cv_sections')
    .select('*')
    .eq('cv_id', cvId)
    .order('order_number');

  return { ...cv, sections: sections || [] };
}

export async function updateCvDocument({ cvId, userId = null, guestSessionId = null, updates = {} }) {
  const existing = await getCvDocument({ cvId, userId, guestSessionId });
  if (!existing) throw new Error('CV not found or access denied');

  const allowedFields = ['title', 'template_id', 'occupation_id', 'personal_info', 'summary', 'status'];
  const payload = {};
  for (const k of allowedFields) if (k in updates) payload[k] = updates[k];

  if (payload.personal_info) payload.personal_info = sanitizePersonalInfo(payload.personal_info);
  if (payload.title) payload.title = payload.title.slice(0, 200);
  if (payload.summary) payload.summary = payload.summary.slice(0, 5000);
  payload.updated_at = new Date().toISOString();
  payload.last_edited_at = new Date().toISOString();
  payload.version = (existing.version || 1) + 1;

  const { data, error } = await supabaseAdmin.from('cv_documents').update(payload).eq('id', cvId).select().single();
  if (error) throw error;

  // Update sections if provided
  if (updates.sections) {
    // Replace sections
    await supabaseAdmin.from('cv_sections').delete().eq('cv_id', cvId);
    const rows = updates.sections.map((s, idx) => ({
      cv_id: cvId,
      section_type: s.type || s.section_type || 'custom',
      title: (s.title || s.type || 'Section').slice(0, 200),
      content: s.content || s,
      order_number: idx + 1,
      is_visible: s.is_visible !== false,
    }));
    if (rows.length > 0) await supabaseAdmin.from('cv_sections').insert(rows);
  }

  return data;
}

export async function deleteCvDocument({ cvId, userId }) {
  const existing = await getCvDocument({ cvId, userId });
  if (!existing) throw new Error('CV not found');
  const { error } = await supabaseAdmin.from('cv_documents').delete().eq('id', cvId);
  if (error) throw error;
  return true;
}

// ------------------------------------------------------------------
// Templates
// ------------------------------------------------------------------
export async function listTemplates() {
  const { data, error } = await supabaseAdmin.from('cv_templates').select('*').eq('is_active', true).order('name');
  if (error) throw error;
  return data;
}

// ------------------------------------------------------------------
// Occupations
// ------------------------------------------------------------------
export async function searchOccupations({ query, category, limit = 20, featured = false }) {
  let q = supabaseAdmin.from('occupations').select('*').eq('is_active', true).limit(Math.min(limit, 50));
  if (query) {
    const normalized = query.toLowerCase().trim();
    q = q.or(`title.ilike.%${normalized}%,normalized_title.ilike.%${normalized}%,category.ilike.%${normalized}%`);
  }
  if (category) q = q.eq('category', category);
  if (featured) q = q.eq('is_featured', true);
  q = q.order('is_featured', { ascending: false }).order('title');
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function getOccupationCategories() {
  const { data, error } = await supabaseAdmin.from('occupations').select('category').eq('is_active', true);
  if (error) throw error;
  const cats = [...new Set((data || []).map(d => d.category).filter(Boolean))].sort();
  return cats;
}

// ------------------------------------------------------------------
// PDF Generation — professional A4
// ------------------------------------------------------------------
export async function generateCvPdf({ cvId, userId = null, guestSessionId = null, templateCode = null }) {
  const cv = await getCvDocument({ cvId, userId, guestSessionId });
  if (!cv) throw new Error('CV not found');

  let template = cv.cv_templates;
  if (templateCode) {
    const { data: tmpl } = await supabaseAdmin.from('cv_templates').select('*').eq('code', templateCode).maybeSingle();
    if (tmpl) template = tmpl;
  }
  const config = template?.config || { font: 'Helvetica', colors: { primary: '#1E40AF', secondary: '#64748B' }, layout: 'single-column' };

  // Create PDF A4
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: cv.title, Author: cv.personal_info?.fullName || 'WOLI DAN TECH HUB' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // Typography & margins
  const primaryColor = config.colors?.primary || '#1E40AF';
  const secondaryColor = config.colors?.secondary || '#64748B';
  const pageWidth = doc.page.width - 100; // 50 margin each side

  // Header — personal info
  const personal = cv.personal_info || {};
  doc.fontSize(22).fillColor(primaryColor).font('Helvetica-Bold').text(personal.fullName || 'Your Name', { align: 'left' });
  if (personal.title) {
    doc.moveDown(0.2).fontSize(12).fillColor(secondaryColor).font('Helvetica').text(personal.title);
  }
  // Contact line
  const contacts = [personal.email, personal.phone, personal.city, personal.country, personal.linkedin, personal.website].filter(Boolean).join(' | ');
  if (contacts) {
    doc.moveDown(0.3).fontSize(9).fillColor('#333').font('Helvetica').text(contacts, { width: pageWidth });
  }
  doc.moveDown(0.5).moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).strokeColor('#E5E7EB').lineWidth(1).stroke();
  doc.moveDown(0.8);

  // Summary
  if (cv.summary) {
    doc.fontSize(12).fillColor(primaryColor).font('Helvetica-Bold').text('PROFESSIONAL SUMMARY');
    doc.moveDown(0.2).fontSize(10).fillColor('#111').font('Helvetica').text(cv.summary, { width: pageWidth, align: 'justify' });
    doc.moveDown(0.8);
  }

  // Sections
  for (const section of cv.sections || []) {
    if (!section.is_visible) continue;
    const content = section.content || {};

    // Section title
    if (doc.y > 700) doc.addPage();
    doc.fontSize(12).fillColor(primaryColor).font('Helvetica-Bold').text(section.title.toUpperCase(), { underline: false });
    doc.moveDown(0.1).moveTo(50, doc.y).lineTo(200, doc.y).strokeColor(primaryColor).lineWidth(1.5).stroke();
    doc.moveDown(0.4);

    // Render by type
    const type = section.section_type;
    if (type === 'experience' && Array.isArray(content.items || content.experiences)) {
      const items = content.items || content.experiences;
      for (const exp of items) {
        if (doc.y > 700) doc.addPage();
        const title = exp.title || exp.role || exp.position || '';
        const company = exp.company || exp.organization || '';
        const duration = exp.duration || `${exp.startDate || ''} - ${exp.endDate || 'Present'}`;
        doc.fontSize(11).fillColor('#111').font('Helvetica-Bold').text(`${title}${company ? ` at ${company}` : ''}`, { width: pageWidth });
        if (duration) doc.fontSize(9).fillColor(secondaryColor).font('Helvetica-Oblique').text(duration);
        if (exp.description) {
          doc.moveDown(0.1).fontSize(10).fillColor('#333').font('Helvetica').text(exp.description, { width: pageWidth });
        }
        if (exp.achievements && Array.isArray(exp.achievements)) {
          doc.moveDown(0.2);
          for (const ach of exp.achievements) {
            doc.fontSize(10).fillColor('#333').font('Helvetica').text(`• ${ach}`, { width: pageWidth, indent: 10 });
          }
        }
        doc.moveDown(0.6);
      }
    } else if (type === 'education' && Array.isArray(content.items || content.educations)) {
      const items = content.items || content.educations;
      for (const edu of items) {
        if (doc.y > 700) doc.addPage();
        doc.fontSize(11).fillColor('#111').font('Helvetica-Bold').text(`${edu.degree || edu.title || ''}${edu.institution ? ` - ${edu.institution}` : ''}`, { width: pageWidth });
        if (edu.duration || edu.year) doc.fontSize(9).fillColor(secondaryColor).font('Helvetica').text(edu.duration || edu.year);
        if (edu.description) doc.fontSize(10).fillColor('#333').font('Helvetica').text(edu.description, { width: pageWidth });
        doc.moveDown(0.6);
      }
    } else if (type === 'skills') {
      const skills = content.skills || content.items || [];
      if (Array.isArray(skills)) {
        const skillText = skills.map(s => typeof s === 'string' ? s : s.name || s.skill || '').filter(Boolean).join(' • ');
        doc.fontSize(10).fillColor('#333').font('Helvetica').text(skillText, { width: pageWidth });
        doc.moveDown(0.6);
      } else if (typeof content === 'object') {
        // grouped skills
        for (const [group, list] of Object.entries(content)) {
          if (group === 'items' || group === 'skills') continue;
          if (Array.isArray(list)) {
            doc.fontSize(10).fillColor('#111').font('Helvetica-Bold').text(`${group}: `, { continued: true }).font('Helvetica').fillColor('#333').text(list.join(', '), { width: pageWidth });
          }
        }
        doc.moveDown(0.6);
      }
    } else if (type === 'projects' && Array.isArray(content.items || content.projects)) {
      const items = content.items || content.projects;
      for (const proj of items) {
        if (doc.y > 700) doc.addPage();
        doc.fontSize(11).fillColor('#111').font('Helvetica-Bold').text(proj.title || proj.name || '', { width: pageWidth });
        if (proj.description) doc.fontSize(10).fillColor('#333').font('Helvetica').text(proj.description, { width: pageWidth });
        if (proj.technologies) doc.fontSize(9).fillColor(secondaryColor).font('Helvetica').text(`Tech: ${Array.isArray(proj.technologies) ? proj.technologies.join(', ') : proj.technologies}`);
        doc.moveDown(0.6);
      }
    } else {
      // generic
      const text = typeof content === 'string' ? content : content.description || content.text || JSON.stringify(content).slice(0, 2000);
      if (text) {
        doc.fontSize(10).fillColor('#333').font('Helvetica').text(text, { width: pageWidth });
        doc.moveDown(0.6);
      }
    }
  }

  // Footer
  const footerY = doc.page.height - 30;
  doc.fontSize(7).fillColor('#9CA3AF').font('Helvetica').text('Generated via WOLI DAN TECH HUB — Global Knowledge Platform', 50, footerY, { align: 'center', width: pageWidth });

  doc.end();
  const pdfBuffer = await done;

  // Store
  const isGuest = !userId;
  const fileName = `${cvId}_${Date.now()}.pdf`;
  const filePath = isGuest ? `guest/${cv.guest_session_id || 'anon'}/${fileName}` : `${userId}/${cvId}/${fileName}`;

  // Upload to storage
  const { error: uploadError } = await supabaseAdmin.storage.from('cv-exports').upload(filePath, pdfBuffer, {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (uploadError) throw uploadError;

  // Create export record
  const expiresAt = isGuest ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null; // 24h for guests
  const { data: exportRecord, error: exportError } = await supabaseAdmin
    .from('cv_exports')
    .insert({
      cv_id: cvId,
      user_id: userId,
      guest_session_id: guestSessionId,
      template_id: template?.id || cv.template_id,
      file_path: filePath,
      file_size: pdfBuffer.length,
      status: 'COMPLETED',
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (exportError) throw exportError;

  // Generate signed URL (1h for guest, 24h for user)
  const expiresIn = isGuest ? 3600 : 86400;
  const { data: signed } = await supabaseAdmin.storage.from('cv-exports').createSignedUrl(filePath, expiresIn);

  return { pdfBuffer, exportRecord, downloadUrl: signed?.signedUrl || null, filePath };
}

// ------------------------------------------------------------------
// AI Improve — transform, never fabricate
// ------------------------------------------------------------------
export const AI_IMPROVE_PROMPT = `
You are a professional CV writing assistant for WOLI DAN TECH HUB.

CRITICAL RULES — NEVER FABRICATE:
- Do NOT invent degrees, employment, certifications, job titles, companies, achievements, skills, or dates
- Only transform, rephrase, and improve the information the user has already provided
- If information is missing, do NOT invent it — suggest what could be added but do not fabricate
- Preserve factual accuracy of all original data
- Enhance clarity, professionalism, impact, and ATS compatibility

Your task: Improve the provided CV section by:
1. Using strong action verbs
2. Improving grammar and clarity
3. Making it more concise and impactful
4. Adding quantifiable language where the original already contains numbers
5. Optimizing for ATS keywords based on the occupation, without inventing skills
6. Maintaining the original meaning and facts

Return ONLY the improved text, no explanations.
`;

export async function improveCvSection({ sectionType, content, occupation = null }) {
  // This will be called by controller which handles AI provider
  // Returns prompt for AI provider
  const occupationContext = occupation ? `Target occupation: ${occupation.title} (${occupation.category})` : '';
  const prompt = `${AI_IMPROVE_PROMPT}\n\n${occupationContext}\n\nSection type: ${sectionType}\n\nOriginal content:\n${typeof content === 'string' ? content : JSON.stringify(content, null, 2)}\n\nImproved version:`;

  return prompt;
}
