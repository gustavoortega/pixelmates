import { FIELD_REDACTED } from './memory/constants.js';
import { redactField } from './memory/redact.js';
import type { AgentState } from './types.js';
import { sanitizeWorkflowText } from './workflowRuns.js';

/**
 * The question a waiting agent asked, as the clients show it.
 *
 * This is the one session text allowed onto the wire, so `questionText` is the only function
 * that produces it and every path (the PreToolUse hook, the live transcript, the adoption-time
 * tail walk) calls it. The text lives on the agent in memory only: no log line, ledger or
 * persisted structure receives it.
 */

/** Code points of the question the clients show, ellipsis included. */
export const QUESTION_MAX_CODE_POINTS = 300;
/** Room for the redaction rules to see a whole token before the final cut. */
const QUESTION_RAW_MAX = 1200;
const ELLIPSIS = '…';

/**
 * The shared core of every question text: flattened and stripped of bidi and control
 * characters, redacted (fail-closed) and only then cut, so a token is never half-shown.
 * `more` is the ` (+N)` suffix for the other questions. Absent, not "", when there is nothing
 * safe to show.
 */
export function cleanSessionQuestion(raw: unknown, more = ''): string | undefined {
  const flat = sanitizeWorkflowText(raw, QUESTION_RAW_MAX);
  if (flat === undefined) return undefined;
  const redacted = redactField(flat, QUESTION_RAW_MAX);
  if (!redacted || redacted === FIELD_REDACTED) return undefined;
  const room = QUESTION_MAX_CODE_POINTS - Array.from(more).length;
  const points = Array.from(redacted);
  const body =
    points.length + more.length <= QUESTION_MAX_CODE_POINTS
      ? redacted
      : points.slice(0, room - 1).join('') + ELLIPSIS;
  return body + more;
}

/** `questions[0].question` of an AskUserQuestion input, with ` (+N)` for the others. */
export function questionText(toolInput: unknown): string | undefined {
  const questions = (toolInput as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = (questions[0] as { question?: unknown } | null | undefined)?.question;
  const more = questions.length > 1 ? ` (+${questions.length - 1})` : '';
  return cleanSessionQuestion(first, more);
}

/** Only the end of a long final message can hold the question; also bounds every scan below. */
const TRAILING_WINDOW = 4096;
const SENTENCE_END = new Set(['.', '!', '?', ':', ';', '。', '！', '？']);
const QUESTION_MARKS = new Set(['?', '？']);
const CLOSERS = new Set([')', ']', '"', "'", '”', '’', '*', '_', '`']);
const OPENERS = new Set(['(', '[', '"', "'", '“', '‘']);

function isSpace(ch: string): boolean {
  return ch.trim() === '';
}

/** Drops one leading list or quote marker ("- ", "> ", "1. ", "2) "); undefined when none. */
function withoutMarker(line: string): string | undefined {
  const first = line[0];
  if (first === '-' || first === '*' || first === '+' || first === '>') {
    return line.length > 1 && isSpace(line[1]) ? line.slice(2).trimStart() : undefined;
  }
  let i = 0;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i === 0 || i >= line.length - 1) return undefined;
  if ((line[i] === '.' || line[i] === ')') && isSpace(line[i + 1])) {
    return line.slice(i + 2).trimStart();
  }
  return undefined;
}

/** A line as a question: markers and closers off its ends, ending in a question mark. */
function questionLine(raw: string): string | undefined {
  let line = raw.trim();
  for (let again = true; again;) {
    const rest = withoutMarker(line);
    again = rest !== undefined;
    if (rest !== undefined) line = rest;
  }
  let begin = 0;
  while (line.startsWith('**', begin) || line.startsWith('__', begin)) begin += 2;
  let end = line.length;
  while (end > 0 && (CLOSERS.has(line[end - 1]) || isSpace(line[end - 1]))) end--;
  if (end <= begin || !QUESTION_MARKS.has(line[end - 1])) return undefined;
  return line.slice(begin, end);
}

/**
 * Whether the turn's final message ends on a question to the user, and the question's words.
 * Linear scans only: this is session text. `text` is absent when redaction fails closed, so the
 * ticket falls back to its generic line. Returns undefined for a message that does not end on
 * one. Several trailing questions in the last paragraph show the last, with ` (+N)`.
 */
export function trailingQuestion(finalText: string): { text: string | undefined } | undefined {
  const lines = finalText.slice(-TRAILING_WINDOW).split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last < 0) return undefined;
  const question = questionLine(lines[last]);
  if (question === undefined) return undefined;

  let others = 0;
  for (let i = last - 1; i >= 0 && lines[i].trim() !== ''; i--) {
    if (questionLine(lines[i]) !== undefined) others++;
  }

  // The question starts after the last sentence end that is followed by a space and sits
  // before the final mark: "Merged. Ship it now?" asks "Ship it now?", "1.0.5?" stays whole.
  let start = 0;
  for (let i = question.length - 2; i >= 0; i--) {
    if (SENTENCE_END.has(question[i]) && isSpace(question[i + 1])) {
      start = i + 1;
      break;
    }
  }
  let from = start;
  while (from < question.length && (isSpace(question[from]) || OPENERS.has(question[from]))) from++;
  const sentence = question.slice(from);
  if (sentence.length === 1) return undefined;
  return { text: cleanSessionQuestion(sentence, others > 0 ? ` (+${others})` : '') };
}

/** The agent is stopped on a question. `text` undefined: the ticket falls back to its generic line. */
export function setAwaitingQuestion(agent: AgentState, text: string | undefined): void {
  agent.isWaiting = true;
  agent.awaitingInput = true;
  agent.awaitingReason = 'question';
  agent.question = text;
}

/** Whether a question is pending. An idle wait is not one. */
export function hasPendingQuestion(agent: AgentState): boolean {
  return agent.awaitingInput === true && agent.awaitingReason === 'question';
}

/** The agent no longer awaits anything: drops the flag, the reason and the text together. */
export function clearAwaiting(agent: AgentState): void {
  agent.awaitingInput = false;
  agent.awaitingReason = undefined;
  agent.question = undefined;
}
