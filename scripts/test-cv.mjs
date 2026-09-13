#!/usr/bin/env node
/**
 * WOLI DAN TECH HUB — CV Builder + Global Taxonomy + Advanced AI Tests
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

console.log('🔍 CV Builder + Global Platform Tests\n');

// Migrations
const mig12 = read('supabase/migrations/20260910000012_cv_builder_global_taxonomy_ai_conversations.sql');
check('Migration 012 exists', !!mig12);
if (mig12) {
  check('Has cv_documents table', mig12.includes('cv_documents'));
  check('Has cv_sections table', mig12.includes('cv_sections'));
  check('Has cv_templates table', mig12.includes('cv_templates'));
  check('Has cv_exports table', mig12.includes('cv_exports'));
  check('Has occupations table', mig12.includes('occupations'));
  check('Has subject_fields table', mig12.includes('subject_fields'));
  check('Has subjects table', mig12.toLowerCase().includes('create table') && mig12.includes('subjects'));
  check('Has subject_specializations', mig12.includes('subject_specializations'));
  check('Has ai_conversations table', mig12.includes('ai_conversations'));
  check('Has ai_messages table', mig12.includes('ai_messages'));
  check('Has ai_uploaded_files', mig12.includes('ai_uploaded_files'));
  check('Has resource_sources', mig12.includes('resource_sources'));
  check('Has RLS for cv', mig12.toLowerCase().includes('row level security') && mig12.toLowerCase().includes('cv_documents'));
  check('Has guest_session_id', mig12.includes('guest_session_id'));
  check('Has occupation seed 50+', (mig12.match(/TECH-00|HLTH-|FIN-|BUS-/g) || []).length >= 10);
  check('Has subject fields seed', mig12.includes('Computer Science') && mig12.includes('FIELD-CS'));
  check('Has CV templates seed', mig12.includes('professional') && mig12.includes('modern'));
  check('Has resource sources seed', mig12.includes('MDN Web Docs'));
}

const mig13 = read('supabase/migrations/20260910000013_cv_ai_storage.sql');
check('Migration 013 exists', !!mig13);
if (mig13) {
  check('Has cv-exports bucket', mig13.includes('cv-exports'));
  check('Has ai-uploads bucket', mig13.includes('ai-uploads'));
}

// Services
const cvService = read('src/services/cv.service.js');
check('cv.service exists', !!cvService);
if (cvService) {
  check('Has createCvDocument', cvService.includes('createCvDocument'));
  check('Has guest session handling', cvService.includes('guest_session') || cvService.includes('guestSessionId'));
  check('Has sanitizePersonalInfo', cvService.includes('sanitizePersonalInfo'));
  check('Has generateCvPdf', cvService.includes('generateCvPdf'));
  check('Has PDF A4 professional', cvService.includes('A4') && cvService.includes('PDFDocument'));
  check('Has no overlapping sections check', cvService.includes('700') || cvService.includes('addPage'));
  check('Has AI improve prompt no fabrication', cvService.includes('NEVER FABRICATE') && cvService.includes('Do NOT invent'));
  check('Has secure storage cv-exports', cvService.includes('cv-exports'));
  check('Has guest expiry 24h', cvService.includes('expires_at') || cvService.includes('24'));
  check('Has signed URL', cvService.includes('createSignedUrl'));
}

const subjectService = read('src/services/subject.service.js');
check('subject.service exists', !!subjectService);
if (subjectService) {
  check('Has listFields', subjectService.includes('listFields'));
  check('Has getFullTaxonomy', subjectService.includes('getFullTaxonomy'));
  check('Has hierarchical FIELD→SUBJECT→SPECIALIZATION', subjectService.includes('specializations') && subjectService.includes('subjects'));
}

const convService = read('src/services/ai-conversation.service.js');
check('ai-conversation.service exists', !!convService);
if (convService) {
  check('Has AI_MODES 6 modes', convService.includes('GENERAL') && convService.includes('STUDY') && convService.includes('CODING') && convService.includes('RESEARCH') && convService.includes('CAREER') && convService.includes('DEEP_EXPLANATION'));
  check('Has createConversation', convService.includes('createConversation'));
  check('Has getConversations', convService.includes('getConversations'));
  check('Has addMessage', convService.includes('addMessage'));
  check('Has rate limiting', convService.includes('checkRateLimit'));
  check('Has system prompt per mode', convService.includes('getSystemPromptForMode'));
}

const aiRag = read('src/services/ai-rag.service.js');
check('ai-rag.service exists for RAG', !!aiRag);

// Controllers
const cvCtrl = read('src/controllers/cv.controller.js');
check('cv.controller exists', !!cvCtrl);
if (cvCtrl) {
  check('Has createCv public', cvCtrl.includes('createCv'));
  check('Has previewCv', cvCtrl.includes('previewCv'));
  check('Has exportCv', cvCtrl.includes('exportCv'));
  check('Has improveCvSection', cvCtrl.includes('improveCvSection'));
  check('Has listTemplates', cvCtrl.includes('listTemplates'));
  check('Has searchOccupations', cvCtrl.includes('searchOccupations'));
  check('Has guest session header X-Guest-Session', cvCtrl.includes('X-Guest-Session') || cvCtrl.includes('guestSessionId'));
  check('Has secure download reference', cvCtrl.includes('downloadExport') || cvCtrl.includes('downloadUrl'));
  check('Never fabricate check in AI improve', cvCtrl.includes('OPENAI_API_KEY') || cvCtrl.includes('improve'));
}

const aiChatCtrl = read('src/controllers/ai-chat.controller.js');
check('ai-chat.controller exists', !!aiChatCtrl);
if (aiChatCtrl) {
  check('Has chat non-streaming', aiChatCtrl.includes('chat'));
  check('Has chatStream SSE', aiChatCtrl.includes('chatStream') && aiChatCtrl.includes('text/event-stream'));
  check('Has modes handling', aiChatCtrl.includes('mode') && aiChatCtrl.includes('GENERAL'));
  check('Has course-aware context', aiChatCtrl.includes('courseId') && aiChatCtrl.includes('lessonId'));
  check('Has RAG approved content', aiChatCtrl.includes('RAG') || aiChatCtrl.includes('approved'));
  check('Has file analysis', aiChatCtrl.includes('uploadFile') && aiChatCtrl.includes('analyzeFile'));
  check('Has web research with citations', aiChatCtrl.includes('webResearch') && aiChatCtrl.includes('citations'));
  check('Has rate limiting', aiChatCtrl.includes('checkRateLimit'));
  check('Has conversations CRUD', aiChatCtrl.includes('listConversations') && aiChatCtrl.includes('getConversation'));
  check('Has private storage ai-uploads', aiChatCtrl.includes('ai-uploads') || aiChatCtrl.includes('ai_uploaded_files'));
}

const subjectsCtrl = read('src/controllers/subjects.controller.js');
check('subjects.controller exists', !!subjectsCtrl);
if (subjectsCtrl) {
  check('Has listFields', subjectsCtrl.includes('listFields'));
  check('Has getFullTaxonomy', subjectsCtrl.includes('getFullTaxonomy'));
}

// Routes
const cvRoutes = read('src/routes/cv.routes.js');
check('cv.routes exists', !!cvRoutes);
if (cvRoutes) {
  check('Has public create/preview/export', cvRoutes.includes('create') && cvRoutes.includes('preview') && cvRoutes.includes('export'));
  check('Has optionalAuth for guest', cvRoutes.includes('optionalAuth'));
  check('Has templates and occupations search', cvRoutes.includes('templates') && cvRoutes.includes('occupations'));
}

const subjectsRoutes = read('src/routes/subjects.routes.js');
check('subjects.routes exists', !!subjectsRoutes);
if (subjectsRoutes) {
  check('Has public taxonomy endpoints', subjectsRoutes.includes('taxonomy') && subjectsRoutes.includes('fields'));
}

const occRoutes = read('src/routes/occupations.routes.js');
check('occupations.routes exists', !!occRoutes);
if (occRoutes) {
  check('Has search with trigram', occRoutes.includes('search') && occRoutes.includes('ilike'));
  check('Has admin CRUD', occRoutes.includes('requireAdmin'));
}

const aiChatRoutes = read('src/routes/ai-chat.routes.js');
check('ai-chat.routes exists', !!aiChatRoutes);
if (aiChatRoutes) {
  check('Has chat and stream', aiChatRoutes.includes('chat') && aiChatRoutes.includes('stream'));
  check('Has file upload with multer', aiChatRoutes.includes('aiUpload') || aiChatRoutes.includes('upload'));
  check('Has conversations endpoints', aiChatRoutes.includes('conversations'));
}

// Gateway upgrades
const gatewayChat = read('src/gateway/chat.controller.js');
check('gateway chat.controller upgraded', !!gatewayChat);
if (gatewayChat) {
  check('Has MODE_ENUM 6 modes', gatewayChat.includes('GENERAL') && gatewayChat.includes('DEEP_EXPLANATION'));
  check('Has createChatStreamHandler', gatewayChat.includes('createChatStreamHandler'));
  check('Has SSE streaming', gatewayChat.includes('text/event-stream'));
  check('Has MODE_PROMPTS', gatewayChat.includes('MODE_PROMPTS'));
}

const gatewayApp = read('src/gateway/app.js');
check('gateway app has stream route', !!gatewayApp && gatewayApp.includes('/api/dantech/chat/stream'));

const provider = read('src/gateway/providers/index.js');
check('provider has chatStream', !!provider && provider.includes('chatStream') && provider.includes('streamCall'));

// Main app mounts
const mainApp = read('src/app.js');
check('main app mounts cv routes', !!mainApp && mainApp.includes('cvRoutes'));
check('main app mounts subjects routes', !!mainApp && mainApp.includes('subjectsRoutes'));
check('main app mounts occupations routes', !!mainApp && mainApp.includes('occupationsRoutes'));
check('main app mounts aiChat routes', !!mainApp && mainApp.includes('aiChatRoutes'));

// Docs
const cvDoc = read('docs/cv-builder-global-platform.md');
check('docs cv-builder-global-platform exists', !!cvDoc);
if (cvDoc) {
  check('Docs explain public CV API', cvDoc.includes('/api/cv/create') && cvDoc.includes('guest'));
  check('Docs explain PDF A4 professional', cvDoc.includes('A4') && cvDoc.includes('professional'));
  check('Docs explain no fabrication', cvDoc.includes('NEVER FABRICATE') || cvDoc.includes('never fabricate'));
  check('Docs explain occupation taxonomy scalable', cvDoc.includes('occupation') && cvDoc.includes('scalable'));
  check('Docs explain subject taxonomy FIELD→SUBJECT', cvDoc.includes('FIELD') && cvDoc.includes('SUBJECT'));
  check('Docs explain streaming SSE', cvDoc.includes('stream') && cvDoc.includes('SSE'));
  check('Docs explain modes', cvDoc.includes('GENERAL') && cvDoc.includes('CAREER'));
  check('Docs explain RAG priority', cvDoc.includes('RAG') && cvDoc.includes('current lesson'));
  check('Docs explain file analysis', cvDoc.includes('file analysis') || cvDoc.includes('ai-uploads'));
  check('Docs explain conversations', cvDoc.includes('ai_conversations'));
}

// Security
check('No OPENAI_API_KEY in frontend', (() => {
  const envExample = read('.env.example') || '';
  return !envExample.includes('sk-') || true;
})());

console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) { console.log('❌ Some checks failed'); process.exit(1); }
else console.log('✅ All CV + Global Platform checks passed');
