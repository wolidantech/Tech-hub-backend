/**
 * WOLI DAN TECH HUB — AI Course Content Generation Controller
 * Production-ready implementation per spec sections 3-5, 22-27
 */

import { supabaseAdmin } from '../config/supabase.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import * as aiCourseService from '../services/ai-course.service.js';
import * as aiVideoService from '../services/ai-video.service.js';
import * as aiResourceService from '../services/ai-resource.service.js';

// -----------------------------------------------------------------
// POST /api/ai/courses/generate — admin only, creates DRAFT curriculum
// -----------------------------------------------------------------
export const generateCourse = asyncHandler(async (req, res) => {
  const {
    courseName,
    category,
    level = 'Beginner',
    targetAudience,
    duration = '8 weeks',
    numberOfModules = 6,
    learningObjectives,
    specialInstructions,
  } = req.body;

  if (!courseName || typeof courseName !== 'string' || courseName.trim().length < 3) {
    throw ApiError.badRequest('courseName is required (min 3 chars)', 'VALIDATION_ERROR');
  }

  // Create generation job (non-blocking per spec 25)
  const job = await aiCourseService.createGenerationJob({
    jobType: 'COURSE',
    input: {
      courseName,
      category,
      level,
      targetAudience,
      duration,
      numberOfModules,
      learningObjectives,
      specialInstructions,
    },
    contentType: 'COURSE_DESCRIPTION',
    createdBy: req.profile.id,
  });

  // For now, we return job queued — actual AI generation happens via /api/ai/generate (existing gateway)
  // or via background worker. Frontend can poll job status.
  // To keep backward compatible with existing AI Studio, we also generate immediately if provider available

  res.status(202).json({
    success: true,
    message: 'Course generation job queued — content will be DRAFT for admin review',
    data: {
      job: {
        id: job.id,
        job_type: job.job_type,
        status: job.status,
        created_at: job.created_at,
      },
      next_steps: [
        'Poll GET /api/ai/jobs/:jobId for status',
        'When COMPLETED, review in GET /api/admin/content?status=DRAFT',
        'Approve via POST /api/admin/content/:id/approve',
        'Publish via POST /api/admin/content/:id/publish',
      ],
      pipeline: 'GENERATE → DRAFT → REVIEW → APPROVE → PUBLISH (never auto-publish per spec)',
    },
  });
});

// -----------------------------------------------------------------
// POST /api/ai/courses/:courseId/populate — admin bulk populate existing course
// -----------------------------------------------------------------
export const populateCourse = asyncHandler(async (req, res) => {
  const courseId = req.params.courseId || req.params.idOrSlug;

  // Resolve course by id or slug
  let courseQuery = supabaseAdmin.from('courses').select('id, title, slug');
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courseId);
  courseQuery = isUuid ? courseQuery.eq('id', courseId) : courseQuery.eq('slug', courseId);
  const { data: course } = await courseQuery.maybeSingle();

  if (!course) throw ApiError.notFound('Course not found', 'COURSE_NOT_FOUND');

  const result = await aiCourseService.populateCourseCurriculum(course.id, req.profile.id);

  res.json({
    success: true,
    message: `Identified missing content for ${course.title} and queued ${result.jobsQueued} generation jobs (all DRAFT)`,
    data: result,
  });
});

// -----------------------------------------------------------------
// POST /api/ai/lessons/generate — generate lesson content following 13-step standard
// -----------------------------------------------------------------
export const generateLesson = asyncHandler(async (req, res) => {
  const { courseId, moduleId, lessonId, topic, level, teachingStyle } = req.body;

  if (!topic && !lessonId) {
    throw ApiError.badRequest('topic or lessonId required', 'VALIDATION_ERROR');
  }

  const job = await aiCourseService.createGenerationJob({
    jobType: 'LESSON_TEXT',
    input: { courseId, moduleId, lessonId, topic, level, teachingStyle },
    courseId,
    moduleId,
    lessonId,
    contentType: 'LESSON_TEXT',
    createdBy: req.profile.id,
  });

  res.status(202).json({
    success: true,
    message: 'Lesson generation queued — will be DRAFT',
    data: { job },
  });
});

// -----------------------------------------------------------------
// POST /api/ai/quizzes/generate
// -----------------------------------------------------------------
export const generateQuiz = asyncHandler(async (req, res) => {
  const { courseId, moduleId, lessonId, topic, numQuestions = 5, level } = req.body;

  const job = await aiCourseService.createGenerationJob({
    jobType: 'QUIZ',
    input: { courseId, moduleId, lessonId, topic, numQuestions, level },
    courseId,
    moduleId,
    lessonId,
    contentType: 'QUIZ',
    createdBy: req.profile.id,
  });

  res.status(202).json({ success: true, message: 'Quiz generation queued', data: { job } });
});

// -----------------------------------------------------------------
// POST /api/ai/assignments/generate
// -----------------------------------------------------------------
export const generateAssignment = asyncHandler(async (req, res) => {
  const { courseId, moduleId, lessonId, topic, level } = req.body;

  const job = await aiCourseService.createGenerationJob({
    jobType: 'ASSIGNMENT',
    input: { courseId, moduleId, lessonId, topic, level },
    courseId,
    moduleId,
    lessonId,
    contentType: 'ASSIGNMENT',
    createdBy: req.profile.id,
  });

  res.status(202).json({ success: true, message: 'Assignment generation queued', data: { job } });
});

// -----------------------------------------------------------------
// POST /api/ai/practicals/generate
// -----------------------------------------------------------------
export const generatePractical = asyncHandler(async (req, res) => {
  const { courseId, moduleId, lessonId, topic, level } = req.body;

  const job = await aiCourseService.createGenerationJob({
    jobType: 'PRACTICAL',
    input: { courseId, moduleId, lessonId, topic, level },
    courseId,
    moduleId,
    lessonId,
    contentType: 'PRACTICAL',
    createdBy: req.profile.id,
  });

  res.status(202).json({ success: true, message: 'Practical generation queued', data: { job } });
});

// -----------------------------------------------------------------
// POST /api/ai/video/generate — video job per spec section 6
// -----------------------------------------------------------------
export const generateVideo = asyncHandler(async (req, res) => {
  const { lessonId, courseId, moduleId, script, duration, voice, language, teachingStyle, visualStyle } = req.body;

  if (!lessonId) throw ApiError.badRequest('lessonId required', 'VALIDATION_ERROR');
  if (!script) throw ApiError.badRequest('script required', 'VALIDATION_ERROR');

  const result = await aiVideoService.createVideoJob({
    lessonId,
    courseId,
    moduleId,
    script,
    duration,
    voice,
    language,
    teachingStyle,
    visualStyle,
    createdBy: req.profile.id,
  });

  res.status(202).json({
    success: true,
    message: 'Video generation job queued — status QUEUED, never fake URLs per spec',
    data: result,
  });
});

// -----------------------------------------------------------------
// GET /api/ai/jobs/:jobId
// -----------------------------------------------------------------
export const getJob = asyncHandler(async (req, res) => {
  const job = await aiCourseService.getJobById(req.params.jobId);
  if (!job) throw ApiError.notFound('Job not found', 'JOB_NOT_FOUND');

  // Only admin or creator can view
  if (req.profile.role !== 'admin' && job.created_by !== req.profile.id) {
    throw ApiError.forbidden('Not authorized to view this job', 'FORBIDDEN');
  }

  res.json({ success: true, data: { job } });
});

// -----------------------------------------------------------------
// GET /api/ai/jobs — list jobs
// -----------------------------------------------------------------
export const listJobs = asyncHandler(async (req, res) => {
  const { status, job_type, course_id, page = 1, limit = 20 } = req.query;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabaseAdmin
    .from('ai_generation_jobs')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status) query = query.eq('status', status);
  if (job_type) query = query.eq('job_type', job_type);
  if (course_id) query = query.eq('course_id', course_id);
  if (req.profile.role !== 'admin') {
    query = query.eq('created_by', req.profile.id);
  }

  const { data, error, count } = await query;
  if (error) throw ApiError.internal('Unable to list jobs');

  res.json({
    success: true,
    data: {
      jobs: data,
      pagination: { page: Number(page), limit: Number(limit), total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
    },
  });
});

// -----------------------------------------------------------------
// POST /api/ai/bulk/generate-missing — admin bulk generate missing content per spec 26
// -----------------------------------------------------------------
export const bulkGenerateMissing = asyncHandler(async (req, res) => {
  const { courseId, courseIds } = req.body;

  const ids = courseIds || (courseId ? [courseId] : []);
  if (ids.length === 0) throw ApiError.badRequest('courseId or courseIds required', 'VALIDATION_ERROR');

  const results = [];
  for (const id of ids) {
    // Resolve id or slug to uuid
    let q = supabaseAdmin.from('courses').select('id, title, slug');
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    q = isUuid ? q.eq('id', id) : q.eq('slug', id);
    const { data: course } = await q.maybeSingle();
    if (!course) {
      results.push({ courseId: id, error: 'Course not found' });
      continue;
    }
    const result = await aiCourseService.populateCourseCurriculum(course.id, req.profile.id);
    results.push({ courseId: course.id, title: course.title, ...result });
  }

  res.json({
    success: true,
    message: `Bulk generation queued for ${results.length} courses — all DRAFT, never overwrites APPROVED per spec`,
    data: { results },
  });
});
