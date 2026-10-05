import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { findJambPaperTemplate, mapJambResult } from './jamb-template.js';

const PAID_COURSE_SLUG = 'jamb-cbt-practice-mock-exams';

function mapJambError(error, fallback = 'JAMB operation failed') {
  if (!error) return null;
  const message = String(error.message || '');
  const mappings = [
    ['JAMB_PROFILE_NOT_FOUND', 404, 'PROFILE_NOT_FOUND', 'Student profile was not found'],
    ['JAMB_EXAM_NOT_AVAILABLE', 404, 'JAMB_EXAM_NOT_FOUND', 'This exam is not available'],
    ['JAMB_PAID_ACCESS_REQUIRED', 403, 'JAMB_ACCESS_REQUIRED', 'Purchase the JAMB CBT pass before starting an exam'],
    ['JAMB_MAX_ATTEMPTS_REACHED', 409, 'JAMB_MAX_ATTEMPTS_REACHED', 'You have used all attempts for this exam'],
    ['JAMB_SUBJECT_SELECTION_REQUIRED', 400, 'JAMB_SUBJECT_SELECTION_REQUIRED', 'Choose the required JAMB subject combination'],
    ['JAMB_SUBJECT_SELECTION_DUPLICATE', 400, 'JAMB_SUBJECT_SELECTION_INVALID', 'A subject was selected more than once'],
    ['JAMB_SUBJECT_SELECTION_INVALID', 400, 'JAMB_SUBJECT_SELECTION_INVALID', 'The selected subject combination is not available for this mock'],
    ['JAMB_REQUIRED_SUBJECT_MISSING', 400, 'JAMB_REQUIRED_SUBJECT_MISSING', 'Include all required subjects in the mock combination'],
    ['JAMB_ELECTIVE_SUBJECT_COUNT_INVALID', 400, 'JAMB_ELECTIVE_SUBJECT_COUNT_INVALID', 'Select the required number of elective subjects'],
    ['JAMB_PRACTICE_CONFIG_INVALID', 409, 'JAMB_EXAM_CONFIGURATION_INVALID', 'This practice exam is not configured correctly'],
    ['JAMB_MOCK_CONFIG_INVALID', 409, 'JAMB_EXAM_CONFIGURATION_INVALID', 'This mock exam is not configured with Use of English as its only required subject'],
    ['JAMB_QUESTION_BANK_INCOMPLETE', 409, 'JAMB_QUESTION_BANK_INCOMPLETE', 'This exam does not yet have enough reviewed questions'],
    ['JAMB_ATTEMPT_NOT_FOUND', 404, 'JAMB_ATTEMPT_NOT_FOUND', 'Exam attempt not found'],
    ['JAMB_ATTEMPT_FORBIDDEN', 403, 'JAMB_ATTEMPT_FORBIDDEN', 'You cannot view or change another student’s attempt'],
    ['JAMB_ATTEMPT_CLOSED', 409, 'JAMB_ATTEMPT_CLOSED', 'This attempt has already been submitted or expired'],
    ['JAMB_ATTEMPT_EXPIRED', 409, 'JAMB_ATTEMPT_EXPIRED', 'The exam time has ended. Submit the attempt to view your results'],
    ['JAMB_QUESTION_NOT_IN_ATTEMPT', 400, 'JAMB_QUESTION_NOT_IN_ATTEMPT', 'The question does not belong to this attempt'],
    ['JAMB_OPTION_NOT_FOR_QUESTION', 400, 'JAMB_OPTION_NOT_FOR_QUESTION', 'That answer option does not belong to the selected question'],
    ['JAMB_ANSWERS_INVALID', 400, 'JAMB_ANSWERS_INVALID', 'Submit a valid list of saved answers'],
    ['JAMB_ANSWER_INVALID_ID', 400, 'JAMB_ANSWER_INVALID', 'An answer contains an invalid identifier'],
    ['JAMB_ATTEMPT_HAS_NO_QUESTIONS', 409, 'JAMB_ATTEMPT_EMPTY', 'This attempt has no questions to score'],
    ['JAMB_EXAM_REQUIRES_SECTIONS', 400, 'JAMB_EXAM_REQUIRES_SECTIONS', 'Add at least one subject section before publishing'],
    ['JAMB_REVIEWER_REQUIRED', 400, 'JAMB_REVIEWER_REQUIRED', 'An administrator must approve this content before publishing'],
    ['JAMB_ACCESS_COURSE_NOT_PUBLISHED', 409, 'JAMB_ACCESS_COURSE_NOT_PUBLISHED', 'Publish the paid JAMB access course after reviewing its price and content before publishing exams'],
    ['JAMB_ACCESS_BUNDLE_MISSING', 409, 'JAMB_ACCESS_BUNDLE_MISSING', 'Create the exam-access bundle before publishing JAMB exams'],
    ['JAMB_ACCESS_BUNDLE_NOT_PUBLISHED', 409, 'JAMB_ACCESS_BUNDLE_NOT_PUBLISHED', 'Publish the JAMB exam-access bundle before publishing exams'],
    ['JAMB_ACCESS_PRODUCT_REQUIRED', 400, 'JAMB_ACCESS_PRODUCT_REQUIRED', 'Attach exactly one paid course or exam-access bundle to the exam'],

    ['JAMB_PRACTICE_REQUIRES_ONE_REQUIRED_SUBJECT', 400, 'JAMB_PRACTICE_CONFIGURATION_INVALID', 'A practice exam must have exactly one required subject'],
    ['JAMB_MOCK_REQUIRES_ENGLISH_AND_ELECTIVE_SUBJECTS', 400, 'JAMB_MOCK_CONFIGURATION_INVALID', 'A mock needs required Use of English and enough elective subjects'],
    ['JAMB_QUESTION_REQUIRES_FOUR_OPTIONS_AND_ONE_ANSWER', 400, 'JAMB_QUESTION_INVALID', 'A published CBT question needs four options and exactly one correct answer'],
    ['JAMB_QUESTION_LICENSE_NOT_VERIFIED', 400, 'JAMB_QUESTION_RIGHTS_NOT_VERIFIED', 'Verify reuse permission before publishing licensed material'],
    ['JAMB_QUESTION_SYLLABUS_SUBJECT_MISMATCH', 400, 'JAMB_SYLLABUS_SUBJECT_MISMATCH', 'The question and syllabus version must have the same subject'],
    ['JAMB_SYLLABUS_SUBJECT_MISMATCH', 400, 'JAMB_SYLLABUS_SUBJECT_MISMATCH', 'The subject and syllabus version do not match'],
    ['JAMB_QUESTION_STATUS_TRANSITION_INVALID', 400, 'JAMB_STATUS_TRANSITION_INVALID', 'This question review status transition is not allowed'],
    ['JAMB_EXAM_STATUS_TRANSITION_INVALID', 400, 'JAMB_STATUS_TRANSITION_INVALID', 'This exam review status transition is not allowed'],
    ['JAMB_QUESTION_NOT_FOUND', 404, 'JAMB_QUESTION_NOT_FOUND', 'JAMB question not found'],
    ['JAMB_EXAM_NOT_FOUND', 404, 'JAMB_EXAM_NOT_FOUND', 'JAMB exam not found'],
    ['JAMB_SYLLABUS_VERSION_REQUIRED', 400, 'JAMB_SYLLABUS_VERSION_REQUIRED', 'Create the matching syllabus version before adding this material'],
    ['JAMB_SUBJECT_NOT_FOUND', 404, 'JAMB_SUBJECT_NOT_FOUND', 'JAMB subject not found'],
  ];
  for (const [needle, status, code, userMessage] of mappings) {
    if (message.includes(needle)) {
      throw new ApiError(status, code, userMessage);
    }
  }
  if (message.includes('uq_jamb_syllabus_one_current')) {
    throw ApiError.conflict('Only one current syllabus version may be set for each subject', 'JAMB_CURRENT_SYLLABUS_CONFLICT');
  }
  if (message.includes('jamb_exams_slug_key')) {
    throw ApiError.conflict('An exam with this slug already exists', 'JAMB_EXAM_SLUG_TAKEN');
  }
  if (message.includes('jamb_questions_question_key_key')) {
    throw ApiError.conflict('This question import key is already in use', 'JAMB_QUESTION_KEY_TAKEN');
  }
  if (message.includes('uq_jamb_syllabus_subject_year')) {
    throw ApiError.conflict('A syllabus version for this subject and year already exists', 'JAMB_SYLLABUS_YEAR_EXISTS');
  }
  if (message.includes('duplicate key')) throw ApiError.conflict('A record with this identifier already exists', 'DUPLICATE_RECORD');
  console.error('[jamb] database operation failed', { message });
  throw ApiError.internal(fallback, 'JAMB_OPERATION_FAILED');
}

function throwIfError(error, message) {
  if (error) mapJambError(error, message);
}

export async function listSubjects() {
  const [{ data: subjects, error: subjectError }, { data: versions, error: versionError }] = await Promise.all([
    supabaseAdmin.from('jamb_subjects')
      .select('id, code, name, description, official_source_url, is_active')
      .eq('is_active', true)
      .order('name'),
    supabaseAdmin.from('jamb_syllabus_versions')
      .select('id, subject_id, exam_year, version_label, source_url, topics, is_current')
      .eq('is_current', true)
      .order('exam_year', { ascending: false }),
  ]);
  throwIfError(subjectError, 'Unable to load JAMB subjects');
  throwIfError(versionError, 'Unable to load JAMB syllabus versions');
  return (subjects || []).map((subject) => ({
    ...subject,
    syllabus_versions: (versions || []).filter((version) => version.subject_id === subject.id),
  }));
}

export async function listAdminSubjects() {
  const { data, error } = await supabaseAdmin.from('jamb_subjects')
    .select('*').order('name');
  throwIfError(error, 'Unable to load JAMB subjects');
  return data || [];
}

export async function createSubject(input) {
  const { data, error } = await supabaseAdmin.from('jamb_subjects').insert({
    code: input.code.toUpperCase(),
    name: input.name,
    description: input.description || null,
    official_source_url: input.official_source_url,
    is_active: true,
  }).select().single();
  throwIfError(error, 'Unable to create JAMB subject');
  return data;
}

export async function updateSubject(subjectId, updates) {
  const { data, error } = await supabaseAdmin.from('jamb_subjects')
    .update(updates).eq('id', subjectId).select().maybeSingle();
  throwIfError(error, 'Unable to update JAMB subject');
  if (!data) throw ApiError.notFound('JAMB subject not found', 'JAMB_SUBJECT_NOT_FOUND');
  return data;
}

export async function listExams({ subject = null, mode = null, syllabus_year = null } = {}) {
  const bundleMode = env.jambAccessMode === 'bundle';
  const accessColumn = bundleMode ? 'access_bundle_id' : 'access_course_id';
  let query = supabaseAdmin.from('jamb_exams')
    .select(`id, slug, title, description, instructions, mode, syllabus_year, time_limit_minutes, max_attempts, mock_elective_count, ${accessColumn}, created_at`)
    .eq('status', 'PUBLISHED')
    .order('created_at', { ascending: false })
    .limit(100);
  if (mode) query = query.eq('mode', mode);
  if (syllabus_year) query = query.eq('syllabus_year', syllabus_year);
  const { data: exams, error } = await query;
  throwIfError(error, 'Unable to load JAMB exams');
  if (!exams?.length) return [];

  const examIds = exams.map((exam) => exam.id);
  const accessIds = [...new Set(exams.map((exam) => exam[accessColumn]).filter(Boolean))];
  const [{ data: sections, error: sectionError }, { data: accessProducts, error: accessError }] = await Promise.all([
    supabaseAdmin.from('jamb_exam_sections')
      .select('id, exam_id, subject_id, syllabus_version_id, question_count, is_required, order_number')
      .in('exam_id', examIds)
      .order('order_number'),
    bundleMode
      ? supabaseAdmin.from('bundles').select('id, title, price, kind, is_published').in('id', accessIds)
      : supabaseAdmin.from('courses').select('id, slug, price, duration').in('id', accessIds),
  ]);
  throwIfError(sectionError, 'Unable to load JAMB exam subjects');
  throwIfError(accessError, 'Unable to load JAMB access pricing');
  const subjectIds = [...new Set((sections || []).map((section) => section.subject_id))];
  const versionIds = [...new Set((sections || []).map((section) => section.syllabus_version_id))];
  const [{ data: subjects, error: subjectsError }, { data: versions, error: versionsError }] = await Promise.all([
    subjectIds.length ? supabaseAdmin.from('jamb_subjects').select('id, code, name').in('id', subjectIds) : { data: [], error: null },
    versionIds.length ? supabaseAdmin.from('jamb_syllabus_versions').select('id, exam_year, version_label').in('id', versionIds) : { data: [], error: null },
  ]);
  throwIfError(subjectsError, 'Unable to load JAMB subjects');
  throwIfError(versionsError, 'Unable to load JAMB syllabus versions');
  const subjectsById = Object.fromEntries((subjects || []).map((item) => [item.id, item]));
  const versionsById = Object.fromEntries((versions || []).map((item) => [item.id, item]));
  const accessById = Object.fromEntries((accessProducts || []).map((item) => [item.id, item]));
  const result = exams.map((exam) => ({
    ...exam,
    ...(bundleMode
      ? { access_bundle: accessById[exam.access_bundle_id] || null }
      : { access_course: accessById[exam.access_course_id] || null }),
    sections: (sections || [])
      .filter((section) => section.exam_id === exam.id)
      .map((section) => ({
        ...section,
        subject: subjectsById[section.subject_id] || null,
        syllabus: versionsById[section.syllabus_version_id] || null,
      })),
  }));
  if (!subject) return result;
  const normalized = subject.toUpperCase();
  return result.filter((exam) => exam.sections.some((section) => section.subject?.code === normalized));
}

export async function createSyllabusVersion(input) {
  const { data: subject, error: subjectError } = await supabaseAdmin
    .from('jamb_subjects').select('id, code, name').eq('code', input.subject_code.toUpperCase()).maybeSingle();
  throwIfError(subjectError, 'Unable to find JAMB subject');
  if (!subject) throw ApiError.notFound('JAMB subject not found', 'JAMB_SUBJECT_NOT_FOUND');

  if (input.is_current) {
    const { error } = await supabaseAdmin.from('jamb_syllabus_versions')
      .update({ is_current: false }).eq('subject_id', subject.id);
    throwIfError(error, 'Unable to update current syllabus version');
  }
  const { data, error } = await supabaseAdmin.from('jamb_syllabus_versions')
    .upsert({
      subject_id: subject.id,
      exam_year: input.exam_year,
      version_label: input.version_label,
      source_url: input.source_url,
      topics: input.topics,
      is_current: input.is_current,
    }, { onConflict: 'subject_id,exam_year' })
    .select().single();
  throwIfError(error, 'Unable to save JAMB syllabus version');
  return data;
}

export async function createExam(input, adminProfile) {
  const bundleMode = env.jambAccessMode === 'bundle';
  const accessColumn = bundleMode ? 'access_bundle_id' : 'access_course_id';
  const { data: accessProduct, error: accessError } = bundleMode
    ? await supabaseAdmin.from('bundles').select('id, title, price, kind, is_published')
      .eq('kind', 'exam_access').eq('title', env.jambAccessBundleTitle).maybeSingle()
    : await supabaseAdmin.from('courses').select('id, title, slug, price, is_published')
      .eq('slug', PAID_COURSE_SLUG).maybeSingle();
  throwIfError(accessError, 'Unable to load the JAMB paid-access product');
  if (!accessProduct) {
    throw ApiError.notFound(
      bundleMode
        ? 'Create an exam_access bundle before creating JAMB exams'
        : 'JAMB paid-access course is missing; apply the course catalogue migration first',
      bundleMode ? 'JAMB_ACCESS_BUNDLE_MISSING' : 'JAMB_ACCESS_COURSE_MISSING'
    );
  }

  const codes = [...new Set(input.sections.map((section) => section.subject_code.toUpperCase()))];
  const years = [...new Set(input.sections.map((section) => section.syllabus_year))];
  const [{ data: subjects, error: subjectsError }, { data: versions, error: versionsError }] = await Promise.all([
    supabaseAdmin.from('jamb_subjects').select('id, code').in('code', codes),
    supabaseAdmin.from('jamb_syllabus_versions').select('id, subject_id, exam_year').in('exam_year', years),
  ]);
  throwIfError(subjectsError, 'Unable to load JAMB subjects');
  throwIfError(versionsError, 'Unable to load JAMB syllabus versions');
  const subjectsByCode = Object.fromEntries((subjects || []).map((subject) => [subject.code, subject]));
  const versionsByKey = Object.fromEntries((versions || []).map((version) => [`${version.subject_id}:${version.exam_year}`, version]));

  const sections = input.sections.map((section, index) => {
    const subject = subjectsByCode[section.subject_code.toUpperCase()];
    if (!subject) throw ApiError.badRequest(`Unknown JAMB subject code: ${section.subject_code}`, 'JAMB_SUBJECT_NOT_FOUND');
    const version = versionsByKey[`${subject.id}:${section.syllabus_year}`];
    if (!version) throw ApiError.badRequest(`Create the ${section.syllabus_year} syllabus version for ${section.subject_code} first`, 'JAMB_SYLLABUS_VERSION_REQUIRED');
    return {
      subject_id: subject.id,
      syllabus_version_id: version.id,
      question_count: section.question_count,
      is_required: section.is_required,
      order_number: section.order_number || index + 1,
    };
  });

  const { data: exam, error: examError } = await supabaseAdmin.from('jamb_exams').insert({
    slug: input.slug,
    title: input.title,
    description: input.description || null,
    instructions: input.instructions || null,
    mode: input.mode,
    syllabus_year: input.syllabus_year,
    time_limit_minutes: input.time_limit_minutes,
    max_attempts: input.max_attempts ?? null,
    mock_elective_count: input.mock_elective_count,
    status: 'DRAFT',
    [accessColumn]: accessProduct.id,
    created_by: adminProfile.id,
  }).select().single();
  throwIfError(examError, 'Unable to create JAMB exam');

  const { error: sectionError } = await supabaseAdmin.from('jamb_exam_sections')
    .insert(sections.map((section) => ({ ...section, exam_id: exam.id })));
  if (sectionError) {
    await supabaseAdmin.from('jamb_exams').delete().eq('id', exam.id);
    mapJambError(sectionError, 'Unable to add JAMB exam subjects');
  }
  return {
    exam,
    sections: sections.length,
    ...(bundleMode ? { access_bundle: accessProduct } : { access_course: accessProduct }),
  };
}

const REVIEW_TRANSITIONS = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['DRAFT', 'APPROVED', 'ARCHIVED'],
  APPROVED: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['UNPUBLISHED', 'ARCHIVED'],
  UNPUBLISHED: ['IN_REVIEW', 'ARCHIVED'],
  ARCHIVED: [],
};

function assertReviewTransition(kind, previous, next) {
  if (!next || previous === next) return;
  if (!(REVIEW_TRANSITIONS[previous] || []).includes(next)) {
    throw ApiError.badRequest(`Cannot change ${kind} from ${previous} to ${next}`, `JAMB_${kind.toUpperCase()}_STATUS_TRANSITION_INVALID`);
  }
}

export async function updateExam(examId, updates, adminProfile) {
  const { data: existing, error: existingError } = await supabaseAdmin.from('jamb_exams')
    .select('id, status').eq('id', examId).maybeSingle();
  throwIfError(existingError, 'Unable to load JAMB exam');
  if (!existing) throw ApiError.notFound('JAMB exam not found', 'JAMB_EXAM_NOT_FOUND');
  assertReviewTransition('exam', existing.status, updates.status);
  const payload = { ...updates };
  if (payload.status === 'APPROVED' || payload.status === 'PUBLISHED') {
    payload.reviewed_by = adminProfile.id;
    payload.reviewed_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin.from('jamb_exams')
    .update(payload).eq('id', examId).select().maybeSingle();
  throwIfError(error, 'Unable to update JAMB exam');
  return data;
}

export async function listAdminExams() {
  const { data: exams, error } = await supabaseAdmin.from('jamb_exams')
    .select('*').order('created_at', { ascending: false });
  throwIfError(error, 'Unable to load JAMB admin exams');
  if (!exams?.length) return [];
  const examIds = exams.map((exam) => exam.id);
  const { data: sections, error: sectionError } = await supabaseAdmin.from('jamb_exam_sections')
    .select('id, exam_id, subject_id, syllabus_version_id, question_count, is_required, order_number')
    .in('exam_id', examIds).order('order_number');
  throwIfError(sectionError, 'Unable to load JAMB exam sections');
  const subjectIds = [...new Set((sections || []).map((section) => section.subject_id))];
  const versionIds = [...new Set((sections || []).map((section) => section.syllabus_version_id))];
  const [{ data: subjects, error: subjectsError }, { data: versions, error: versionsError }] = await Promise.all([
    subjectIds.length ? supabaseAdmin.from('jamb_subjects').select('id, code, name').in('id', subjectIds) : { data: [], error: null },
    versionIds.length ? supabaseAdmin.from('jamb_syllabus_versions').select('id, exam_year, version_label').in('id', versionIds) : { data: [], error: null },
  ]);
  throwIfError(subjectsError, 'Unable to load JAMB subjects');
  throwIfError(versionsError, 'Unable to load JAMB syllabus versions');
  const subjectsById = Object.fromEntries((subjects || []).map((subject) => [subject.id, subject]));
  const versionsById = Object.fromEntries((versions || []).map((version) => [version.id, version]));
  return exams.map((exam) => ({
    ...exam,
    sections: (sections || []).filter((section) => section.exam_id === exam.id).map((section) => ({
      ...section,
      subject: subjectsById[section.subject_id] || null,
      syllabus: versionsById[section.syllabus_version_id] || null,
    })),
  }));
}

export async function listAdminSyllabuses() {
  const { data, error } = await supabaseAdmin.from('jamb_syllabus_versions')
    .select('*, subject:jamb_subjects(id, code, name)')
    .order('exam_year', { ascending: false });
  throwIfError(error, 'Unable to load JAMB syllabus versions');
  return data || [];
}

export async function importQuestions(questionRows, adminProfile) {
  const subjects = [...new Set(questionRows.map((row) => row.subject_code.toUpperCase()))];
  const years = [...new Set(questionRows.map((row) => row.syllabus_year))];
  const [{ data: subjectRows, error: subjectError }, { data: versions, error: versionError }] = await Promise.all([
    supabaseAdmin.from('jamb_subjects').select('id, code').in('code', subjects),
    supabaseAdmin.from('jamb_syllabus_versions').select('id, subject_id, exam_year').in('exam_year', years),
  ]);
  throwIfError(subjectError, 'Unable to load JAMB subjects');
  throwIfError(versionError, 'Unable to load JAMB syllabus versions');
  const subjectsByCode = Object.fromEntries((subjectRows || []).map((item) => [item.code, item]));
  const versionsByKey = Object.fromEntries((versions || []).map((item) => [`${item.subject_id}:${item.exam_year}`, item]));
  const createdIds = [];
  const imported = [];

  try {
    for (const row of questionRows) {
      const subject = subjectsByCode[row.subject_code.toUpperCase()];
      if (!subject) throw ApiError.badRequest(`Unknown JAMB subject code: ${row.subject_code}`, 'JAMB_SUBJECT_NOT_FOUND');
      const version = versionsByKey[`${subject.id}:${row.syllabus_year}`];
      if (!version) throw ApiError.badRequest(`Create the ${row.syllabus_year} syllabus version for ${row.subject_code} before importing questions`, 'JAMB_SYLLABUS_VERSION_REQUIRED');

      if (row.question_key) {
        const { data: existing, error: existingError } = await supabaseAdmin.from('jamb_questions')
          .select('id').eq('question_key', row.question_key).maybeSingle();
        throwIfError(existingError, 'Unable to check the JAMB import key');
        if (existing) throw ApiError.conflict(`Question import key ${row.question_key} already exists; use a new key`, 'JAMB_QUESTION_KEY_TAKEN');
      }

      const { data: question, error: questionError } = await supabaseAdmin.from('jamb_questions').insert({
        question_key: row.question_key || null,
        subject_id: subject.id,
        syllabus_version_id: version.id,
        exam_year: row.exam_year ?? null,
        topic: row.topic || null,
        question: row.question,
        explanation: row.explanation,
        difficulty: row.difficulty,
        source_type: row.source_type,
        source_name: row.source_name || (row.source_type === 'ORIGINAL' ? 'WOLI DAN TECH HUB' : null),
        source_url: row.source_url || null,
        license_name: row.license_name || null,
        rights_verified: row.source_type === 'ORIGINAL' ? true : row.rights_verified,
        status: 'DRAFT',
        created_by: adminProfile.id,
      }).select().single();
      throwIfError(questionError, 'Unable to import JAMB question');
      createdIds.push(question.id);

      const optionRows = row.options.map((option, index) => ({
        question_id: question.id,
        option_text: option.text,
        is_correct: option.is_correct,
        order_number: index + 1,
      }));
      const { error: optionError } = await supabaseAdmin.from('jamb_question_options').insert(optionRows);
      throwIfError(optionError, 'Unable to import JAMB answer options');
      imported.push({ id: question.id, question_key: question.question_key, status: question.status });
    }
  } catch (error) {
    if (createdIds.length) await supabaseAdmin.from('jamb_questions').delete().in('id', createdIds);
    throw error;
  }
  return { imported_count: imported.length, questions: imported, status: 'DRAFT' };
}

export async function listAdminQuestions({ subject, syllabus_year, status, search, page = 1, limit = 25 } = {}) {
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  let query = supabaseAdmin.from('jamb_questions')
    .select('*, subject:jamb_subjects!inner(id, code, name), syllabus:jamb_syllabus_versions!inner(id, exam_year, version_label)', { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to);
  if (status) query = query.eq('status', status);
  if (syllabus_year) query = query.eq('jamb_syllabus_versions.exam_year', syllabus_year);
  if (subject) query = query.eq('jamb_subjects.code', subject.toUpperCase());
  if (search) query = query.ilike('question', `%${search.replace(/[%_]/g, '')}%`);
  const { data, error, count } = await query;
  throwIfError(error, 'Unable to load JAMB question bank');
  const rows = data || [];
  const ids = rows.map((row) => row.id);
  const { data: options, error: optionError } = ids.length
    ? await supabaseAdmin.from('jamb_question_options').select('*').in('question_id', ids).order('order_number')
    : { data: [], error: null };
  throwIfError(optionError, 'Unable to load JAMB answer options');
  return {
    questions: rows.map((row) => ({ ...row, options: (options || []).filter((option) => option.question_id === row.id) })),
    pagination: { page, limit, total: count || 0, total_pages: Math.ceil((count || 0) / limit) },
  };
}

export async function updateJambQuestion(questionId, updates, adminProfile) {
  const { data: existing, error: existingError } = await supabaseAdmin.from('jamb_questions')
    .select('id, status').eq('id', questionId).maybeSingle();
  throwIfError(existingError, 'Unable to load JAMB question');
  if (!existing) throw ApiError.notFound('JAMB question not found', 'JAMB_QUESTION_NOT_FOUND');
  assertReviewTransition('question', existing.status, updates.status);
  const contentFields = ['topic', 'question', 'explanation', 'difficulty', 'source_type', 'source_name', 'source_url', 'license_name', 'rights_verified'];
  const contentChanged = contentFields.some((field) => Object.hasOwn(updates, field));
  if (existing.status === 'PUBLISHED' && contentChanged) {
    throw ApiError.conflict('Unpublish this question before changing its content', 'JAMB_QUESTION_PUBLISHED_IMMUTABLE');
  }
  const payload = { ...updates };
  if (contentChanged && ['IN_REVIEW', 'APPROVED'].includes(existing.status)) {
    if (payload.status && payload.status !== 'DRAFT') {
      throw ApiError.badRequest('Content edits return a reviewed question to DRAFT before another review', 'JAMB_QUESTION_STATUS_TRANSITION_INVALID');
    }
    payload.status = 'DRAFT';
    payload.reviewed_by = null;
    payload.reviewed_at = null;
  }
  if (payload.status === 'APPROVED' || payload.status === 'PUBLISHED') {
    payload.reviewed_by = adminProfile.id;
    payload.reviewed_at = new Date().toISOString();
  }
  const { data, error } = await supabaseAdmin.from('jamb_questions')
    .update(payload).eq('id', questionId).select().maybeSingle();
  throwIfError(error, 'Unable to update JAMB question');
  return data;
}

export async function startAttempt(examId, profile, subjectCodes = null) {
  const { data, error } = await supabaseAdmin.rpc('start_jamb_exam_attempt', {
    p_exam_id: examId,
    p_student_id: profile.id,
    p_subject_codes: subjectCodes?.map((value) => value.toUpperCase()) ?? null,
  });
  throwIfError(error, 'Unable to start JAMB exam');
  return data;
}

/** Resolve the frontend's simple subject/mode/count request to a reviewed
 * server-side template, then return only a sanitized paper plus its deadline. */
export async function startPaperFromSelection(input, profile) {
  const selectedIds = input.subject_ids;
  const uniqueIds = [...new Set(selectedIds)];
  if (uniqueIds.length !== selectedIds.length) {
    throw ApiError.badRequest('Choose each subject only once', 'JAMB_SUBJECT_SELECTION_INVALID');
  }

  const mode = input.mode.toUpperCase();
  const { data: selectedSubjects, error: selectedError } = await supabaseAdmin.from('jamb_subjects')
    .select('id, code, name').in('id', uniqueIds).eq('is_active', true);
  throwIfError(selectedError, 'Unable to load the selected JAMB subjects');
  if (!selectedSubjects || selectedSubjects.length !== uniqueIds.length) {
    throw ApiError.badRequest('One or more selected subjects are unavailable', 'JAMB_SUBJECT_SELECTION_INVALID');
  }
  const selectedCodes = selectedSubjects.map((subject) => subject.code.toUpperCase());
  if (mode === 'PRACTICE' && selectedSubjects.length !== 1) {
    throw ApiError.badRequest('Choose one subject for practice mode', 'JAMB_SUBJECT_SELECTION_INVALID');
  }
  if (mode === 'MOCK' && !selectedCodes.includes('USE-OF-ENGLISH')) {
    throw ApiError.badRequest('A JAMB mock must include Use of English', 'JAMB_REQUIRED_SUBJECT_MISSING');
  }

  const { data: exams, error: examError } = await supabaseAdmin.from('jamb_exams')
    .select('id, title, mode, syllabus_year, time_limit_minutes, mock_elective_count, created_at')
    .eq('status', 'PUBLISHED').eq('mode', mode)
    .order('created_at', { ascending: false }).limit(100);
  throwIfError(examError, 'Unable to load available JAMB exam templates');
  if (!exams?.length) {
    throw ApiError.conflict('No published paper template is available for this selection yet', 'JAMB_PAPER_TEMPLATE_UNAVAILABLE');
  }

  const examIds = exams.map((exam) => exam.id);
  const { data: sections, error: sectionError } = await supabaseAdmin.from('jamb_exam_sections')
    .select('exam_id, subject_id, question_count, is_required, order_number')
    .in('exam_id', examIds).order('order_number');
  throwIfError(sectionError, 'Unable to load JAMB exam sections');
  const allSubjectIds = [...new Set((sections || []).map((section) => section.subject_id))];
  const { data: allSubjects, error: allSubjectsError } = allSubjectIds.length
    ? await supabaseAdmin.from('jamb_subjects').select('id, code, name').in('id', allSubjectIds)
    : { data: [], error: null };
  throwIfError(allSubjectsError, 'Unable to load JAMB exam subjects');
  const matchingExam = findJambPaperTemplate({
    exams,
    sections,
    subjects: allSubjects || [],
    selectedIds: uniqueIds,
    selectedCount: selectedSubjects.length,
    mode,
    questionCount: input.question_count,
  });

  if (!matchingExam) {
    throw ApiError.conflict(
      'No reviewed paper matches those subjects and question count. Choose an available combination or contact the school.',
      'JAMB_PAPER_TEMPLATE_UNAVAILABLE'
    );
  }

  const metadata = await startAttempt(matchingExam.id, profile, selectedCodes);
  const details = await getAttempt(metadata.attempt_id, profile);
  const subjectNames = [...new Set(details.questions.map((question) => question.subject?.name).filter(Boolean))];
  return {
    id: metadata.attempt_id,
    attempt_id: metadata.attempt_id,
    title: details.exam.title,
    mode: details.exam.mode.toLowerCase(),
    subjects: subjectNames,
    questions: details.questions.map((question) => ({
      id: question.attempt_item_id,
      subject: question.subject?.name || null,
      text: question.question,
      options: question.options.map(({ id, text }) => ({ id, text })),
    })),
    duration_minutes: details.exam.time_limit_minutes,
    expires_at: metadata.expires_at,
    total_questions: metadata.total_questions,
  };
}

async function loadOwnedAttempt(attemptId, profile) {
  const { data: attempt, error } = await supabaseAdmin.from('jamb_exam_attempts')
    .select('*').eq('id', attemptId).maybeSingle();
  throwIfError(error, 'Unable to load JAMB attempt');
  if (!attempt) throw ApiError.notFound('JAMB attempt not found', 'JAMB_ATTEMPT_NOT_FOUND');
  if (attempt.student_id !== profile.id && profile.role !== 'admin') {
    throw ApiError.forbidden('You cannot view or change another student’s attempt', 'JAMB_ATTEMPT_FORBIDDEN');
  }
  return attempt;
}

export async function getAttempt(attemptId, profile) {
  let attempt = await loadOwnedAttempt(attemptId, profile);
  if (attempt.status === 'IN_PROGRESS' && new Date(attempt.expires_at).getTime() <= Date.now()) {
    await submitAttempt(attemptId, profile);
    attempt = await loadOwnedAttempt(attemptId, profile);
  }
  const [{ data: exam, error: examError }, { data: items, error: itemError }] = await Promise.all([
    supabaseAdmin.from('jamb_exams').select('id, slug, title, mode, syllabus_year, time_limit_minutes').eq('id', attempt.exam_id).single(),
    supabaseAdmin.from('jamb_exam_attempt_items')
      .select('id, subject_id, order_number, question_snapshot, options_snapshot, selected_option_id, is_correct, explanation_snapshot')
      .eq('attempt_id', attempt.id).order('order_number'),
  ]);
  throwIfError(examError, 'Unable to load JAMB exam details');
  throwIfError(itemError, 'Unable to load JAMB questions');
  const subjectIds = [...new Set((items || []).map((item) => item.subject_id))];
  const { data: subjects, error: subjectsError } = subjectIds.length
    ? await supabaseAdmin.from('jamb_subjects').select('id, code, name').in('id', subjectIds)
    : { data: [], error: null };
  throwIfError(subjectsError, 'Unable to load JAMB subjects');
  const subjectsById = Object.fromEntries((subjects || []).map((subject) => [subject.id, subject]));
  const submitted = attempt.status !== 'IN_PROGRESS';
  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      started_at: attempt.started_at,
      expires_at: attempt.expires_at,
      submitted_at: attempt.submitted_at,
      total_questions: attempt.total_questions,
      correct_count: submitted ? attempt.correct_count : null,
      score: submitted ? attempt.score : null,
      selected_subject_codes: attempt.selected_subject_codes,
    },
    exam,
    questions: (items || []).map((item) => ({
      attempt_item_id: item.id,
      order_number: item.order_number,
      subject: subjectsById[item.subject_id] || null,
      question: item.question_snapshot,
      options: item.options_snapshot,
      selected_option_id: item.selected_option_id,
      ...(submitted ? {
        is_correct: item.is_correct,
        explanation: item.explanation_snapshot,
      } : {}),
    })),
  };
}

export async function saveAnswers(attemptId, profile, answers) {
  await loadOwnedAttempt(attemptId, profile);
  const { data, error } = await supabaseAdmin.rpc('save_jamb_exam_answers', {
    p_attempt_id: attemptId,
    p_student_id: profile.id,
    p_answers: answers,
  });
  throwIfError(error, 'Unable to save exam answers');
  return data;
}

export async function submitAttempt(attemptId, profile) {
  await loadOwnedAttempt(attemptId, profile);
  const { data, error } = await supabaseAdmin.rpc('submit_jamb_exam_attempt', {
    p_attempt_id: attemptId,
    p_student_id: profile.id,
  });
  throwIfError(error, 'Unable to submit JAMB exam');
  return data;
}

/** Frontend contract: accept all selected option IDs in one request, persist
 * them server-side, grade once, and return verdicts without answer keys. */
export async function submitPaper(attemptId, profile, answers = []) {
  const attempt = await loadOwnedAttempt(attemptId, profile);
  const isOpen = attempt.status === 'IN_PROGRESS'
    && new Date(attempt.expires_at).getTime() > Date.now();
  if (isOpen && answers.length) {
    const normalized = answers.map((answer) => ({
      attempt_item_id: answer.question_id,
      option_id: answer.option_id,
    }));
    await saveAnswers(attemptId, profile, normalized);
  }

  await submitAttempt(attemptId, profile);
  const details = await getAttempt(attemptId, profile);
  return mapJambResult(details, attemptId);
}

export async function listMyAttempts(profile) {
  const { data: attempts, error } = await supabaseAdmin.from('jamb_exam_attempts')
    .select('id, exam_id, status, started_at, expires_at, submitted_at, total_questions, correct_count, score, selected_subject_codes, created_at')
    .eq('student_id', profile.id).order('created_at', { ascending: false }).limit(100);
  throwIfError(error, 'Unable to load your JAMB attempt history');
  if (!attempts?.length) return [];
  const examIds = [...new Set(attempts.map((attempt) => attempt.exam_id))];
  const { data: exams, error: examError } = await supabaseAdmin.from('jamb_exams')
    .select('id, slug, title, mode, syllabus_year').in('id', examIds);
  throwIfError(examError, 'Unable to load JAMB exam history');
  const byId = Object.fromEntries((exams || []).map((exam) => [exam.id, exam]));
  return attempts.map((attempt) => ({
    ...attempt,
    correct_count: attempt.status === 'IN_PROGRESS' ? null : attempt.correct_count,
    score: attempt.status === 'IN_PROGRESS' ? null : attempt.score,
    exam: byId[attempt.exam_id] || null,
  }));
}
