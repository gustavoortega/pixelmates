import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { SessionLiveness } from '../../../../../core/src/provider.js';
import { HEALTH_PS_TIMEOUT_MS } from '../../../constants.js';

/** Claude Code writes one `<pid>.json` per running session here, `{ pid, sessionId, ... }`.
 *  A clean exit removes it; a killed or crashed process leaves it behind. */
function sessionsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'sessions');
}

/** sessionId -> pids, from every session file that parses. One session can have several
 *  (a resume starts a new process under the same id). */
function readSessionPids(): Map<string, number[]> {
  const bySession = new Map<string, number[]>();
  const dir = sessionsDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return bySession;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as {
        pid?: unknown;
        sessionId?: unknown;
      };
      const pid = data.pid;
      if (typeof data.sessionId !== 'string' || typeof pid !== 'number') continue;
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const pids = bySession.get(data.sessionId) ?? [];
      pids.push(pid);
      bySession.set(data.sessionId, pids);
    } catch {
      // A file being written or a stranger's file: skipped, never fatal.
    }
  }
  return bySession;
}

/** Only ESRCH proves the pid is gone. EPERM means a process runs there under another user. */
function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** A native install's own binary, `~/.local/share/claude/versions/<version>`: background
 *  sessions run it directly, so its process name is the bare version (Linux shows only that). */
const VERSIONED_BINARY = /^\d+\.\d+\.\d+([.+-][\w.]*)?$/;

/** Names a Claude Code session runs under: the native binary (by its launcher name or its
 *  versioned file), or the npm package under node or bun. Anything else at that pid is a later
 *  process that reused it. */
function isSessionProcess(comm: string): boolean {
  const base = path.basename(comm.trim()).toLowerCase();
  return (
    base === 'claude' ||
    base === 'node' ||
    base === 'bun' ||
    base.includes('claude') ||
    VERSIONED_BINARY.test(base)
  );
}

/** Running pids whose process is not Claude Code: the session died and its pid was reused.
 *  A failed or timed-out `ps`, or a platform without one, flags nothing. */
function reusedPids(pids: number[]): Promise<Set<number>> {
  const reused = new Set<number>();
  if (pids.length === 0 || (process.platform !== 'darwin' && process.platform !== 'linux')) {
    return Promise.resolve(reused);
  }
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'pid=,comm=', '-p', pids.join(',')],
      { timeout: HEALTH_PS_TIMEOUT_MS },
      // ps exits 1 when a pid ended since the kill(0) probe; the lines it did print still
      // hold, and a pid it left out simply stays alive until the next tick.
      (_err, stdout) => {
        for (const line of String(stdout ?? '').split('\n')) {
          const match = /^\s*(\d+)\s+(.+)$/.exec(line);
          if (match && !isSessionProcess(match[2])) reused.add(Number(match[1]));
        }
        resolve(reused);
      },
    );
  });
}

/**
 * Liveness of each session from Claude Code's own session files. A session with no file is
 * `unknown`, never dead: the file is the only evidence. With files, it is alive while any of
 * its pids runs Claude Code; a pid that is gone, or that now runs something else, is dead.
 */
export async function claudeSessionLiveness(
  sessionIds: string[],
): Promise<Map<string, SessionLiveness>> {
  const pidsBySession = readSessionPids();
  const running = new Set<number>();
  for (const id of sessionIds) {
    for (const pid of pidsBySession.get(id) ?? []) {
      if (pidRunning(pid)) running.add(pid);
    }
  }
  const reused = await reusedPids([...running]);
  const result = new Map<string, SessionLiveness>();
  for (const id of sessionIds) {
    const pids = pidsBySession.get(id);
    if (!pids) {
      result.set(id, 'unknown');
      continue;
    }
    const alive = pids.some((pid) => running.has(pid) && !reused.has(pid));
    result.set(id, alive ? 'alive' : 'dead');
  }
  return result;
}
