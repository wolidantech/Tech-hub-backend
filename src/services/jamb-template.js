/** Select an already-reviewed exam template for the frontend's simple
 * subject/mode/count request. This pure helper never touches database state. */
export function mapJambResult(details, attemptId) {
  const total = Number(details.attempt.total_questions || details.questions.length);
  const correct = Number(details.attempt.correct_count || 0);
  const percent = Number(details.attempt.score || 0);
  return {
    attempt_id: attemptId,
    mode: details.exam.mode.toLowerCase(),
    score: correct,
    total,
    score_percent: percent,
    pass_mark: 50,
    passed: percent >= 50,
    graded_at: details.attempt.submitted_at,
    per_question: details.questions.map((question) => ({
      question_id: question.attempt_item_id,
      subject: question.subject?.name || null,
      correct: question.is_correct === true,
      explanation: question.explanation || '',
    })),
  };
}

export function findJambPaperTemplate({ exams, sections, subjects, selectedIds, selectedCount, mode, questionCount }) {
  const subjectsById = Object.fromEntries((subjects || []).map((subject) => [subject.id, subject]));
  const selectedSet = new Set(selectedIds);

  return (exams || []).find((exam) => {
    const examSections = (sections || []).filter((section) => section.exam_id === exam.id);
    const selectedSections = examSections.filter((section) => selectedSet.has(section.subject_id));
    if (selectedSections.length !== selectedCount) return false;
    if (selectedSections.reduce((sum, section) => sum + Number(section.question_count), 0) !== questionCount) return false;

    if (mode === 'PRACTICE') {
      return examSections.length === 1
        && examSections[0].is_required
        && selectedSections[0]?.subject_id === selectedIds[0];
    }

    const required = examSections.filter((section) => section.is_required);
    const hasRequiredInSelection = required.every((section) => selectedSet.has(section.subject_id));
    const englishRequired = required.length === 1
      && subjectsById[required[0]?.subject_id]?.code === 'USE-OF-ENGLISH'
      && selectedSet.has(required[0].subject_id);
    return englishRequired
      && hasRequiredInSelection
      && selectedCount - required.length === Number(exam.mock_elective_count);
  });
}
