/**
 * WOLI DAN TECH HUB — External Educational Resources Service
 * Per spec sections 8-12: research open educational resources, avoid copyrighted copying
 */

import { supabaseAdmin } from '../config/supabase.js';

// Allowed open educational sources — per spec, prioritize these
const TRUSTED_SOURCES = [
  'developer.mozilla.org',
  'docs.python.org',
  'react.dev',
  'vuejs.org',
  'angular.io',
  'nodejs.org',
  'docs.microsoft.com',
  'learn.microsoft.com',
  'w3schools.com',
  'web.dev',
  'khanacademy.org',
  'ocw.mit.edu',
  'coursera.org', // only for reference, not copying
  'edx.org',
  'wikipedia.org',
  'github.com',
  'stackoverflow.com',
  'figma.com',
  'canva.com/help',
  'adobe.com/learn',
  'google.com/think',
  'hubspot.com',
  'coursera.org',
  'freecodecamp.org',
  'geeksforgeeks.org',
  'tutorialspoint.com',
  'creativecommons.org',
  'archive.org',
];

const BLOCKED_PATTERNS = [
  /udemy\.com.*paid/i,
  /skillshare\.com/i,
  /pluralsight\.com/i,
  /linkedin\.com\/learning/i,
  /masterclass\.com/i,
  /\.pdf$/i, // Don't auto-accept PDFs as free to redistribute
];

export function isTrustedSource(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // Check if host is in trusted list or subdomain of trusted
    return TRUSTED_SOURCES.some(trusted => host.includes(trusted) || trusted.includes(host));
  } catch {
    return false;
  }
}

export function isSuspiciousUrl(url) {
  // Check blocked patterns
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(url)) return { suspicious: true, reason: `Matches blocked pattern: ${pat}` };
  }

  // Check for SEO spam indicators
  const spamIndicators = ['buy now', 'click here for free', '100% free download', 'crack', 'torrent'];
  const lower = url.toLowerCase();
  for (const indicator of spamIndicators) {
    if (lower.includes(indicator)) {
      return { suspicious: true, reason: `Contains spam indicator: ${indicator}` };
    }
  }

  return { suspicious: false };
}

export function validateResource({ title, url, resourceType, source, license }) {
  const errors = [];

  if (!title || title.trim().length < 3) errors.push('Title too short');
  if (!url) errors.push('URL required for external resources');
  
  if (url) {
    try {
      new URL(url);
    } catch {
      errors.push('Invalid URL');
    }

    const suspicious = isSuspiciousUrl(url);
    if (suspicious.suspicious) {
      errors.push(`Suspicious URL: ${suspicious.reason}`);
    }
  }

  if (resourceType && !['VIDEO','PDF','ARTICLE','DOCUMENTATION','DATASET','CODE','TEMPLATE','WEBSITE','BOOK','EXERCISE'].includes(resourceType)) {
    errors.push('Invalid resource type');
  }

  // For PDFs, require license check per spec section 11
  if (resourceType === 'PDF' && !license) {
    errors.push('PDF resources require license information — never assume public access = free to redistribute');
  }

  return {
    valid: errors.length === 0,
    errors,
    trusted: url ? isTrustedSource(url) : false,
  };
}

export async function createResource({
  courseId,
  moduleId,
  lessonId,
  title,
  description,
  url,
  source,
  license,
  resourceType = 'ARTICLE',
  isExternal = true,
  attribution,
  createdBy,
}) {
  // Quality control per spec section 10
  const validation = validateResource({ title, url, resourceType, source, license });
  if (!validation.valid) {
    throw new Error(`Resource validation failed: ${validation.errors.join(', ')}`);
  }

  // For external videos, store URL/embed, don't download
  if (resourceType === 'VIDEO' && isExternal) {
    // Ensure we don't download/re-host copyrighted videos
    // Just store URL
  }

  const { data, error } = await supabaseAdmin
    .from('course_resources')
    .insert({
      course_id: courseId,
      module_id: moduleId,
      lesson_id: lessonId,
      title,
      description,
      url,
      source,
      license,
      resource_type: resourceType,
      is_external: isExternal,
      attribution,
      access_date: new Date().toISOString().slice(0,10),
      is_approved: false, // Requires admin approval per spec
      created_by: createdBy,
      quality_score: validation.trusted ? 0.9 : 0.5,
    })
    .select()
    .single();

  if (error) throw error;
  return { resource: data, validation };
}

export async function approveResource(resourceId, approvedBy) {
  const { data, error } = await supabaseAdmin
    .from('course_resources')
    .update({ is_approved: true, updated_at: new Date().toISOString() })
    .eq('id', resourceId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listResources({ courseId, moduleId, lessonId, resourceType, isApproved, page = 1, limit = 20 }) {
  let query = supabaseAdmin.from('course_resources').select('*', { count: 'exact' }).order('created_at', { ascending: false });

  if (courseId) query = query.eq('course_id', courseId);
  if (moduleId) query = query.eq('module_id', moduleId);
  if (lessonId) query = query.eq('lesson_id', lessonId);
  if (resourceType) query = query.eq('resource_type', resourceType);
  if (isApproved !== undefined) query = query.eq('is_approved', isApproved);

  const from = (page - 1) * limit;
  const to = from + limit - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { data, count, page, limit, totalPages: Math.ceil((count||0)/limit) };
}

// For legally reusable PDFs — store securely if allowed
export async function storePdfIfAllowed({ title, description, source, license, url, courseId, moduleId, lessonId, fileBuffer, fileName, mimeType, createdBy }) {
  // Never assume public access = free to redistribute per spec
  const allowedLicenses = ['CC BY', 'CC BY-SA', 'CC0', 'Public Domain', 'MIT', 'Apache', 'Official Docs'];
  const isAllowed = license && allowedLicenses.some(l => license.includes(l));

  if (!isAllowed) {
    // Store external URL + attribution instead
    return createResource({
      courseId, moduleId, lessonId,
      title, description, url, source, license,
      resourceType: 'PDF',
      isExternal: true,
      createdBy,
    });
  }

  // Store securely in Supabase Storage
  const { uploadObject } = await import('./storage.service.js');
  const { BUCKETS } = await import('../config/env.js');
  const path = `course-resources/${courseId}/${lessonId || 'general'}/${Date.now()}-${fileName}`;

  await uploadObject(BUCKETS.lessonResources, path, fileBuffer, mimeType);

  const { data, error } = await supabaseAdmin.from('course_resources').insert({
    course_id: courseId,
    module_id: moduleId,
    lesson_id: lessonId,
    title,
    description,
    url: null,
    storage_path: path,
    source,
    license,
    resource_type: 'PDF',
    is_external: false,
    is_approved: false,
    created_by: createdBy,
  }).select().single();

  if (error) throw error;
  return data;
}
