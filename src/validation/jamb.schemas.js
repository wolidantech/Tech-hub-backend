import { z } from 'zod';

const uuid = z.string().uuid('Invalid identifier');
const code = z.string().trim().min(2).max(60).regex(/^[A-Z0-9-]+$/i, 'Invalid subject code');
const year = z.coerce.number().int().min(2000).max(2100);

export const jambExamIdParams = z.object({ examId: uuid });
export const jambAttemptIdParams = z.object({ attemptId: uuid });
export const jambQuestionIdParams = z.object({ questionId: uuid });
export const jambSubjectIdParams = z.object({ subjectId: uuid });
export const jambExamAdminIdParams = z.object({ examId: uuid });

export const listJambExamsQuery = z.object({
  subject: code.optional(),
  mode: z.enum(['PRACTICE', 'MOCK']).optional(),
  syllabus_year: year.optional(),
});

export const startJambAttemptSchema = z.object({
  subject_codes: z.array(code).min(1).max(4).optional(),
}).default({});

// Public frontend contract: template selection is resolved server-side so the
// browser never chooses a database exam ID or question-bank row.
export const startJambPaperSchema = z.object({
  subject_ids: z.array(uuid).min(1).max(30),
  mode: z.enum(['practice', 'mock']),
  question_count: z.coerce.number().int().min(1).max(200),
});

export const submitJambPaperSchema = z.object({
  answers: z.array(z.object({
    question_id: uuid,
    option_id: uuid,
  })).max(500).default([]),
  started_at: z.string().datetime().optional(),
  submitted_at: z.string().datetime().optional(),
  mode: z.enum(['practice', 'mock']).optional(),
}).default({});

export const saveJambAnswersSchema = z.object({
  answers: z.array(z.object({
    attempt_item_id: uuid,
    option_id: uuid,
  })).min(1).max(500),
});

export const createJambSubjectSchema = z.object({
  code: code.transform((value) => value.toUpperCase()),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullish(),
  official_source_url: z.string().trim().url().max(2000).default('https://ibass.jamb.gov.ng/e-syllabus'),
});

export const updateJambSubjectSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(1000).nullish(),
  official_source_url: z.string().trim().url().max(2000).optional(),
  is_active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' });

export const createJambSyllabusVersionSchema = z.object({
  subject_code: code,
  exam_year: year,
  version_label: z.string().trim().min(3).max(120),
  source_url: z.string().trim().url().max(2000),
  topics: z.array(z.object({
    title: z.string().trim().min(2).max(300),
    subtopics: z.array(z.string().trim().min(2).max(300)).default([]),
    objectives: z.array(z.string().trim().min(2).max(500)).default([]),
  })).default([]),
  is_current: z.boolean().default(false),
});

const examSectionSchema = z.object({
  subject_code: code,
  syllabus_year: year,
  question_count: z.coerce.number().int().min(1).max(200),
  is_required: z.boolean().default(false),
  order_number: z.coerce.number().int().min(1).max(30).optional(),
});

export const createJambExamSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160),
  title: z.string().trim().min(5).max(300),
  description: z.string().trim().max(5000).nullish(),
  instructions: z.string().trim().max(10000).nullish(),
  mode: z.enum(['PRACTICE', 'MOCK']),
  syllabus_year: year,
  time_limit_minutes: z.coerce.number().int().min(1).max(360),
  max_attempts: z.coerce.number().int().positive().max(100).nullish(),
  mock_elective_count: z.coerce.number().int().min(1).max(3).default(3),
  sections: z.array(examSectionSchema).min(1).max(30),
}).superRefine((exam, ctx) => {
  const subjects = exam.sections.map((section) => section.subject_code.toUpperCase());
  if (new Set(subjects).size !== subjects.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each subject may appear only once per exam', path: ['sections'] });
  }
  const resolvedOrders = exam.sections.map((section, index) => section.order_number ?? index + 1);
  if (new Set(resolvedOrders).size !== resolvedOrders.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Section order numbers must be unique', path: ['sections'] });
  }
  exam.sections.forEach((section, index) => {
    if (section.syllabus_year !== exam.syllabus_year) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Every section must use the exam syllabus year', path: ['sections', index, 'syllabus_year'] });
    }
  });
  if (exam.mode === 'PRACTICE') {
    if (exam.sections.length !== 1 || !exam.sections[0]?.is_required) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Subject practice exams need exactly one required subject section', path: ['sections'] });
    }
  }
  if (exam.mode === 'MOCK') {
    const requiredSections = exam.sections.filter((section) => section.is_required);
    const english = requiredSections.find((section) => section.subject_code.toUpperCase() === 'USE-OF-ENGLISH');
    const electiveCount = exam.sections.filter((section) => !section.is_required).length;
    if (requiredSections.length !== 1 || !english) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A JAMB mock must require Use of English as its only required subject', path: ['sections'] });
    }
    if (electiveCount < exam.mock_elective_count) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add enough elective subjects for candidates to choose from', path: ['sections'] });
    }
  }
});

export const updateJambExamSchema = z.object({
  title: z.string().trim().min(5).max(300).optional(),
  description: z.string().trim().max(5000).nullish(),
  instructions: z.string().trim().max(10000).nullish(),
  time_limit_minutes: z.coerce.number().int().min(1).max(360).optional(),
  max_attempts: z.coerce.number().int().positive().max(100).nullish(),
  mock_elective_count: z.coerce.number().int().min(1).max(3).optional(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED']).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' });

const importedQuestionSchema = z.object({
  question_key: z.string().trim().min(3).max(200).optional(),
  subject_code: code,
  syllabus_year: year,
  exam_year: year.nullish(),
  topic: z.string().trim().max(300).nullish(),
  question: z.string().trim().min(10).max(10000),
  explanation: z.string().trim().min(10).max(10000),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).default('BEGINNER'),
  source_type: z.enum(['ORIGINAL', 'LICENSED']).default('ORIGINAL'),
  source_name: z.string().trim().min(2).max(300).optional(),
  source_url: z.string().trim().url().max(2000).optional(),
  license_name: z.string().trim().min(2).max(300).optional(),
  rights_verified: z.boolean().default(false),
  options: z.array(z.object({
    text: z.string().trim().min(1).max(3000),
    is_correct: z.boolean().default(false),
  })).length(4),
}).superRefine((question, ctx) => {
  if (question.options.filter((option) => option.is_correct).length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Exactly one of the four options must be correct', path: ['options'] });
  }
  if (question.source_type === 'LICENSED') {
    if (!question.source_name) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'source_name is required for licensed content', path: ['source_name'] });
    if (!question.source_url) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'source_url is required for licensed content', path: ['source_url'] });
    if (!question.license_name) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'license_name is required for licensed content', path: ['license_name'] });
  }
});

export const importJambQuestionsSchema = z.object({
  questions: z.array(importedQuestionSchema).min(1).max(100),
});

export const updateJambQuestionSchema = z.object({
  topic: z.string().trim().max(300).nullish(),
  question: z.string().trim().min(10).max(10000).optional(),
  explanation: z.string().trim().min(10).max(10000).optional(),
  difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).optional(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED']).optional(),
  source_type: z.enum(['ORIGINAL', 'LICENSED']).optional(),
  source_name: z.string().trim().min(2).max(300).nullish(),
  source_url: z.string().trim().url().max(2000).nullish(),
  license_name: z.string().trim().min(2).max(300).nullish(),
  rights_verified: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update' });

export const listJambQuestionsQuery = z.object({
  subject: code.optional(),
  syllabus_year: year.optional(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED']).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
