/**
 * WOLI DAN TECH HUB — AI Content Generation Handlers for Gateway (Railway)
 * Production-ready course-content generation per spec sections 2-27
 * Uses same auth as existing gateway (requireAuth + requireAdmin)
 * All generated content is DRAFT for admin review, never auto-published
 */

import { z } from 'zod';
import * as aiCourseService from '../services/ai-course.service.js';
import * as aiVideoService from '../services/ai-video.service.js';

const courseGenSchema = z.object({
  courseName: z.string().min(3).max(200),
  category: z.string().max(100).optional(),
  level: z.enum(['Beginner', 'Intermediate', 'Advanced']).optional().default('Beginner'),
  targetAudience: z.string().max(500).optional(),
  duration: z.string().max(50).optional().default('8 weeks'),
  numberOfModules: z.coerce.number().int().min(1).max(20).optional().default(6),
  learningObjectives: z.array(z.string()).optional(),
  specialInstructions: z.string().max(2000).optional(),
});

const lessonGenSchema = z.object({
  courseId: z.string().optional(),
  moduleId: z.string().optional(),
  lessonId: z.string().optional(),
  topic: z.string().min(3).max(200).optional(),
  level: z.string().optional(),
  teachingStyle: z.string().optional(),
});

const quizGenSchema = z.object({
  courseId: z.string().optional(),
  moduleId: z.string().optional(),
  lessonId: z.string().optional(),
  topic: z.string().min(3).max(200),
  numQuestions: z.coerce.number().int().min(1).max(20).optional().default(5),
  level: z.string().optional(),
});

const assignmentGenSchema = z.object({
  courseId: z.string().optional(),
  moduleId: z.string().optional(),
  lessonId: z.string().optional(),
  topic: z.string().min(3).max(200),
  level: z.string().optional(),
});

const practicalGenSchema = assignmentGenSchema;

const videoGenSchema = z.object({
  lessonId: z.string().min(1),
  courseId: z.string().optional(),
  moduleId: z.string().optional(),
  script: z.string().min(10).max(10000),
  duration: z.coerce.number().int().min(10).max(3600).optional(),
  voice: z.object({ gender: z.string().optional(), language: z.string().optional(), speed: z.number().optional(), style: z.string().optional() }).optional(),
  language: z.string().optional().default('en'),
  teachingStyle: z.string().optional(),
  visualStyle: z.string().optional(),
});

const bulkGenSchema = z.object({
  courseId: z.string().optional(),
  courseIds: z.array(z.string()).optional(),
});

export function createAiContentHandlers({ logger = console } = {}) {
  const generateCourse = async (req, res) => {
    const parsed = courseGenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', message: parsed.error.errors[0]?.message || 'Invalid body', code: 'BAD_REQUEST' });
    }

    const job = await aiCourseService.createGenerationJob({
      jobType: 'COURSE',
      input: parsed.data,
      contentType: 'COURSE_DESCRIPTION',
      createdBy: req.profile?.id,
    });

    logger.info?.({ route: '/api/ai/courses/generate', jobId: job.id, status: 'QUEUED' });

    return res.status(202).json({
      success: true,
      message: 'Course generation job queued — DRAFT for admin review, never auto-published',
      data: { job, pipeline: 'GENERATE → DRAFT → REVIEW → APPROVE → PUBLISH' },
    });
  };

  const populateCourse = async (req, res) => {
    const courseId = req.params.courseId;
    if (!courseId) return res.status(400).json({ error: 'courseId required' });

    // Resolve course
    const { supabaseAdmin } = await import('../config/supabase.js');
    let q = supabaseAdmin.from('courses').select('id, title, slug');
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courseId);
    q = isUuid ? q.eq('id', courseId) : q.eq('slug', courseId);
    const { data: course } = await q.maybeSingle();
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const result = await aiCourseService.populateCourseCurriculum(course.id, req.profile?.id);

    return res.json({
      success: true,
      message: `Populated ${course.title}: queued ${result.jobsQueued} jobs (DRAFT)`,
      data: result,
    });
  };

  const generateLesson = async (req, res) => {
    const parsed = lessonGenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', message: parsed.error.errors[0]?.message });
    if (!parsed.data.topic && !parsed.data.lessonId) return res.status(400).json({ error: 'topic or lessonId required' });

    const job = await aiCourseService.createGenerationJob({
      jobType: 'LESSON_TEXT',
      input: parsed.data,
      courseId: parsed.data.courseId,
      moduleId: parsed.data.moduleId,
      lessonId: parsed.data.lessonId,
      contentType: 'LESSON_TEXT',
      createdBy: req.profile?.id,
    });

    return res.status(202).json({ success: true, message: 'Lesson generation queued — DRAFT', data: { job } });
  };

  const generateQuiz = async (req, res) => {
    const parsed = quizGenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', message: parsed.error.errors[0]?.message });

    const job = await aiCourseService.createGenerationJob({
      jobType: 'QUIZ',
      input: parsed.data,
      courseId: parsed.data.courseId,
      moduleId: parsed.data.moduleId,
      lessonId: parsed.data.lessonId,
      contentType: 'QUIZ',
      createdBy: req.profile?.id,
    });

    return res.status(202).json({ success: true, message: 'Quiz generation queued', data: { job } });
  };

  const generateAssignment = async (req, res) => {
    const parsed = assignmentGenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

    const job = await aiCourseService.createGenerationJob({
      jobType: 'ASSIGNMENT',
      input: parsed.data,
      courseId: parsed.data.courseId,
      moduleId: parsed.data.moduleId,
      lessonId: parsed.data.lessonId,
      contentType: 'ASSIGNMENT',
      createdBy: req.profile?.id,
    });

    return res.status(202).json({ success: true, message: 'Assignment generation queued', data: { job } });
  };

  const generatePractical = async (req, res) => {
    const parsed = practicalGenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

    const job = await aiCourseService.createGenerationJob({
      jobType: 'PRACTICAL',
      input: parsed.data,
      courseId: parsed.data.courseId,
      moduleId: parsed.data.moduleId,
      lessonId: parsed.data.lessonId,
      contentType: 'PRACTICAL',
      createdBy: req.profile?.id,
    });

    return res.status(202).json({ success: true, message: 'Practical generation queued', data: { job } });
  };

  const generateVideo = async (req, res) => {
    const parsed = videoGenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', message: parsed.error.errors[0]?.message });

    try {
      const result = await aiVideoService.createVideoJob({
        lessonId: parsed.data.lessonId,
        courseId: parsed.data.courseId,
        moduleId: parsed.data.moduleId,
        script: parsed.data.script,
        duration: parsed.data.duration,
        voice: parsed.data.voice,
        language: parsed.data.language,
        teachingStyle: parsed.data.teachingStyle,
        visualStyle: parsed.data.visualStyle,
        createdBy: req.profile?.id,
      });

      return res.status(202).json({
        success: true,
        message: 'Video job QUEUED — never fake URLs, status will be FAILED if generation fails',
        data: result,
      });
    } catch (e) {
      return res.status(400).json({ error: 'Video job failed', message: e.message });
    }
  };

  const getJob = async (req, res) => {
    const job = await aiCourseService.getJobById(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    // Admin can view any, creator can view own
    if (req.profile?.role !== 'admin' && job.created_by !== req.profile?.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json({ success: true, data: { job } });
  };

  const listJobs = async (req, res) => {
    const { supabaseAdmin } = await import('../config/supabase.js');
    const { status, job_type, course_id, page = 1, limit = 20 } = req.query;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabaseAdmin.from('ai_generation_jobs').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
    if (status) query = query.eq('status', status);
    if (job_type) query = query.eq('job_type', job_type);
    if (course_id) query = query.eq('course_id', course_id);
    if (req.profile?.role !== 'admin') query = query.eq('created_by', req.profile.id);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: 'Unable to list jobs' });

    return res.json({
      success: true,
      data: { jobs: data, pagination: { page: Number(page), limit: Number(limit), total: count || 0, total_pages: Math.ceil((count || 0) / limit) } },
    });
  };

  const bulkGenerateMissing = async (req, res) => {
    const parsed = bulkGenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'courseId or courseIds required' });

    const ids = parsed.data.courseIds || (parsed.data.courseId ? [parsed.data.courseId] : []);
    if (ids.length === 0) return res.status(400).json({ error: 'courseId required' });

    const { supabaseAdmin } = await import('../config/supabase.js');
    const results = [];
    for (const id of ids) {
      let q = supabaseAdmin.from('courses').select('id, title, slug');
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      q = isUuid ? q.eq('id', id) : q.eq('slug', id);
      const { data: course } = await q.maybeSingle();
      if (!course) {
        results.push({ courseId: id, error: 'Not found' });
        continue;
      }
      const result = await aiCourseService.populateCourseCurriculum(course.id, req.profile?.id);
      results.push({ courseId: course.id, title: course.title, ...result });
    }

    return res.json({
      success: true,
      message: `Bulk queued for ${results.length} courses — DRAFT only, never overwrites APPROVED`,
      data: { results },
    });
  };

  return {
    generateCourse,
    populateCourse,
    generateLesson,
    generateQuiz,
    generateAssignment,
    generatePractical,
    generateVideo,
    getJob,
    listJobs,
    bulkGenerateMissing,
  };
}

export default createAiContentHandlers;
