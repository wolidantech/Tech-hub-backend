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

// ---------------------------------------------------------------------------
// Past-question study library (student-facing browse view)
//
// These helpers shape already-published, admin-released bank rows for revision
// browsing. They are deliberately allow-list based: the returned object is built
// field by field so no bank column can leak by accident. is_correct,
// correct_option_id_snapshot, explanation, review metadata and attempt data are
// never part of this payload — the graded CBT stays the only place an answer key
// is evaluated, and it stays server-side.
// ---------------------------------------------------------------------------

/** Shape one bank row plus its display options for a student. */
export function toStudentPastQuestion(row, options = []) {
  const subject = row.subject || null;
  const syllabus = row.syllabus || null;
  return {
    id: row.id,
    subject: subject ? { id: subject.id, code: subject.code, name: subject.name } : null,
    exam_year: row.exam_year ?? null,
    syllabus_year: syllabus?.exam_year ?? null,
    syllabus_label: syllabus?.version_label ?? null,
    topic: row.topic || null,
    difficulty: row.difficulty || null,
    question: row.question,
    options: (options || [])
      .filter((option) => option.question_id === row.id)
      // Sorted here too, so display order never depends on the caller's query.
      .sort((a, b) => Number(a.order_number) - Number(b.order_number))
      .map((option) => ({
        id: option.id,
        text: option.option_text,
        order_number: option.order_number,
      })),
    source: {
      type: row.source_type || null,
      name: row.source_name || null,
      license: row.license_name || null,
    },
  };
}

/** Build the year/subject facet counts the filter UI needs. Counts come from
 * the whole matching set (not just the returned page). */
export function buildPastQuestionFacets(rows = []) {
  const byYear = new Map();
  const bySubject = new Map();
  const byTopic = new Map();

  for (const row of rows) {
    const year = row.exam_year ?? null;
    const subject = row.subject || null;
    const yearKey = year ?? 'undated';
    if (!byYear.has(yearKey)) byYear.set(yearKey, { exam_year: year, count: 0, subjects: new Map() });
    const yearEntry = byYear.get(yearKey);
    yearEntry.count += 1;
    if (subject) {
      yearEntry.subjects.set(subject.code, { code: subject.code, name: subject.name, count: (yearEntry.subjects.get(subject.code)?.count || 0) + 1 });
      bySubject.set(subject.code, {
        id: subject.id,
        code: subject.code,
        name: subject.name,
        count: (bySubject.get(subject.code)?.count || 0) + 1,
      });
    }
    if (row.topic) byTopic.set(row.topic, (byTopic.get(row.topic) || 0) + 1);
  }

  const years = [...byYear.values()]
    .map((entry) => ({
      exam_year: entry.exam_year,
      count: entry.count,
      subjects: [...entry.subjects.values()].sort((a, b) => a.code.localeCompare(b.code)),
    }))
    // Dated papers first (newest paper at the top), undated material last.
    .sort((a, b) => (b.exam_year ?? -1) - (a.exam_year ?? -1));

  return {
    years,
    subjects: [...bySubject.values()].sort((a, b) => a.code.localeCompare(b.code)),
    topics: [...byTopic.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic)),
    total: rows.length,
  };
}
