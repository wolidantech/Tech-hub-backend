/**
 * Academic-integrity guard — enforced SERVER-SIDE.
 *
 * The frontend has its own check, but a client-side check can be bypassed by
 * calling the API directly, so the authoritative refusal lives here and runs
 * before any model call (which also saves tokens).
 *
 * This is a deterministic filter, not a security boundary on its own: the
 * chat system prompt carries the same rules, and both must hold.
 */
import { DANTECH_NAME } from './config.js';

/**
 * STRONG requests: an explicit demand that assessed work be completed.
 * These are refused unconditionally — no wording can talk around them.
 */
const STRONG_PATTERNS = [
  // "do/write/complete/finish/solve my|the|this assignment|homework|essay|project|quiz|exam"
  /\b(?:do|write|complete|finish|solve|draft)\b[^.?!]{0,30}\b(?:my|the|this|our|an?)\b[^.?!]{0,20}\b(?:assignment|homework|essay|project|quiz|exam|test|assessment|final\s+project)\b/i,
  // "give me the answer(s)", "tell me the correct answer"
  /\b(?:give|tell|send|show|reveal|provide)\b[^.?!]{0,20}\b(?:me|us)\b[^.?!]{0,20}\b(?:the\s+)?(?:correct\s+)?(?:right\s+)?answers?\b/i,
  // "quiz answers", "answer key", "answers to question 3"
  /\b(?:quiz|exam|test|assignment|paper)\s+answers?\b/i,
  /\banswer\s+(?:key|sheet)\b/i,
  /\banswers?\s+(?:to|for)\s+(?:the\s+)?(?:quiz|exam|test|question|questions|assignment)\b/i,
];

/**
 * WEAK requests: ambiguous phrasing that might be a completion demand.
 * Refused unless the message is clearly asking to be taught.
 */
const WEAK_PATTERNS = [
  /\b(?:do|write|complete|finish)\s+(?:it|them|this|that|the\s+work)\s+for\s+me\b/i,
  /\bfor\s+me\s*(?:please)?\s*[.?!]?\s*$/i,
];

/** Clearly-educational phrasing — only rescues a WEAK match. */
const SAFE_PATTERNS = [
  /\bexplain\b/i,
  /\bwhat\s+(?:is|are|does|do)\b/i,
  /\bhow\s+(?:do|does|can|should)\b/i,
  /\bcheck\s+my\b/i,
  /\breview\s+my\b/i,
  /\bfeedback\b/i,
  /\bhint\b/i,
  /\bexample\b/i,
  /\bdebug\b/i,
  /\bwhy\s+is\b/i,
  /\bsummar/i,
  /\btest\s+me\b/i,
  /\bquiz\s+me\b/i,
  /\bpractice\b/i,
  /\bflashcards?\b/i,
  /\bnotes\b/i,
];

/**
 * @returns {string|null} the refusal message when the request asks for
 * assessed work to be completed, otherwise null.
 */
export function checkIntegrity(message) {
  const text = String(message || '').trim();
  if (!text) return null;

  if (STRONG_PATTERNS.some((re) => re.test(text))) return refusalMessage();

  if (WEAK_PATTERNS.some((re) => re.test(text)) && !SAFE_PATTERNS.some((re) => re.test(text))) {
    return refusalMessage();
  }

  return null;
}

export function refusalMessage() {
  return [
    `I can't complete assessed work *for* you — that's the one thing ${DANTECH_NAME} won't do, because the skill has to end up in **your** hands. 💪`,
    '',
    'Here is how I *can* help you finish it strong:',
    '',
    '- **Break it down** — I will turn the task into small, doable steps.',
    '- **Explain the concept** — tell me the part that feels fuzzy.',
    '- **Worked example** — I will solve a *different* problem so you can see the method.',
    '- **Review your attempt** — paste what you have and I will give feedback.',
    '- **Test you** — I can quiz you until it clicks.',
    '',
    'Which part are you stuck on? Start there and we will work through it together.',
  ].join('\n');
}

export default checkIntegrity;
