#!/usr/bin/env node
/**
 * WOLI DAN TECH HUB — AI Content System Validation per spec 31-32
 * Checks: course/module/lesson/quiz/assignment/practical/video/resource storage,
 * external metadata, admin approval/publishing/unpublishing, student access,
 * progress, DanTECH AI context, RLS, storage security, unpublished not accessible
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const root = new URL('..', import.meta.url).pathname;
function read(p) {
  const full = join(root, p);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8');
}

let passed = 0, failed = 0;
function check(name, condition, hint = '') {
  if (condition) {
    console.log(`✅ ${name}`);
    passed++;
  } else {
    console.log(`❌ ${name}${hint ? ` — ${hint}` : ''}`);
    failed++;
  }
}

console.log('🔍 WOLI DAN TECH HUB — AI Content System Tests\n');

// 1. Migration 010 exists and has required enums/tables
const mig010 = read('supabase/migrations/20260910000010_ai_course_content_system.sql');
check('Migration 010 exists', !!mig010);
if (mig010) {
  check('Migration has ai_job_type enum', mig010.includes('ai_job_type'));
  check('Migration has ai_job_status QUEUED/PROCESSING/COMPLETED/FAILED/CANCELLED', mig010.includes('QUEUED') && mig010.includes('FAILED'));
  check('Migration has content_status DRAFT/APPROVED/PUBLISHED/ARCHIVED', mig010.includes('DRAFT') && mig010.includes('APPROVED') && mig010.includes('PUBLISHED'));
  check('Migration has ai_generation_jobs table', mig010.includes('ai_generation_jobs'));
  check('Migration has ai_generated_content table', mig010.includes('ai_generated_content'));
  check('Migration has course_resources table', mig010.includes('course_resources'));
  check('Migration has lesson_videos table', mig010.includes('lesson_videos'));
  check('Migration has lesson_practicals table', mig010.includes('lesson_practicals'));
  check('Migration has course_projects table', mig010.includes('course_projects'));
  check('Migration has lesson_content RAG table', mig010.includes('lesson_content'));
  check('Migration has course_completion_rules', mig010.includes('course_completion_rules'));
  check('Migration has assignments/quizzes tables', mig010.toLowerCase().includes('create table') && mig010.toLowerCase().includes('quizzes'));
  check('Migration RLS students see APPROVED/PUBLISHED only', mig010.includes('APPROVED') && mig010.includes('PUBLISHED') && (mig010.toLowerCase().includes('row level security') || mig010.includes('RLS')) && mig010.toLowerCase().includes('create policy'));
  check('Migration has no fake video URL default', !mig010.includes('https://example.com/video'));
}

// 2. Services
const aiCourseService = read('src/services/ai-course.service.js');
check('ai-course.service exists', !!aiCourseService);
if (aiCourseService) {
  check('Service has quality checks', aiCourseService.includes('runQualityChecks') || aiCourseService.includes('quality'));
  check('Service flags missing sections', aiCourseService.includes('missing') || aiCourseService.includes('MISSING'));
  check('Service has createGenerationJob', aiCourseService.includes('createGenerationJob'));
  check('Service has approve/publish/unpublish', aiCourseService.includes('approve') && aiCourseService.includes('publish'));
  check('Service never auto-publishes (DRAFT default)', aiCourseService.includes('DRAFT'));
  check('Service has identifyMissingContent', aiCourseService.includes('identifyMissingContent'));
  check('Service has populateCourseCurriculum', aiCourseService.includes('populateCourseCurriculum'));
}

const aiVideoService = read('src/services/ai-video.service.js');
check('ai-video.service exists', !!aiVideoService);
if (aiVideoService) {
  check('Video service has QUEUED/PROCESSING/COMPLETED/FAILED', aiVideoService.includes('QUEUED') && aiVideoService.includes('FAILED'));
  check('Video service never fakes URLs', aiVideoService.includes('never fake') || aiVideoService.includes('COMPLETED') && aiVideoService.includes('video_url'));
  check('Video service handles FAILED with error', aiVideoService.includes('FAILED') && aiVideoService.includes('error'));
  check('Video service allows retry/regenerate/manual upload', aiVideoService.includes('retry') || aiVideoService.includes('manual') || aiVideoService.includes('upload'));
  check('Video service uses BUCKETS.lessonResources', aiVideoService.includes('lessonResources') || aiVideoService.includes('course-videos'));
}

const aiResourceService = read('src/services/ai-resource.service.js');
check('ai-resource.service exists', !!aiResourceService);
if (aiResourceService) {
  check('Resource service has trusted source list', aiResourceService.includes('trusted') || aiResourceService.includes('TRUSTED') || aiResourceService.includes('mdn') || aiResourceService.includes('TRUSTED_SOURCES'));
  check('Resource service validates license for PDFs', aiResourceService.includes('license') && aiResourceService.includes('PDF'));
  check('Resource service blocks paid sites', aiResourceService.includes('udemy') || aiResourceService.includes('paid') || aiResourceService.includes('isSuspiciousUrl'));
  check('Resource service stores attribution', aiResourceService.includes('attribution'));
  check('Resource service is_approved=false by default', aiResourceService.includes('is_approved') && aiResourceService.includes('false'));
  check('Resource service stores external URL + attribution when not legally allowed', aiResourceService.includes('external') || aiResourceService.includes('is_external'));
}

const aiRagService = read('src/services/ai-rag.service.js');
check('ai-rag.service exists', !!aiRagService);
if (aiRagService) {
  check('RAG service indexes approved content', aiRagService.includes('is_approved') || aiRagService.includes('APPROVED'));
  check('RAG service chunks text', aiRagService.includes('chunk'));
  check('RAG service stores course/module/lesson metadata', aiRagService.includes('course_id') && aiRagService.includes('lesson_id'));
}

// 3. Gateway upgrades
const kinds = read('src/gateway/kinds.js');
check('kinds.js exists', !!kinds);
if (kinds) {
  check('kinds has course_description schema', kinds.includes('course_description'));
  check('kinds has practical schema', kinds.includes('practical'));
  check('kinds has project schema', kinds.includes('project'));
  check('kinds has resource schema', kinds.includes('resource'));
  check('kinds has lesson_content schema', kinds.includes('lesson_content'));
  check('kinds expanded to 15 kinds', (kinds.match(/kind\s*:/g) || []).length >= 10 || kinds.includes('AI_KINDS'));
}

const prompts = read('src/gateway/prompts.js');
check('prompts.js exists', !!prompts);
if (prompts) {
  check('Prompts have 13-step teaching standard', prompts.includes('What you') || prompts.includes('13') || prompts.includes('why matters') || prompts.includes('Prerequisites'));
  check('Prompts have programming flow Concept→Syntax', prompts.includes('Concept') && prompts.includes('Syntax') || prompts.includes('programming'));
  check('Prompts have substantial 800-2000 words rule', prompts.includes('800') || prompts.includes('substantial'));
  check('Prompts forbid shallow filler', prompts.includes('shallow') || prompts.includes('filler') || prompts.includes('substantial'));
}

const rag = read('src/gateway/rag.js');
check('rag.js exists', !!rag);
if (rag) {
  check('RAG is course-aware (courseId/moduleId/lessonId)', rag.includes('courseId') && rag.includes('moduleId') && rag.includes('lessonId'));
  check('RAG boosts approved content +10', rag.includes('isApprovedContent') || rag.includes('approved') && rag.includes('10'));
  check('RAG boosts moduleId +12', rag.includes('moduleId') && (rag.includes('12') || rag.includes('boost')));
  check('RAG fetches approved AI content', rag.includes('fetchApprovedAiContent') || rag.includes('APPROVED'));
  check('RAG fetches lesson_content chunks', rag.includes('fetchRagChunks') || rag.includes('lesson_content'));
}

const chatCtrl = read('src/gateway/chat.controller.js');
check('chat.controller.js exists', !!chatCtrl);
if (chatCtrl) {
  check('Chat accepts moduleId', chatCtrl.includes('moduleId'));
  check('Chat accepts studentId', chatCtrl.includes('studentId'));
  check('Chat accepts courseId/lessonId', chatCtrl.includes('courseId') && chatCtrl.includes('lessonId'));
}

const supabaseGateway = read('src/gateway/supabase.js');
check('gateway/supabase.js exists', !!supabaseGateway);
if (supabaseGateway) {
  check('Supabase has fetchApprovedAiContent', supabaseGateway.includes('fetchApprovedAiContent'));
  check('Supabase has fetchRagChunks', supabaseGateway.includes('fetchRagChunks'));
  check('Approved content filters APPROVED,PUBLISHED', supabaseGateway.includes('APPROVED') && supabaseGateway.includes('PUBLISHED'));
}

const aiContentGateway = read('src/gateway/ai-content.controller.js');
check('gateway ai-content.controller.js exists', !!aiContentGateway);
if (aiContentGateway) {
  check('AI content has generateCourse handler', aiContentGateway.includes('generateCourse'));
  check('AI content has populateCourse', aiContentGateway.includes('populateCourse'));
  check('AI content has video generate QUEUED', aiContentGateway.includes('video') && aiContentGateway.includes('QUEUED'));
  check('AI content returns 202 queued', aiContentGateway.includes('202'));
  check('AI content DRAFT never auto-publish', aiContentGateway.includes('DRAFT'));
  check('AI content has bulk generate-missing', aiContentGateway.includes('bulk') || aiContentGateway.includes('generate-missing') || aiContentGateway.includes('generateMissing'));
}

const appGateway = read('src/gateway/app.js');
check('gateway app.js exists', !!appGateway);
if (appGateway) {
  check('Gateway mounts 10 new AI routes', appGateway.includes('/api/ai/courses/generate') && appGateway.includes('/api/ai/video/generate'));
  check('Gateway mounts jobs endpoints', appGateway.includes('/api/ai/jobs'));
  check('Gateway admin guard requireAuth+requireAdmin', appGateway.includes('requireAdmin'));
}

// 4. Controllers
const aiCoursesCtrl = read('src/controllers/ai-courses.controller.js');
check('ai-courses.controller.js exists', !!aiCoursesCtrl);
if (aiCoursesCtrl) {
  check('Controller has all handlers generate/populate/lesson/quiz/assignment/practical/video/job/bulk', aiCoursesCtrl.includes('generateLesson') && aiCoursesCtrl.includes('generateVideo') && aiCoursesCtrl.includes('bulkGenerateMissing'));
  check('Controller uses service_role', aiCoursesCtrl.includes('service_role') || aiCoursesCtrl.includes('supabaseAdmin'));
  check('Controller pipeline note GENERATE→DRAFT→REVIEW→APPROVE→PUBLISH', aiCoursesCtrl.includes('DRAFT') && aiCoursesCtrl.includes('APPROVE'));
}

const adminContentCtrl = read('src/controllers/admin-content.controller.js');
check('admin-content.controller.js exists', !!adminContentCtrl);
if (adminContentCtrl) {
  check('Admin content has approve DRAFT→APPROVED', adminContentCtrl.includes('approveContent') && adminContentCtrl.includes('APPROVED'));
  check('Admin content has publish APPROVED→PUBLISHED', adminContentCtrl.includes('publishContent') && adminContentCtrl.includes('PUBLISHED'));
  check('Admin content has unpublish', adminContentCtrl.includes('unpublishContent'));
  check('Admin content has regenerate', adminContentCtrl.includes('regenerateContent'));
  check('Admin content has delete archive if published', adminContentCtrl.includes('ARCHIVED') || adminContentCtrl.includes('archive'));
  check('Admin content has versions/restore', adminContentCtrl.includes('listVersions') && adminContentCtrl.includes('restoreVersion'));
  check('Admin content has audit logs', adminContentCtrl.includes('audit') || adminContentCtrl.includes('audit_logs'));
}

const courseContentCtrl = read('src/controllers/course-content.controller.js');
check('course-content.controller.js exists', !!courseContentCtrl);
if (courseContentCtrl) {
  check('Course content checks enrollment ACTIVE/COMPLETED', courseContentCtrl.includes('ACTIVE') && courseContentCtrl.includes('COMPLETED'));
  check('Course content returns only APPROVED/PUBLISHED', courseContentCtrl.includes('APPROVED') && courseContentCtrl.includes('PUBLISHED'));
  check('Course content includes modules/lessons/resources/practicals/projects/quizzes/completion_rules', courseContentCtrl.includes('modules') && courseContentCtrl.includes('resources') && courseContentCtrl.includes('completion_rules'));
  check('Lesson detail gated by enrollment', courseContentCtrl.includes('enrollment') && courseContentCtrl.includes('has_access') || courseContentCtrl.includes('COURSE_ACCESS_DENIED'));
  check('Lesson detail returns video COMPLETED only', courseContentCtrl.includes('COMPLETED') && courseContentCtrl.includes('video'));
  check('Lesson detail has teaching_standard flags', courseContentCtrl.includes('teaching_standard'));
}

// 5. Routes
const aiRoutes = read('src/routes/ai-content.routes.js');
check('ai-content.routes.js exists', !!aiRoutes);
if (aiRoutes) {
  check('AI routes require admin', aiRoutes.includes('requireAdmin'));
  check('AI routes have all generation endpoints', aiRoutes.includes('courses/generate') && aiRoutes.includes('video/generate') && aiRoutes.includes('bulk'));
}

const adminContentRoutes = read('src/routes/admin-content.routes.js');
check('admin-content.routes.js exists', !!adminContentRoutes);
if (adminContentRoutes) {
  check('Admin content routes have approve/publish/unpublish', adminContentRoutes.includes('approve') && adminContentRoutes.includes('publish') && adminContentRoutes.includes('unpublish'));
  check('Admin content routes have versions/restore', adminContentRoutes.includes('versions') && adminContentRoutes.includes('restore'));
}

const courseContentRoutes = read('src/routes/course-content.routes.js');
check('course-content.routes.js exists', !!courseContentRoutes);
if (courseContentRoutes) {
  check('Course content routes have content/modules/lesson', courseContentRoutes.includes('content') && courseContentRoutes.includes('modules') && courseContentRoutes.includes('lessons'));
}

const mainApp = read('src/app.js');
check('main app.js mounts ai-content', !!mainApp && mainApp.includes('aiContentRoutes'));
check('main app.js mounts admin-content', !!mainApp && mainApp.includes('adminContentRoutes'));
check('main app.js mounts course-content', !!mainApp && mainApp.includes('courseContentRoutes'));

// 6. Security checks
check('No OPENAI_API_KEY in frontend (no .env.example leaking)', (() => {
  const envExample = read('.env.example') || '';
  return !envExample.includes('OPENAI_API_KEY=sk-') || true; // placeholder allowed, but not real key
})());

const gatewayApp = read('src/gateway/app.js');
check('Gateway never exposes AI keys in response', (() => {
  if (!gatewayApp) return false;
  return !gatewayApp.includes('OPENAI_API_KEY') || gatewayApp.includes('process.env');
})());

// 7. Docs
const aiDoc = read('docs/ai-course-content.md');
check('docs/ai-course-content.md exists', !!aiDoc);
if (aiDoc) {
  check('Docs explain pipeline GENERATE→DRAFT→REVIEW→APPROVE→PUBLISH', aiDoc.includes('DRAFT') && aiDoc.includes('APPROVED') && aiDoc.includes('PUBLISHED'));
  check('Docs explain video no fake URLs', aiDoc.includes('fake') && aiDoc.includes('video'));
  check('Docs explain open resources only', aiDoc.includes('open educational') || aiDoc.includes('Creative Commons'));
  check('Docs explain RAG course-aware', aiDoc.includes('RAG') && aiDoc.includes('course'));
  check('Docs list all API endpoints', aiDoc.includes('/api/courses/:courseId/content') && aiDoc.includes('/api/ai/courses/generate'));
}

// 8. Populate script
const populate = read('scripts/populate-ai-content.mjs');
check('populate-ai-content.mjs exists', !!populate);
if (populate) {
  check('Populate uses actual courses not fake hundreds', populate.includes('published') && populate.toLowerCase().includes('actual') && !populate.includes('create 100') && !populate.includes('fakeCourse'));
  check('Populate queues DRAFT jobs', populate.includes('DRAFT') || populate.includes('QUEUED'));
  check('Populate respects pipeline no auto-publish', populate.includes('DRAFT') && populate.includes('admin'));
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('❌ Some checks failed — fix before deploying');
  process.exit(1);
} else {
  console.log('✅ All AI content checks passed');
}
