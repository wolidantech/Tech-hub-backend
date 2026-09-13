/**
 * WOLI DAN TECH HUB — AI Course Generation Service
 * Production-ready curriculum pipeline per spec sections 2-5, 18-27
 *
 * Pipeline:
 * COURSE CREATED → AI CURRICULUM → MODULES → LESSONS → PRACTICAL → QUIZ → PROJECT → RESOURCES → VIDEO → QUALITY CHECK → DRAFT → REVIEW → APPROVED → PUBLISHED
 *
 * Never auto-publishes unreviewed content.
 */

import { supabaseAdmin } from '../config/supabase.js';

// -----------------------------------------------------------------
// Quality checks per spec section 21
// -----------------------------------------------------------------
export function runQualityChecks(content, contentType) {
  const flags = [];
  let score = 1.0;

  const text = JSON.stringify(content).toLowerCase();

  // Missing sections
  if (contentType === 'LESSON' || contentType === 'LESSON_TEXT') {
    const required = ['learn', 'example', 'exercise', 'summary'];
    const markdown = (content.markdown || content.content || '').toLowerCase();
    for (const sec of required) {
      if (!markdown.includes(sec)) {
        flags.push({ type: 'MISSING_SECTION', message: `Missing section: ${sec}`, severity: 'medium' });
        score -= 0.1;
      }
    }
    if ((content.markdown || content.content || '').length < 300) {
      flags.push({ type: 'INSUFFICIENT_CONTENT', message: 'Lesson too short (<300 chars)', severity: 'high' });
      score -= 0.2;
    }
  }

  // Duplicate content check (simple)
  if (text.length > 100) {
    const words = text.split(/\s+/);
    const unique = new Set(words);
    if (unique.size / words.length < 0.3) {
      flags.push({ type: 'REPETITIVE', message: 'Content appears repetitive', severity: 'medium' });
      score -= 0.15;
    }
  }

  // Check for unsafe instructions
  const unsafePatterns = ['rm -rf', 'delete all', 'drop database', 'format c:'];
  for (const pat of unsafePatterns) {
    if (text.includes(pat)) {
      flags.push({ type: 'UNSAFE', message: `Potentially unsafe instruction: ${pat}`, severity: 'high' });
      score -= 0.3;
    }
  }

  // Missing practical
  if (contentType === 'LESSON' && !content.practicalExercise && !content.assignment) {
    flags.push({ type: 'MISSING_PRACTICAL', message: 'Lesson has no practical exercise', severity: 'low' });
    score -= 0.05;
  }

  // Quiz check
  if (contentType === 'QUIZ' && (!content.questions || content.questions.length < 3)) {
    flags.push({ type: 'INSUFFICIENT_ASSESSMENT', message: 'Quiz has less than 3 questions', severity: 'medium' });
    score -= 0.1;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    flags,
    score: Number(score.toFixed(2)),
    passed: score >= 0.7 && !flags.some(f => f.severity === 'high'),
  };
}

// -----------------------------------------------------------------
// Job management (non-blocking per spec section 25)
// -----------------------------------------------------------------
export async function createGenerationJob({
  jobType,
  input,
  courseId,
  moduleId,
  lessonId,
  contentType,
  createdBy,
  provider,
  model,
}) {
  const { data, error } = await supabaseAdmin
    .from('ai_generation_jobs')
    .insert({
      job_type: jobType,
      status: 'QUEUED',
      input,
      course_id: courseId,
      module_id: moduleId,
      lesson_id: lessonId,
      content_type: contentType,
      created_by: createdBy,
      provider,
      model,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateJobStatus(jobId, status, { output, error, startedAt, completedAt } = {}) {
  const updates = { status, updated_at: new Date().toISOString() };
  if (output !== undefined) updates.output = output;
  if (error !== undefined) updates.error = error;
  if (startedAt) updates.started_at = startedAt;
  if (completedAt) updates.completed_at = completedAt;
  if (status === 'PROCESSING' && !startedAt) updates.started_at = new Date().toISOString();
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) updates.completed_at = new Date().toISOString();

  const { data, error: err } = await supabaseAdmin
    .from('ai_generation_jobs')
    .update(updates)
    .eq('id', jobId)
    .select()
    .single();

  if (err) throw err;
  return data;
}

export async function getJobById(jobId) {
  const { data, error } = await supabaseAdmin
    .from('ai_generation_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// -----------------------------------------------------------------
// Content versioning per spec section 19
// -----------------------------------------------------------------
export async function createGeneratedContent({
  jobId,
  courseId,
  moduleId,
  lessonId,
  contentType,
  content,
  generatedBy,
}) {
  // Get next version
  const { data: existing } = await supabaseAdmin
    .from('ai_generated_content')
    .select('version')
    .eq('course_id', courseId)
    .eq('content_type', contentType)
    .eq('module_id', moduleId || null)
    .eq('lesson_id', lessonId || null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (existing?.version || 0) + 1;

  // Quality check
  const quality = runQualityChecks(content, contentType);

  const { data, error } = await supabaseAdmin
    .from('ai_generated_content')
    .insert({
      job_id: jobId,
      course_id: courseId,
      module_id: moduleId,
      lesson_id: lessonId,
      content_type: contentType,
      content,
      version: nextVersion,
      status: 'DRAFT', // Always DRAFT per spec, never auto-publish
      quality_flags: quality.flags,
      quality_score: quality.score,
      generated_by: generatedBy,
    })
    .select()
    .single();

  if (error) throw error;
  return { content: data, quality };
}

export async function getContentById(contentId) {
  const { data, error } = await supabaseAdmin
    .from('ai_generated_content')
    .select('*')
    .eq('id', contentId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listContent({ courseId, moduleId, lessonId, contentType, status, page = 1, limit = 20 }) {
  let query = supabaseAdmin
    .from('ai_generated_content')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (courseId) query = query.eq('course_id', courseId);
  if (moduleId) query = query.eq('module_id', moduleId);
  if (lessonId) query = query.eq('lesson_id', lessonId);
  if (contentType) query = query.eq('content_type', contentType);
  if (status) query = query.eq('status', status);

  const from = (page - 1) * limit;
  const to = from + limit - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { data, count, page, limit, totalPages: Math.ceil((count || 0) / limit) };
}

export async function approveContent(contentId, approvedBy) {
  const { data, error } = await supabaseAdmin
    .from('ai_generated_content')
    .update({
      status: 'APPROVED',
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contentId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function publishContent(contentId, approvedBy) {
  // Must be APPROVED first
  const existing = await getContentById(contentId);
  if (!existing) throw new Error('Content not found');
  if (existing.status !== 'APPROVED') throw new Error('Content must be APPROVED before publishing');

  const { data, error } = await supabaseAdmin
    .from('ai_generated_content')
    .update({
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contentId)
    .select()
    .single();

  if (error) throw error;

  // If this is lesson content, also update lesson_content RAG table and actual lessons table if needed
  // For now, we mark as published — actual publishing to lessons table happens via admin review
  return data;
}

export async function unpublishContent(contentId) {
  const { data, error } = await supabaseAdmin
    .from('ai_generated_content')
    .update({
      status: 'UNPUBLISHED',
      updated_at: new Date().toISOString(),
    })
    .eq('id', contentId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// -----------------------------------------------------------------
// Bulk generation: identify missing content per spec section 26
// -----------------------------------------------------------------
export async function identifyMissingContent(courseId) {
  const { data: course } = await supabaseAdmin.from('courses').select('id, title').eq('id', courseId).maybeSingle();
  if (!course) throw new Error('Course not found');

  const { data: modules } = await supabaseAdmin.from('course_modules').select('id, title').eq('course_id', courseId);

  const missing = {
    course_id: courseId,
    course_title: course.title,
    modules_missing: 0,
    lessons_missing: [],
    practicals_missing: [],
    quizzes_missing: [],
    assignments_missing: [],
    resources_missing: [],
    videos_missing: [],
  };

  if (!modules || modules.length === 0) {
    missing.modules_missing = 1; // needs modules
    return missing;
  }

  for (const mod of modules) {
    const { count: lessonsCount } = await supabaseAdmin
      .from('lessons')
      .select('id', { count: 'exact', head: true })
      .eq('module_id', mod.id);

    if ((lessonsCount || 0) === 0) {
      missing.lessons_missing.push({ module_id: mod.id, module_title: mod.title });
    } else {
      // Check lessons for missing practicals, quizzes, etc.
      const { data: lessons } = await supabaseAdmin.from('lessons').select('id, title').eq('module_id', mod.id);
      for (const lesson of lessons || []) {
        // Check if lesson has practical
        const { count: practicalCount } = await supabaseAdmin
          .from('lesson_practicals')
          .select('id', { count: 'exact', head: true })
          .eq('lesson_id', lesson.id);

        if ((practicalCount || 0) === 0) {
          missing.practicals_missing.push({ lesson_id: lesson.id, lesson_title: lesson.title });
        }

        // Check quiz
        const { count: quizCount } = await supabaseAdmin
          .from('quizzes')
          .select('id', { count: 'exact', head: true })
          .eq('lesson_id', lesson.id);

        if ((quizCount || 0) === 0) {
          missing.quizzes_missing.push({ lesson_id: lesson.id });
        }

        // Check assignment
        const { count: assignCount } = await supabaseAdmin
          .from('assignments')
          .select('id', { count: 'exact', head: true })
          .eq('lesson_id', lesson.id);

        if ((assignCount || 0) === 0) {
          missing.assignments_missing.push({ lesson_id: lesson.id });
        }

        // Check video
        const { count: videoCount } = await supabaseAdmin
          .from('lesson_videos')
          .select('id', { count: 'exact', head: true })
          .eq('lesson_id', lesson.id)
          .eq('status', 'COMPLETED');

        if ((videoCount || 0) === 0) {
          missing.videos_missing.push({ lesson_id: lesson.id });
        }

        // Check resources
        const { count: resCount } = await supabaseAdmin
          .from('course_resources')
          .select('id', { count: 'exact', head: true })
          .eq('lesson_id', lesson.id)
          .eq('is_approved', true);

        if ((resCount || 0) === 0) {
          missing.resources_missing.push({ lesson_id: lesson.id });
        }
      }
    }
  }

  return missing;
}

// -----------------------------------------------------------------
// Initial course population per spec section 27
// -----------------------------------------------------------------
export async function populateCourseCurriculum(courseId, createdBy) {
  const missing = await identifyMissingContent(courseId);
  const jobs = [];

  // If no modules, queue course outline generation
  if (missing.modules_missing > 0) {
    const job = await createGenerationJob({
      jobType: 'COURSE_OUTLINE',
      input: { courseId, target: 'full curriculum' },
      courseId,
      createdBy,
      contentType: 'MODULE',
    });
    jobs.push(job);
  }

  // Queue missing lessons
  for (const m of missing.lessons_missing) {
    const job = await createGenerationJob({
      jobType: 'LESSON',
      input: { moduleId: m.module_id, moduleTitle: m.module_title },
      courseId,
      moduleId: m.module_id,
      createdBy,
      contentType: 'LESSON',
    });
    jobs.push(job);
  }

  // Queue missing practicals, quizzes, etc.
  for (const p of missing.practicals_missing) {
    const job = await createGenerationJob({
      jobType: 'PRACTICAL',
      input: { lessonId: p.lesson_id },
      courseId,
      lessonId: p.lesson_id,
      createdBy,
      contentType: 'PRACTICAL',
    });
    jobs.push(job);
  }

  for (const q of missing.quizzes_missing) {
    const job = await createGenerationJob({
      jobType: 'QUIZ',
      input: { lessonId: q.lesson_id },
      courseId,
      lessonId: q.lesson_id,
      createdBy,
      contentType: 'QUIZ',
    });
    jobs.push(job);
  }

  return { missing, jobsQueued: jobs.length, jobs };
}
