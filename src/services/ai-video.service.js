/**
 * WOLI DAN TECH HUB — AI Video Generation Service
 * Provider-independent architecture per spec sections 6-7
 *
 * Never creates fake video URLs — if generation fails, status=FAILED and error stored
 */

import { supabaseAdmin } from '../config/supabase.js';
import { BUCKETS } from '../config/env.js';
import { createGenerationJob, updateJobStatus } from './ai-course.service.js';

export async function createVideoJob({
  lessonId,
  courseId,
  moduleId,
  script,
  duration,
  voice,
  language = 'en',
  teachingStyle,
  visualStyle,
  createdBy,
}) {
  // Validate lesson exists
  if (!lessonId) throw new Error('lessonId is required');

  // Create job in ai_generation_jobs
  const job = await createGenerationJob({
    jobType: 'VIDEO',
    input: { lessonId, script, duration, voice, language, teachingStyle, visualStyle },
    courseId,
    moduleId,
    lessonId,
    contentType: 'VIDEO',
    createdBy,
  });

  // Create lesson_videos entry with QUEUED status
  const { data: video, error } = await supabaseAdmin
    .from('lesson_videos')
    .insert({
      lesson_id: lessonId,
      course_id: courseId,
      module_id: moduleId,
      title: `Video for lesson ${lessonId}`,
      script,
      duration: duration ? parseInt(duration) : null,
      status: 'QUEUED',
      voice: voice ? JSON.stringify(voice) : null,
      language,
      teaching_style: teachingStyle,
      visual_style: visualStyle,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) throw error;

  return { job, video };
}

export async function updateVideoStatus(videoId, status, { videoUrl, storagePath, thumbnailUrl, captionsUrl, transcript, duration, error, provider, providerMetadata } = {}) {
  const updates = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (videoUrl !== undefined) updates.video_url = videoUrl;
  if (storagePath !== undefined) updates.storage_path = storagePath;
  if (thumbnailUrl !== undefined) updates.thumbnail_url = thumbnailUrl;
  if (captionsUrl !== undefined) updates.captions_url = captionsUrl;
  if (transcript !== undefined) updates.transcript = transcript;
  if (duration !== undefined) updates.duration = duration;
  if (error !== undefined) updates.error = error;
  if (provider !== undefined) updates.provider = provider;
  if (providerMetadata !== undefined) updates.provider_metadata = providerMetadata;

  // Never create fake URLs — if status is COMPLETED, video_url or storage_path must be present
  if (status === 'COMPLETED' && !updates.video_url && !updates.storage_path) {
    throw new Error('Cannot mark video as COMPLETED without video_url or storage_path — fake URLs not allowed');
  }

  // If FAILED, error must be stored
  if (status === 'FAILED' && !updates.error) {
    updates.error = 'Video generation failed without specific error';
  }

  const { data, error: err } = await supabaseAdmin
    .from('lesson_videos')
    .update(updates)
    .eq('id', videoId)
    .select()
    .single();

  if (err) throw err;
  return data;
}

export async function retryVideoJob(videoId) {
  const { data: video } = await supabaseAdmin.from('lesson_videos').select('*').eq('id', videoId).maybeSingle();
  if (!video) throw new Error('Video not found');
  if (video.status === 'COMPLETED') throw new Error('Video already completed, cannot retry');

  return updateVideoStatus(videoId, 'QUEUED', { error: null });
}

export async function getVideoByLesson(lessonId) {
  const { data, error } = await supabaseAdmin
    .from('lesson_videos')
    .select('*')
    .eq('lesson_id', lessonId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function uploadManualVideo({ lessonId, courseId, moduleId, fileBuffer, fileName, mimeType, createdBy }) {
  // Admin uploads existing legally usable video
  const { uploadObject } = await import('./storage.service.js');
  const path = `course-videos/${courseId}/${lessonId}/${Date.now()}-${fileName}`;

  await uploadObject(BUCKETS.lessonResources || 'lesson-resources', path, fileBuffer, mimeType);

  const { data, error } = await supabaseAdmin
    .from('lesson_videos')
    .insert({
      lesson_id: lessonId,
      course_id: courseId,
      module_id: moduleId,
      title: `Manual upload: ${fileName}`,
      storage_path: path,
      status: 'COMPLETED',
      provider: 'manual',
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}
