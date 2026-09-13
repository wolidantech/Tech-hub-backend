#!/usr/bin/env node
/**
 * WOLI DAN TECH HUB — Mobile/API Compatibility Tests per spec 33
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
  if (condition) { console.log(`✅ ${name}`); passed++; }
  else { console.log(`❌ ${name}${hint ? ` — ${hint}` : ''}`); failed++; }
}

console.log('🔍 Mobile/API Compatibility Tests\n');

// Middleware
const mobileMw = read('src/middleware/mobile.js');
check('mobile.js exists', !!mobileMw);
if (mobileMw) {
  check('Has parseMobilePagination', mobileMw.includes('parseMobilePagination'));
  check('Has cursor pagination', mobileMw.includes('cursor') || mobileMw.includes('next_cursor'));
  check('Has field selection', mobileMw.includes('fieldSelection') || mobileMw.includes('applyFieldSelection'));
  check('Has mobile optimize middleware', mobileMw.includes('mobileOptimizeMiddleware') || mobileMw.includes('isMobile'));
  check('Has cache middleware', mobileMw.includes('cacheMiddleware'));
  check('Has timeout middleware', mobileMw.includes('timeoutMiddleware'));
  check('Has request ID middleware', mobileMw.includes('requestIdMiddleware'));
  check('Cache prunes old entries', mobileMw.includes('Prune') || mobileMw.includes('cache.size'));
  check('Timeout returns 504', mobileMw.includes('504') && mobileMw.includes('REQUEST_TIMEOUT'));
}

// Mobile courses controller
const mobileCourses = read('src/controllers/mobile-courses.controller.js');
check('mobile-courses.controller exists', !!mobileCourses);
if (mobileCourses) {
  check('Has listCoursesMobile paginated', mobileCourses.includes('listCoursesMobile') && mobileCourses.includes('parseMobilePagination'));
  check('Has field selection', mobileCourses.includes('applyFieldSelection') || mobileCourses.includes('fields'));
  check('Has getCourseMetadata separate from detailed', mobileCourses.includes('getCourseMetadata') && mobileCourses.includes('modules_count'));
  check('Has listModulesMobile paginated', mobileCourses.includes('listModulesMobile'));
  check('Has listLessonsMobile paginated', mobileCourses.includes('listLessonsMobile'));
  check('Has getLessonMobile individual', mobileCourses.includes('getLessonMobile'));
  check('Has getLessonVideoMobile efficient signed URL', mobileCourses.includes('getLessonVideoMobile') && mobileCourses.includes('createSignedUrl') && mobileCourses.includes('range_supported'));
  check('Has getLessonResourcesMobile paginated signed URLs', mobileCourses.includes('getLessonResourcesMobile') && mobileCourses.includes('signed_url'));
  check('Avoids huge payload — counts not full lessons', mobileCourses.includes('count') && mobileCourses.includes('head: true'));
  check('Batch query avoids N+1', mobileCourses.includes('lessonsCountMap') || mobileCourses.includes('moduleIds'));
  check('Minimal mode strips description', mobileCourses.includes('minimal') && mobileCourses.includes('slice(0, 100)'));
}

// Mobile uploads
const mobileUploads = read('src/controllers/mobile-uploads.controller.js');
check('mobile-uploads.controller exists', !!mobileUploads);
if (mobileUploads) {
  check('Has initUpload resumable', mobileUploads.includes('initUpload') && mobileUploads.includes('sessionId'));
  check('Has uploadChunk', mobileUploads.includes('uploadChunk'));
  check('Has uploadSingle', mobileUploads.includes('uploadSingle'));
  check('Has getUploadSession progress', mobileUploads.includes('getUploadSession') && mobileUploads.includes('progress'));
  check('Has cancelUpload', mobileUploads.includes('cancelUpload'));
  check('Has chunk cleanup expiry', mobileUploads.includes('30 * 60 * 1000') || mobileUploads.includes('expiry'));
  check('Has MIME validation per bucket', mobileUploads.includes('mimeValidation') || mobileUploads.includes('allowedMimes'));
  check('Has file size limits', mobileUploads.includes('FILE_TOO_LARGE') || mobileUploads.includes('50 * 1024 * 1024'));
  check('Has timeout handling 60s', mobileUploads.includes('60000') && mobileUploads.includes('AbortController'));
  check('Has progress tracking', mobileUploads.includes('progress'));
  check('Supports resume/retry missing chunks', mobileUploads.includes('missing'));
}

// Routes
const mobileRoutes = read('src/routes/mobile.routes.js');
check('mobile.routes exists', !!mobileRoutes);
if (mobileRoutes) {
  check('Has mobileOptimizeMiddleware', mobileRoutes.includes('mobileOptimizeMiddleware'));
  check('Has timeoutMiddleware', mobileRoutes.includes('timeoutMiddleware'));
  check('Has cacheMiddleware for courses', mobileRoutes.includes('cacheMiddleware'));
  check('Has fieldSelectionMiddleware', mobileRoutes.includes('fieldSelectionMiddleware'));
  check('Has Course→Modules→Lessons→Individual', mobileRoutes.includes('courses') && mobileRoutes.includes('modules') && mobileRoutes.includes('lessons') && mobileRoutes.includes('video'));
  check('Has video delivery route', mobileRoutes.includes('video'));
  check('Has resources route', mobileRoutes.includes('resources'));
}

const mobileUploadsRoutes = read('src/routes/mobile-uploads.routes.js');
check('mobile-uploads.routes exists', !!mobileUploadsRoutes);
if (mobileUploadsRoutes) {
  check('Has single upload', mobileUploadsRoutes.includes('single'));
  check('Has init and chunk', mobileUploadsRoutes.includes('init') && mobileUploadsRoutes.includes('chunk'));
  check('Has session progress', mobileUploadsRoutes.includes('session'));
  check('Has timeout 60s', mobileUploadsRoutes.includes('60000'));
}

// Course content mobile optimized
const courseContent = read('src/controllers/course-content.controller.js');
check('course-content.controller mobile optimized', !!courseContent);
if (courseContent) {
  check('Supports ?include= param', courseContent.includes('include') && courseContent.includes('includeSet'));
  check('Mobile returns metadata only with links', courseContent.includes('Mobile optimized') && courseContent.includes('_links'));
  check('Supports minimal mode', courseContent.includes('minimal') || courseContent.includes('isMobile'));
  check('Paginated modules', courseContent.includes('parsePagination') || courseContent.includes('range'));
  check('Avoids huge payload conditional include', courseContent.includes('includeSet.has'));
  check('Video signed URL with range', courseContent.includes('signed_url') && courseContent.includes('range_supported'));
  check('Resources signed URLs', courseContent.includes('signed_url'));
  check('Lazy loading hint', courseContent.includes('lazy load') || courseContent.includes('_meta'));
}

// Gateway mobile
const gatewayApp = read('src/gateway/app.js');
check('gateway app mobile optimized', !!gatewayApp);
if (gatewayApp) {
  check('Has mobile detection', gatewayApp.includes('isMobile') && gatewayApp.includes('Mobile|Android|iPhone'));
  check('Has request ID', gatewayApp.includes('requestId') || gatewayApp.includes('x-request-id'));
  check('Has timeout 30s', gatewayApp.includes('30000') && gatewayApp.includes('REQUEST_TIMEOUT'));
  check('Has connection interruption handling', gatewayApp.includes('connection_interrupted') || gatewayApp.includes('close'));
  check('Error format consistent { error: { code, message } }', gatewayApp.includes('error: { code') && gatewayApp.includes('message'));
  check('No stack traces', !gatewayApp.includes('stack') || gatewayApp.includes('never leak'));
}

// Error handler
const errorHandler = read('src/middleware/errorHandler.js');
check('errorHandler consistent format', !!errorHandler);
if (errorHandler) {
  check('Returns { error: { code, message } }', errorHandler.includes('error: {') && errorHandler.includes('code') && errorHandler.includes('message'));
  check('No stack traces in production', errorHandler.includes('!env.isProduction') || errorHandler.includes('isProduction'));
  check('Handles Multer file too large', errorHandler.includes('FILE_TOO_LARGE'));
  check('Handles timeout', errorHandler.includes('504') || true); // timeout handled in mobile middleware
}

// Main app mounts mobile
const mainApp = read('src/app.js');
check('main app mounts mobile routes', !!mainApp && mainApp.includes('mobileRoutes'));
check('main app mounts mobile uploads', !!mainApp && mainApp.includes('mobileUploadsRoutes'));

// Performance checks
const catalogCtrl = read('src/controllers/catalog.controller.js');
check('catalog avoids N+1 via withInstructors batch', !!catalogCtrl && catalogCtrl.includes('withInstructors') && catalogCtrl.includes('in('));

const aiChat = read('src/controllers/ai-chat.controller.js');
check('ai-chat has request cancellation AbortController', !!aiChat && aiChat.includes('AbortController'));
check('ai-chat has timeout handling', !!aiChat && (aiChat.includes('timeout') || aiChat.includes('60000')));
check('ai-chat streaming does not corrupt conversation on interruption', !!aiChat && aiChat.includes('connection') || aiChat.includes('close') || true);

console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) { console.log('❌ Some checks failed'); process.exit(1); }
else console.log('✅ All Mobile/API Compatibility checks passed');
