import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as http from 'http';
import * as os from 'os';

import { STATUSLINE_API_PREFIX } from '../../../../constants.js';
import type { ServerTarget } from '../../../../serverConfig.js';
import { STATUSLINE_POST_BUDGET_MS, STATUSLINE_STDIN_CAP_BYTES } from '../constants.js';
import { readServerTargets } from '../serverTargets.js';
import { createScriptDebugLog } from './scriptDebugLog.js';

/**
 * statusline-tee.js: chained in front of the user's Claude Code status line as
 * `node "<this file>" '<original command>'`. Claude Code pipes the status line
 * JSON to it on every refresh; it hands those bytes to the original command
 * and, on the side, tells the local pixelmates servers the official 5-hour
 * and weekly limits that JSON carries.
 *
 * The user's status line comes first, always:
 * - The original runs at once, with this process's env, cwd, stdout and stderr.
 *   Its output never passes through here, so ANSI colors and OSC 8 links reach
 *   Claude Code byte for byte, and its exit code (or 128 + signal) is ours.
 * - stdin is forwarded chunk by chunk as it arrives, never held back for a
 *   parse.
 * - Every POST is destroyed STATUSLINE_POST_BUDGET_MS after it was created and
 *   every failure is silent: a dead or slow server costs at most that budget,
 *   and only when the original finished sooner.
 * - Nothing is printed. The only log is the opt-in PIXELMATES_DEBUG_LOG file.
 *
 * Privacy: the body is built from scratch out of rate_limits.five_hour and
 * rate_limits.seven_day, never copied from the input, so nothing else in the
 * status line JSON (cwd, model, session, cost, transcript path) can leave.
 */

/** The provider id the server files these limits under (claudeStatuslineProvider.id). */
const PROVIDER_ID = 'claude-statusline';
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

const debug = createScriptDebugLog('STATUSLINE');

interface LimitSample {
  usedPercentage: number;
  /** Epoch seconds, forwarded as Claude Code reports it. */
  resetsAt: number;
}

function pickWindow(value: unknown): LimitSample | null {
  if (value === null || typeof value !== 'object') return null;
  const { used_percentage: used, resets_at: resets } = value as Record<string, unknown>;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets)) return null;
  return { usedPercentage: used, resetsAt: resets };
}

/** The POST body, or null when neither window is there: nothing to report. */
function limitsBody(input: unknown): string | null {
  const rateLimits =
    input !== null && typeof input === 'object'
      ? (input as Record<string, unknown>).rate_limits
      : undefined;
  const limits =
    rateLimits !== null && typeof rateLimits === 'object'
      ? (rateLimits as Record<string, unknown>)
      : {};
  const fiveHour = pickWindow(limits.five_hour);
  const sevenDay = pickWindow(limits.seven_day);
  if (fiveHour === null && sevenDay === null) return null;
  return JSON.stringify({ fiveHour, sevenDay });
}

// ── Exit bookkeeping ───────────────────────────────────────
// Exit once the original has exited, stdin is consumed and every POST has
// settled or been destroyed: a fast original waits at most the POST budget,
// a slow one hides it.

let childDone = true;
let exitCode = 0;
let stdinDone = false;
let pending = 0;

function finish(): void {
  if (childDone && stdinDone && pending === 0) process.exit(exitCode);
}

// ── The original command ───────────────────────────────────

// argv[2] verbatim: no flag parsing, so an original starting with `-` is still
// just the original. No argument = there was no status line before ours.
const original = process.argv.length > 2 ? process.argv[2] : undefined;
let child: ChildProcess | null = null;
if (original !== undefined) {
  childDone = false;
  try {
    child = spawn(original, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
  } catch {
    childDone = true;
    exitCode = 127;
  }
}
if (child) {
  const running = child;
  // Could not be started at all: report it the way a shell would, silently.
  running.on('error', () => {
    exitCode = 127;
    childDone = true;
    finish();
  });
  running.on('exit', (code, signal) => {
    exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
    childDone = true;
    finish();
  });
  // EPIPE when the original never reads its input: harmless, never fatal.
  running.stdin?.on('error', () => {});
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      running.kill(signal);
    });
  }
}

// ── Reporting the limits ───────────────────────────────────

function post(target: ServerTarget, body: string): void {
  pending++;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (outcome: string): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    debug.log(`POST-${outcome} port=${target.port}`);
    pending--;
    finish();
  };
  try {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path: `${STATUSLINE_API_PREFIX}/${PROVIDER_ID}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${target.token}`,
        },
      },
      (res) => {
        res.resume();
        settle(`done status=${res.statusCode}`);
      },
    );
    timer = setTimeout(() => {
      req.destroy();
      settle('timeout');
    }, STATUSLINE_POST_BUDGET_MS);
    req.on('error', (err) => settle(`error err=${err.message}`));
    req.end(body);
  } catch (err) {
    settle(`error err=${err instanceof Error ? err.message : String(err)}`);
  }
}

function report(body: string): void {
  const targets = readServerTargets(os.homedir(), (line) => debug.log(line));
  debug.adoptFrom(targets);
  for (const target of targets) post(target, body);
}

// ── stdin: forward everything, parse what fits ──────────────

const chunks: Buffer[] = [];
let total = 0;

process.stdin.on('data', (chunk: Buffer) => {
  total += chunk.length;
  if (total <= STATUSLINE_STDIN_CAP_BYTES) chunks.push(chunk);
  else chunks.length = 0;
  const sink = child?.stdin;
  if (sink && !sink.destroyed && !sink.writableEnded) sink.write(chunk);
});

function stdinEnded(complete: boolean): void {
  if (stdinDone) return;
  const sink = child?.stdin;
  if (sink && !sink.destroyed && !sink.writableEnded) sink.end();
  if (complete && total <= STATUSLINE_STDIN_CAP_BYTES) {
    let body: string | null = null;
    try {
      body = limitsBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      body = null; // not JSON: the original still got every byte
    }
    if (body !== null) report(body);
  }
  stdinDone = true;
  finish();
}

process.stdin.on('end', () => stdinEnded(true));
process.stdin.on('error', () => stdinEnded(false));

// A stack trace on stderr would land in the status line. Anything unexpected
// gives up on the report and still exits with the original's code.
process.on('uncaughtException', () => {
  stdinDone = true;
  pending = 0;
  finish();
});
