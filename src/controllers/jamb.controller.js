import { asyncHandler } from '../utils/errors.js';
import { logAudit } from '../services/audit.service.js';
import * as jambService from '../services/jamb.service.js';

export const listSubjects = asyncHandler(async (_req, res) => {
  const subjects = await jambService.listSubjects();
  res.json({ success: true, data: { subjects } });
});

export const listExams = asyncHandler(async (req, res) => {
  const exams = await jambService.listExams(req.validatedQuery);
  res.json({ success: true, data: { exams } });
});

export const startAttempt = asyncHandler(async (req, res) => {
  const attempt = await jambService.startAttempt(
    req.validatedParams.examId,
    req.profile,
    req.validatedBody?.subject_codes || null
  );
  res.status(201).json({ success: true, message: 'JAMB exam started', data: { attempt } });
});

export const startPaper = asyncHandler(async (req, res) => {
  const paper = await jambService.startPaperFromSelection(req.validatedBody, req.profile);
  res.status(201).json({ success: true, message: 'JAMB paper started', data: paper });
});

export const getAttempt = asyncHandler(async (req, res) => {
  const data = await jambService.getAttempt(req.validatedParams.attemptId, req.profile);
  res.json({ success: true, data });
});

export const saveAnswers = asyncHandler(async (req, res) => {
  const result = await jambService.saveAnswers(
    req.validatedParams.attemptId,
    req.profile,
    req.validatedBody.answers
  );
  res.json({ success: true, message: 'Answers saved', data: { result } });
});

export const submitAttempt = asyncHandler(async (req, res) => {
  const result = await jambService.submitPaper(
    req.validatedParams.attemptId,
    req.profile,
    req.validatedBody?.answers || []
  );
  res.json({ success: true, message: 'JAMB exam submitted', data: result });
});

export const listMyAttempts = asyncHandler(async (req, res) => {
  const attempts = await jambService.listMyAttempts(req.profile);
  res.json({ success: true, data: { attempts } });
});

/** GET /api/jamb/past-questions — released past questions for revision.
 * Requires the paid JAMB pass; answer keys are never part of the response. */
export const listPastQuestions = asyncHandler(async (req, res) => {
  const data = await jambService.listPastQuestions(req.validatedQuery, req.profile);
  res.json({ success: true, data });
});

export const adminListSubjects = asyncHandler(async (_req, res) => {
  const subjects = await jambService.listAdminSubjects();
  res.json({ success: true, data: { subjects } });
});

export const adminCreateSubject = asyncHandler(async (req, res) => {
  const subject = await jambService.createSubject(req.validatedBody);
  await logAudit({
    adminId: req.profile.id,
    action: 'JAMB_SUBJECT_CREATED',
    targetType: 'jamb_subject',
    targetId: subject.id,
    description: `Added JAMB subject ${subject.code}`,
  });
  res.status(201).json({ success: true, message: 'JAMB subject added', data: { subject } });
});

export const adminUpdateSubject = asyncHandler(async (req, res) => {
  const subject = await jambService.updateSubject(req.validatedParams.subjectId, req.validatedBody);
  await logAudit({
    adminId: req.profile.id,
    action: 'JAMB_SUBJECT_UPDATED',
    targetType: 'jamb_subject',
    targetId: subject.id,
    description: `Updated JAMB subject ${subject.code}`,
  });
  res.json({ success: true, message: 'JAMB subject updated', data: { subject } });
});

export const adminListSyllabuses = asyncHandler(async (_req, res) => {
  const syllabuses = await jambService.listAdminSyllabuses();
  res.json({ success: true, data: { syllabuses } });
});

export const adminCreateSyllabus = asyncHandler(async (req, res) => {
  const syllabus = await jambService.createSyllabusVersion(req.validatedBody);
  await logAudit({
    adminId: req.profile.id,
    action: 'JAMB_SYLLABUS_VERSION_CREATED',
    targetType: 'jamb_syllabus_version',
    targetId: syllabus.id,
    description: `Saved ${syllabus.exam_year} syllabus version`,
  });
  res.status(201).json({ success: true, message: 'Syllabus version saved', data: { syllabus } });
});

export const adminListExams = asyncHandler(async (_req, res) => {
  const exams = await jambService.listAdminExams();
  res.json({ success: true, data: { exams } });
});

export const adminCreateExam = asyncHandler(async (req, res) => {
  const result = await jambService.createExam(req.validatedBody, req.profile);
  await logAudit({
    adminId: req.profile.id,
    action: 'JAMB_EXAM_CREATED',
    targetType: 'jamb_exam',
    targetId: result.exam.id,
    description: `Created draft ${result.exam.mode.toLowerCase()} exam ${result.exam.slug}`,
  });
  res.status(201).json({ success: true, message: 'Draft JAMB exam created', data: result });
});

export const adminUpdateExam = asyncHandler(async (req, res) => {
  const exam = await jambService.updateExam(req.validatedParams.examId, req.validatedBody, req.profile);
  await logAudit({
    adminId: req.profile.id,
    action: req.validatedBody.status === 'PUBLISHED' ? 'JAMB_EXAM_PUBLISHED' : 'JAMB_EXAM_UPDATED',
    targetType: 'jamb_exam',
    targetId: exam.id,
    description: `Updated JAMB exam ${exam.slug}${req.validatedBody.status ? ` to ${req.validatedBody.status}` : ''}`,
  });
  res.json({ success: true, message: 'JAMB exam updated', data: { exam } });
});

export const adminListQuestions = asyncHandler(async (req, res) => {
  const result = await jambService.listAdminQuestions(req.validatedQuery);
  res.json({ success: true, data: result });
});

export const adminImportQuestions = asyncHandler(async (req, res) => {
  const result = await jambService.importQuestions(req.validatedBody.questions, req.profile);
  await logAudit({
    adminId: req.profile.id,
    action: 'JAMB_QUESTIONS_IMPORTED',
    targetType: 'jamb_question',
    description: `Imported ${result.imported_count} JAMB questions as DRAFT`,
  });
  res.status(201).json({ success: true, message: 'Questions imported as drafts for review', data: result });
});

export const adminUpdateQuestion = asyncHandler(async (req, res) => {
  const question = await jambService.updateJambQuestion(
    req.validatedParams.questionId,
    req.validatedBody,
    req.profile
  );
  await logAudit({
    adminId: req.profile.id,
    action: req.validatedBody.status === 'PUBLISHED' ? 'JAMB_QUESTION_PUBLISHED' : 'JAMB_QUESTION_REVIEWED',
    targetType: 'jamb_question',
    targetId: question.id,
    description: `Question review status: ${question.status}`,
  });
  res.json({ success: true, message: 'JAMB question updated', data: { question } });
});
