import assert from 'node:assert/strict';
import { findJambPaperTemplate, mapJambResult } from '../src/services/jamb-template.js';
import {
  createJambExamSchema,
  createJambSubjectSchema,
  importJambQuestionsSchema,
  startJambAttemptSchema,
  startJambPaperSchema,
  submitJambPaperSchema,
  updateJambExamSchema,
  updateJambQuestionSchema,
} from '../src/validation/jamb.schemas.js';

assert.equal(createJambSubjectSchema.safeParse({ code: 'computer-studies', name: 'Computer Studies' }).data?.code, 'COMPUTER-STUDIES');
assert.equal(createJambSubjectSchema.safeParse({ code: 'not a code', name: 'Invalid' }).success, false);

const baseSection = { syllabus_year: 2026, question_count: 40 };
const mock = {
  slug: 'utme-mock-2026',
  title: 'UTME Full Mock 2026',
  mode: 'MOCK',
  syllabus_year: 2026,
  time_limit_minutes: 180,
  mock_elective_count: 3,
  sections: [
    { ...baseSection, subject_code: 'USE-OF-ENGLISH', is_required: true },
    { ...baseSection, subject_code: 'BIOLOGY' },
    { ...baseSection, subject_code: 'CHEMISTRY' },
    { ...baseSection, subject_code: 'MATHEMATICS' },
    { ...baseSection, subject_code: 'PHYSICS' },
  ],
};

assert.equal(createJambExamSchema.safeParse(mock).success, true, 'a mock with English and at least three electives is valid');
assert.equal(
  createJambExamSchema.safeParse({
    ...mock,
    sections: mock.sections.filter((section) => section.subject_code !== 'USE-OF-ENGLISH'),
  }).success,
  false,
  'a mock without required Use of English is rejected'
);
assert.equal(
  createJambExamSchema.safeParse({
    ...mock,
    sections: mock.sections.map((section) => section.subject_code === 'BIOLOGY' ? { ...section, is_required: true } : section),
  }).success,
  false,
  'a mock cannot configure an elective as a second required subject'
);

const practice = {
  slug: 'biology-practice-2026',
  title: 'Biology Practice 2026',
  mode: 'PRACTICE',
  syllabus_year: 2026,
  time_limit_minutes: 45,
  sections: [{ ...baseSection, subject_code: 'BIOLOGY', is_required: true }],
};
assert.equal(createJambExamSchema.safeParse(practice).success, true, 'a single-subject practice exam is valid');
assert.equal(startJambAttemptSchema.safeParse(undefined).success, true, 'legacy template attempts may omit a request body');
assert.equal(startJambAttemptSchema.safeParse({ subject_codes: ['USE-OF-ENGLISH', 'BIOLOGY', 'CHEMISTRY', 'MATHEMATICS'] }).success, true);
assert.equal(startJambAttemptSchema.safeParse({ subject_codes: ['A', 'B', 'C', 'D', 'E'] }).success, false);
const frontendStart = {
  subject_ids: ['11111111-1111-4111-8111-111111111111'],
  mode: 'practice',
  question_count: 20,
};
assert.equal(startJambPaperSchema.safeParse(frontendStart).success, true, 'frontend start contract accepts subject IDs, mode and paper length');
assert.equal(startJambPaperSchema.safeParse({ ...frontendStart, mode: 'exam' }).success, false, 'unknown modes are rejected');
assert.equal(startJambPaperSchema.safeParse({ ...frontendStart, question_count: 0 }).success, false, 'empty papers are rejected');
assert.equal(submitJambPaperSchema.safeParse({
  answers: [{ question_id: '22222222-2222-4222-8222-222222222222', option_id: '33333333-3333-4333-8333-333333333333' }],
  started_at: '2026-10-05T10:00:00.000Z',
  submitted_at: '2026-10-05T10:05:00.000Z',
  mode: 'practice',
}).success, true, 'frontend submit payload accepts only chosen option IDs');
assert.equal(submitJambPaperSchema.safeParse({ answers: [{ question_id: 'bad', option_id: 'bad' }] }).success, false);
assert.equal(updateJambExamSchema.safeParse({}).success, false, 'empty exam updates are rejected');
assert.equal(updateJambQuestionSchema.safeParse({}).success, false, 'empty question updates are rejected');

const question = {
  subject_code: 'BIOLOGY',
  syllabus_year: 2026,
  question: 'Which structure stores hereditary information in a eukaryotic cell?',
  explanation: 'In eukaryotic cells, most hereditary information is stored in DNA inside the nucleus.',
  source_type: 'ORIGINAL',
  options: [
    { text: 'Nucleus', is_correct: true },
    { text: 'Ribosome' },
    { text: 'Golgi apparatus' },
    { text: 'Cell wall' },
  ],
};
assert.equal(importJambQuestionsSchema.safeParse({ questions: [question] }).success, true, 'four-option original question is valid');
assert.equal(
  importJambQuestionsSchema.safeParse({ questions: [{ ...question, options: question.options.map((option) => ({ ...option, is_correct: true })) }] }).success,
  false,
  'multiple correct answers are rejected'
);
assert.equal(
  importJambQuestionsSchema.safeParse({ questions: [{ ...question, source_type: 'LICENSED' }] }).success,
  false,
  'licensed material requires source and license details'
);
assert.equal(
  importJambQuestionsSchema.safeParse({ questions: [{
    ...question,
    source_type: 'LICENSED',
    source_name: 'Publisher',
    source_url: 'https://example.org/source',
    license_name: 'Written permission',
    rights_verified: false,
  }] }).success,
  true,
  'licensed items may be imported as drafts before rights verification, but cannot be published by the database guard'
);

const templateSubjects = [
  { id: 'english', code: 'USE-OF-ENGLISH' },
  { id: 'biology', code: 'BIOLOGY' },
  { id: 'chemistry', code: 'CHEMISTRY' },
  { id: 'math', code: 'MATHEMATICS' },
  { id: 'physics', code: 'PHYSICS' },
];
const templateExam = { id: 'mock-template', mode: 'MOCK', mock_elective_count: 3 };
const templateSections = templateSubjects.map((subject, index) => ({
  exam_id: templateExam.id,
  subject_id: subject.id,
  question_count: 15,
  is_required: index === 0,
}));
const selectedMockIds = ['english', 'biology', 'chemistry', 'math'];
assert.equal(findJambPaperTemplate({
  exams: [templateExam], sections: templateSections, subjects: templateSubjects,
  selectedIds: selectedMockIds, selectedCount: 4, mode: 'MOCK', questionCount: 60,
}), templateExam, 'mock template resolution enforces English plus configured electives and paper length');
assert.equal(findJambPaperTemplate({
  exams: [templateExam], sections: templateSections, subjects: templateSubjects,
  selectedIds: ['biology', 'chemistry', 'math', 'physics'], selectedCount: 4, mode: 'MOCK', questionCount: 60,
}), undefined, 'mock template resolution rejects a combination without required English');
assert.equal(findJambPaperTemplate({
  exams: [templateExam], sections: templateSections, subjects: templateSubjects,
  selectedIds: selectedMockIds, selectedCount: 4, mode: 'MOCK', questionCount: 50,
}), undefined, 'mock template resolution rejects a mismatched paper length');
const practiceExam = { id: 'biology-practice', mode: 'PRACTICE', mock_elective_count: 3 };
assert.equal(findJambPaperTemplate({
  exams: [practiceExam],
  sections: [{ exam_id: practiceExam.id, subject_id: 'biology', question_count: 20, is_required: true }],
  subjects: templateSubjects, selectedIds: ['biology'], selectedCount: 1, mode: 'PRACTICE', questionCount: 20,
}), practiceExam, 'practice template resolution permits exactly one configured subject');
const frontendResult = mapJambResult({
  exam: { mode: 'PRACTICE' },
  attempt: { total_questions: 2, correct_count: 1, score: 50, submitted_at: '2026-10-05T12:00:00.000Z' },
  questions: [
    { attempt_item_id: 'item-1', subject: { name: 'Biology' }, is_correct: false, explanation: 'Review this concept.', correct_option_id: 'must-not-leak' },
    { attempt_item_id: 'item-2', subject: { name: 'Biology' }, is_correct: true, explanation: '', correct_option_id: 'must-not-leak' },
  ],
}, 'attempt-1');
assert.equal(frontendResult.score, 1, 'frontend result score is the number correct, not a percentage');
assert.equal(frontendResult.total, 2);
assert.equal(frontendResult.passed, true);
assert.equal(frontendResult.per_question[0].correct, false);
assert.equal(JSON.stringify(frontendResult).includes('must-not-leak'), false, 'review result omits answer-key option IDs');

console.log('✓ JAMB exam, frontend contract, template resolution and import validation checks passed');
