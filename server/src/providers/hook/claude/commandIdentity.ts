import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { STATUSLINE_TEE_SCRIPT_NAME, UPSTREAM_TEE_PATH_SUFFIX } from './constants.js';

/**
 * Reading which script a ~/.claude/settings.json command runs. Shared by the hook identity (claudeHookInstaller.ts)
 * and the status line wrapper (claudeStatuslineInstaller.ts). It is a leaf on purpose: the hook installer's backup
 * rule has to recognise our status line, and the status line installer writes through the hook installer, so the
 * parsing they both need cannot live in either of them without an import cycle.
 */

/** Characters that end a path token in a shell command line. A path we own is
 *  either the whole token or ends at one of these; anything else after it
 *  (`.backup`, `.disabled`, more path segments) means the command names a
 *  DIFFERENT file that merely starts with our path. */
const PATH_TERMINATORS = new Set([' ', '\t', '"', "'", ';', '&', '|', '>', '<', ')']);

/** `node <args>`, the interpreter optionally a (quoted) path. Single-line on
 *  purpose: a hook command whose arguments span lines has never matched the
 *  hook rule, and must not start to. */
const NODE_INVOCATION = /^"?(?:[^"]*[/\\])?node(?:\.exe)?"?\s+(.+)$/;
/** The same across lines: a wrapped status line carries the user's original
 *  command verbatim, newlines included. */
const NODE_INVOCATION_MULTILINE = /^"?(?:[^"]*[/\\])?node(?:\.exe)?"?\s+([\s\S]+)$/;

/** Read one shell token: a quoted string, or characters up to the first
 *  terminator. Returns the token and how many characters it spans, or null
 *  when the token is empty or unterminated. */
function readToken(raw: string): { token: string; length: number } | null {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    return end > 1 ? { token: raw.slice(1, end), length: end + 1 } : null;
  }
  let end = 0;
  while (end < raw.length && !PATH_TERMINATORS.has(raw[end])) end++;
  return end > 0 ? { token: raw.slice(0, end), length: end } : null;
}

/**
 * The ABSOLUTE path of the script a command runs, normalized to forward
 * slashes, plus everything after it; null when the command doesn't look like
 * one of ours.
 *
 * `node "<path>"` and a bare `<path>` are the two shapes we write (and the two
 * a user plausibly hand-edits). A Windows drive prefix (`C:/…`) counts as
 * absolute; a relative path does not (see isOurHookCommand's contract).
 * `multiline` is only for the status line wrapper, whose argument may span
 * lines; the hook rule keeps reading a multi-line `node` command as foreign.
 */
export function splitScriptCommand(
  command: string,
  multiline = false,
): { script: string; rest: string } | null {
  const trimmed = command.trim();
  // `node <script>` / `node "<script>"`: take the argument. The interpreter
  // itself may be a path (quoted, and on Windows containing spaces).
  const nodeInvocation = (multiline ? NODE_INVOCATION_MULTILINE : NODE_INVOCATION).exec(trimmed);
  const raw = (nodeInvocation ? nodeInvocation[1] : trimmed).trim();
  const read = readToken(raw);
  if (read === null) return null;
  const normalized = read.token.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
  return absolute ? { script: normalized, rest: raw.slice(read.length) } : null;
}

// ── The status line wrapper ─────────────────────────────────

/** `/.pixelmates/hooks/statusline-tee.js`. Anchored like the hook script's
 *  suffix: the leading separator keeps `/opt/evil.pixelmates/...` out. */
const TEE_PATH_SUFFIX = `/${HOOK_SCRIPTS_DIR}/${STATUSLINE_TEE_SCRIPT_NAME}`;

/** One sh word built only from single-quoted runs joined by `'\''`, which is
 *  exactly what shQuote writes. Anything looser (a second word, an unquoted
 *  tail, a redirect) is a command someone else wrote around ours. */
const SINGLE_QUOTED_WORD = /^'((?:[^']|'\\'')*)'$/;

/** Where the wrapper is copied: ~/.pixelmates/hooks/statusline-tee.js. */
export function statuslineTeePath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, STATUSLINE_TEE_SCRIPT_NAME);
}

/** sh single quotes interpret nothing, so the only character to escape is the
 *  quote itself: close, emit an escaped quote, reopen. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The statusLine.command we write: the wrapper, then the user's original as
 *  its single argument (none when there was no status line). The original
 *  stays readable inside the command, which is also where uninstall reads it
 *  back from. */
export function makeStatuslineCommand(teePath: string, original: string | null): string {
  const tee = `node "${teePath}"`;
  return original === null ? tee : `${tee} ${shQuote(original)}`;
}

/** What install writes when there was no statusLine at all. The backup rule
 *  compares against this writer rather than a second description of it. */
export function makeTeeOnlyStatusLine(teePath: string): { type: 'command'; command: string } {
  return { type: 'command', command: makeStatuslineCommand(teePath, null) };
}

/**
 * Whether a statusLine command is our wrapper, and the original it wraps.
 *
 * Identity is the hook rule (the script `node` runs, absolute, its case-folded
 * path ending in `/.pixelmates/hooks/statusline-tee.js`) plus the argument:
 * nothing at all (original null), or exactly one single-quoted word. Anything
 * else returns null, "not ours": uninstall then leaves it alone instead of
 * writing back an original it could only guess at.
 */
export function parseStatuslineCommand(command: string): { original: string | null } | null {
  return parseWrapperCommand(command, TEE_PATH_SUFFIX);
}

/** The same rule for upstream Pixel Agents' wrapper (`/.pixel-agents/hooks/statusline-tee.js`): it writes the same
 *  grammar, so its original can be read back out. It is never ours; install unwraps it only on `replaceLegacy`. */
export function parseUpstreamStatuslineCommand(
  command: string,
): { original: string | null } | null {
  return parseWrapperCommand(command, UPSTREAM_TEE_PATH_SUFFIX);
}

function parseWrapperCommand(command: string, suffix: string): { original: string | null } | null {
  const parts = splitScriptCommand(command, true);
  if (!parts || !parts.script.toLowerCase().endsWith(suffix)) return null;
  if (parts.rest === '') return { original: null };
  // Glued to the path (`...tee.js'x'`), sh reads one longer word: a different file.
  if (!/^\s/.test(parts.rest)) return null;
  const word = SINGLE_QUOTED_WORD.exec(parts.rest.trim());
  return word ? { original: word[1].replace(/'\\''/g, "'") } : null;
}
