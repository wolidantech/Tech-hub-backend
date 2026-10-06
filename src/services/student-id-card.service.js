import PDFDocument from 'pdfkit';
import { PassThrough } from 'node:stream';
import { supabaseAdmin } from '../config/supabase.js';
import { BUCKETS, env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { INSTITUTION_NAME } from '../config/brand.js';
import { createSignedUrl } from './storage.service.js';

const ID_CARD_BUCKET = 'student-id-cards';

async function getAvatarBuffer(photoUrl) {
  let parsed;
  let project;
  try {
    parsed = new URL(photoUrl);
    project = new URL(env.supabaseUrl);
  } catch {
    throw ApiError.badRequest('A valid profile photo is required before generating an ID card', 'ID_CARD_PHOTO_INVALID');
  }
  const prefix = `/storage/v1/object/public/${BUCKETS.avatars}/`;
  if (parsed.host !== project.host || !parsed.pathname.startsWith(prefix)) {
    throw ApiError.badRequest('The profile photo must be stored in the school avatar bucket', 'ID_CARD_PHOTO_INVALID');
  }
  const objectPath = decodeURIComponent(parsed.pathname.slice(prefix.length));
  if (!objectPath || objectPath.split('/').includes('..')) {
    throw ApiError.badRequest('The profile photo path is invalid', 'ID_CARD_PHOTO_INVALID');
  }
  const { data, error } = await supabaseAdmin.storage.from(BUCKETS.avatars).download(objectPath);
  if (error || !data) throw ApiError.badRequest('The profile photo could not be loaded', 'ID_CARD_PHOTO_UNAVAILABLE');
  if (!['image/jpeg', 'image/png'].includes(data.type)) {
    throw ApiError.badRequest('Use a JPEG or PNG photo to generate a student ID card', 'ID_CARD_PHOTO_FORMAT_UNSUPPORTED');
  }
  return Buffer.from(await data.arrayBuffer());
}

export async function renderStudentIdCardPdf(profile, photoBuffer) {
  const stream = new PassThrough();
  const chunks = [];
  const doc = new PDFDocument({ size: [360, 225], margin: 0, info: { Title: 'Student ID Card', Author: INSTITUTION_NAME } });
  const bufferReady = new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    doc.on('error', reject);
  });
  doc.pipe(stream);

  doc.rect(0, 0, 360, 225).fill('#f6f8fb');
  doc.rect(0, 0, 360, 48).fill('#12325a');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(15).text(INSTITUTION_NAME, 18, 13, { width: 324, align: 'center' });
  doc.fillColor('#c9ddf6').font('Helvetica').fontSize(8).text('STUDENT IDENTIFICATION CARD', 18, 31, { width: 324, align: 'center', characterSpacing: 1 });

  doc.roundedRect(17, 62, 104, 128, 5).fill('#d9e3ef');
  doc.image(photoBuffer, 19, 64, { fit: [100, 124], align: 'center', valign: 'center' });

  const textX = 137;
  doc.fillColor('#6b7787').font('Helvetica-Bold').fontSize(7).text('STUDENT NAME', textX, 68);
  doc.fillColor('#162b46').font('Helvetica-Bold').fontSize(13).text(profile.full_name || 'Student', textX, 80, { width: 205, height: 37, ellipsis: true });
  doc.fillColor('#6b7787').font('Helvetica-Bold').fontSize(7).text('STUDENT NUMBER', textX, 127);
  doc.fillColor('#12325a').font('Helvetica-Bold').fontSize(12).text(profile.student_number, textX, 139);
  doc.fillColor('#6b7787').font('Helvetica-Bold').fontSize(7).text('ISSUED', textX, 163);
  doc.fillColor('#26384d').font('Helvetica').fontSize(9).text(new Date().toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' }), textX, 175);

  doc.moveTo(18, 202).lineTo(342, 202).strokeColor('#d5dce5').lineWidth(0.7).stroke();
  doc.fillColor('#64748b').font('Helvetica').fontSize(7).text(`This card is the property of ${INSTITUTION_NAME}.`, 18, 208, { width: 324, align: 'center' });
  doc.end();
  return bufferReady;
}

export async function generateStudentIdCard(profileId) {
  const { data: profile, error: profileError } = await supabaseAdmin.from('profiles')
    .select('id, full_name, email, profile_photo_url, student_number')
    .eq('id', profileId).maybeSingle();
  if (profileError) throw ApiError.internal('Unable to load student profile for ID card');
  if (!profile) throw ApiError.notFound('Student profile not found', 'PROFILE_NOT_FOUND');
  if (!profile.student_number) throw ApiError.conflict('Student number has not been assigned yet', 'STUDENT_NUMBER_PENDING');

  const { data: card, error: cardError } = await supabaseAdmin.from('student_id_cards')
    .select('*').eq('profile_id', profile.id).maybeSingle();
  if (cardError) throw ApiError.internal('Unable to load student ID card state');
  if (card?.status === 'REVOKED') throw ApiError.forbidden('This student ID card has been revoked', 'ID_CARD_REVOKED');
  if (!profile.profile_photo_url) {
    await supabaseAdmin.from('student_id_cards').upsert({
      profile_id: profile.id,
      student_number: profile.student_number,
      status: 'PENDING_PHOTO',
      card_storage_path: null,
      issued_at: null,
    }, { onConflict: 'profile_id' });
    return { status: 'PENDING_PHOTO', student_number: profile.student_number, signed_url: null };
  }

  const photoBuffer = await getAvatarBuffer(profile.profile_photo_url);
  const pdf = await renderStudentIdCardPdf(profile, photoBuffer);
  const storagePath = `${profile.id}/${profile.student_number}.pdf`;
  const { error: uploadError } = await supabaseAdmin.storage.from(ID_CARD_BUCKET).upload(storagePath, pdf, {
    contentType: 'application/pdf',
    upsert: true,
    cacheControl: '300',
  });
  if (uploadError) {
    console.error('[student-id-card] upload failed', uploadError.message);
    throw ApiError.internal('Unable to save the generated ID card');
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin.from('student_id_cards').upsert({
    profile_id: profile.id,
    student_number: profile.student_number,
    status: 'GENERATED',
    card_storage_path: storagePath,
    issued_at: card?.issued_at || now,
    last_generated_at: now,
  }, { onConflict: 'profile_id' });
  if (updateError) throw ApiError.internal('Unable to update student ID card status');

  return {
    status: 'GENERATED',
    student_number: profile.student_number,
    signed_url: await createSignedUrl(ID_CARD_BUCKET, storagePath, 300),
    issued_at: card?.issued_at || now,
    last_generated_at: now,
  };
}

export async function getStudentIdCard(profileId) {
  const { data: profile, error: profileError } = await supabaseAdmin.from('profiles')
    .select('id, student_number, profile_photo_url').eq('id', profileId).maybeSingle();
  if (profileError) throw ApiError.internal('Unable to load student profile');
  if (!profile) throw ApiError.notFound('Student profile not found', 'PROFILE_NOT_FOUND');

  const { data: card, error } = await supabaseAdmin.from('student_id_cards')
    .select('profile_id, student_number, status, card_storage_path, issued_at, last_generated_at')
    .eq('profile_id', profileId).maybeSingle();
  if (error) throw ApiError.internal('Unable to load student ID card');
  if (!card) return generateStudentIdCard(profileId);
  if (card.status === 'REVOKED') throw ApiError.forbidden('This student ID card has been revoked', 'ID_CARD_REVOKED');
  if (['PENDING_GENERATION', 'PENDING_PHOTO'].includes(card.status) && profile.profile_photo_url) {
    return generateStudentIdCard(profileId);
  }
  if (card.status === 'GENERATED' && card.card_storage_path) {
    return { ...card, signed_url: await createSignedUrl(ID_CARD_BUCKET, card.card_storage_path, 300) };
  }
  return { ...card, signed_url: null };
}
