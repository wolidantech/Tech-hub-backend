#!/usr/bin/env node
/**
 * WOLI DAN TECH HUB — Initial AI Content Population
 * Per spec: Use actual existing courses (not fake hundreds), generate professional curriculum DRAFT
 * This script queues jobs for 12 published courses, admin must approve via /api/admin/content
 * 
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/populate-ai-content.mjs [--dry-run]
 * 
 * Or via API after deployment: POST /api/ai/bulk/generate-missing { courseId }
 */

import { readFileSync, existsSync } from 'fs';

const dryRun = process.argv.includes('--dry-run');

function loadEnv() {
  // Try .env if exists
  const envPath = new URL('../.env', import.meta.url).pathname;
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) {
        const key = m[1];
        let val = m[2].replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('⚠️  SUPABASE_URL or SERVICE_ROLE_KEY missing — dry-run mode will show what would be queued');
}

async function supabaseFetch(path, opts = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${path} ${res.status}: ${txt.slice(0, 500)}`);
  }
  return res.json();
}

async function getPublishedCourses() {
  if (!SUPABASE_URL) {
    // Mock for dry-run without DB
    return [
      { id: 'mock-1', title: 'AI Video Content Creation', slug: 'ai-video-content-creation' },
      { id: 'mock-2', title: 'Graphic Design Fundamentals', slug: 'graphic-design-fundamentals' },
      { id: 'mock-3', title: 'Web Development Bootcamp', slug: 'web-development-bootcamp' },
    ];
  }
  try {
    const courses = await supabaseFetch('courses?is_published=eq.true&select=id,title,slug,description,order=created_at.asc&limit=20');
    return courses || [];
  } catch (e) {
    console.error('Failed to fetch courses:', e.message);
    return [];
  }
}

function buildCurriculumSpec(course) {
  // Per spec section 8: POST /api/ai/courses/generate input
  return {
    courseName: course.title,
    category: course.category || 'Technology',
    level: course.level || 'beginner',
    targetAudience: course.target_audience || 'Aspiring professionals seeking practical, job-ready skills',
    duration: course.duration || '8 weeks',
    numberOfModules: 6,
    learningObjectives: course.learning_objectives || [
      `Master ${course.title} fundamentals`,
      'Build real-world projects',
      'Apply best practices',
    ],
    specialInstructions: 'Follow 13-step teaching standard, substantial content 800-2000 words per lesson, include examples from different industries, internationally recognized tools.',
  };
}

async function queueJobsForCourse(course) {
  console.log(`\n📚 Course: ${course.title} (${course.id})`);
  const spec = buildCurriculumSpec(course);
  console.log(`   Spec: ${spec.numberOfModules} modules, level ${spec.level}`);

  // Identify missing content (would call identifyMissingContent in real service)
  // For population script, we queue:
  // 1. COURSE outline job
  // 2. For each module, LESSON_TEXT jobs
  // 3. PRACTICAL, QUIZ, ASSIGNMENT, RESOURCE, VIDEO_SCRIPT

  const jobs = [
    { job_type: 'COURSE_OUTLINE', input: spec, description: 'Generate full curriculum outline' },
    { job_type: 'LESSON', input: { courseId: course.id, ...spec }, description: 'Generate modules and lessons' },
    { job_type: 'PRACTICAL', input: { courseId: course.id, level: spec.level }, description: 'Generate practicals' },
    { job_type: 'QUIZ', input: { courseId: course.id, level: spec.level }, description: 'Generate quizzes' },
    { job_type: 'ASSIGNMENT', input: { courseId: course.id, level: spec.level }, description: 'Generate assignments' },
    { job_type: 'PROJECT', input: { courseId: course.id, is_final: true }, description: 'Generate final project' },
    { job_type: 'RESOURCE', input: { courseId: course.id }, description: 'Research open educational resources' },
    { job_type: 'VIDEO_SCRIPT', input: { courseId: course.id }, description: 'Generate video scripts' },
  ];

  if (dryRun || !SUPABASE_URL) {
    for (const j of jobs) console.log(`   [DRY-RUN] Would queue ${j.job_type}: ${j.description}`);
    return jobs.length;
  }

  let queued = 0;
  for (const j of jobs) {
    try {
      await supabaseFetch('ai_generation_jobs', {
        method: 'POST',
        body: JSON.stringify({
          job_type: j.job_type,
          status: 'QUEUED',
          input: j.input,
          course_id: course.id,
          provider: 'openai',
          model: 'gpt-4o-mini',
        }),
      });
      console.log(`   ✅ Queued ${j.job_type}`);
      queued++;
    } catch (e) {
      console.error(`   ❌ Failed ${j.job_type}: ${e.message}`);
    }
  }
  return queued;
}

async function main() {
  console.log('🚀 WOLI DAN TECH HUB — AI Content Population');
  console.log(`   Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`   Date: ${new Date().toISOString()}`);

  const courses = await getPublishedCourses();
  console.log(`\nFound ${courses.length} published courses`);

  if (courses.length === 0) {
    console.log('No published courses found. Create courses first via admin or migration.');
    return;
  }

  let totalQueued = 0;
  for (const course of courses.slice(0, 12)) {
    const n = await queueJobsForCourse(course);
    totalQueued += n;
  }

  console.log(`\n✅ Done. Total jobs queued: ${totalQueued}`);
  console.log('   All content is DRAFT. Admin must review via GET /api/admin/content and approve.');
  console.log('   Pipeline: GENERATE → DRAFT → REVIEW → APPROVED → PUBLISHED');
  console.log('   No auto-publish, no fake URLs, no copyrighted copying.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
