import { FIELD_REDACTED } from './memory/constants.js';
import { redactField } from './memory/redact.js';
import type { AgentState } from './types.js';
import { sanitizeWorkflowText } from './workflowRuns.js';

/**
 * The question a waiting agent asked, as the rail's ticket may show it.
 *
 * This is the one session text allowed onto the wire, so `questionText` is the only function
 * that produces it and every path (the PreToolUse hook, the live transcript, the adoption-time
 * tail walk) calls it. The text lives on the agent in memory only: no log line, ledger or
 * persisted structure receives it.
 */

/** Code points the ticket shows, ellipsis included. */
export const QUESTION_MAX_CODE_POINTS = 80;
/** Room for the redaction rules to see a whole token before the final cut. */
const QUESTION_RAW_MAX = 400;
const ELLIPSIS = '…';

/**
 * `questions[0].question` of an AskUserQuestion input, with ` (+N)` for the others. Flattened
 * and stripped of bidi and control characters, redacted (fail-closed) and only then cut, so a
 * token is never half-shown. Absent, not "", when there is nothing safe to show.
 */
export function questionText(toolInput: unknown): string | undefined {
  const questions = (toolInput as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = (questions[0] as { question?: unknown } | null | undefined)?.question;
  const flat = sanitizeWorkflowText(first, QUESTION_RAW_MAX);
  if (flat === undefined) return undefined;
  const redacted = redactField(flat, QUESTION_RAW_MAX);
  if (!redacted || redacted === FIELD_REDACTED) return undefined;
  const more = questions.length > 1 ? ` (+${questions.length - 1})` : '';
  const room = QUESTION_MAX_CODE_POINTS - Array.from(more).length;
  const points = Array.from(redacted);
  const body =
    points.length + more.length <= QUESTION_MAX_CODE_POINTS
      ? redacted
      : points.slice(0, room - 1).join('') + ELLIPSIS;
  return body + more;
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
