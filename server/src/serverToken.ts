import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  MAX_PORT,
  SAVED_PORT_MIN,
  SERVER_PORT_FILE_NAME,
  SERVER_TOKEN_FILE_NAME,
  SERVER_TOKEN_PATTERN,
} from './constants.js';

/** Whether `token` may be a standalone server token (from `--token` or the token file). */
export function isValidServerToken(token: string): boolean {
  return SERVER_TOKEN_PATTERN.test(token);
}

/**
 * The standalone server's token, read from `<dir>/server-token` or minted and written
 * there (0600). Reusing it across restarts is what keeps the printed URL valid: a tab
 * opened with it reconnects after a restart instead of being refused with 4001.
 *
 * A missing, unreadable or invalid file gets a fresh token. A failed write is logged and
 * the fresh token serves this run only: the server still starts.
 */
export function loadOrCreateToken(dir: string): string {
  try {
    const stored = fs.readFileSync(path.join(dir, SERVER_TOKEN_FILE_NAME), 'utf-8').trim();
    if (isValidServerToken(stored)) return stored;
  } catch {
    // No usable file: mint one below.
  }
  const token = crypto.randomUUID();
  saveToken(dir, token);
  return token;
}

/**
 * Save `token` over `<dir>/server-token` (0600): the next start serves it, and every URL
 * carrying the old one is refused from then on (`--new-token`). A failed write is logged.
 */
export function saveToken(dir: string, token: string): void {
  try {
    writeOwnerOnly(dir, SERVER_TOKEN_FILE_NAME, token);
  } catch (e) {
    console.error(`[pixelmates] Failed to write the server token file: ${e}`);
  }
}

/**
 * The port the standalone server last picked for itself, from `<dir>/server-port`: an
 * integer from SAVED_PORT_MIN to MAX_PORT. No file, or anything else in it, is undefined
 * and the OS picks one, so the file can never fail a start or point it at a privileged port.
 */
export function loadSavedPort(dir: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, SERVER_PORT_FILE_NAME), 'utf-8').trim();
  } catch {
    return undefined;
  }
  const port = Number(raw);
  return /^\d+$/.test(raw) && port >= SAVED_PORT_MIN && port <= MAX_PORT ? port : undefined;
}

/** Save the port the next start tries first. A failed write is logged: this run keeps serving. */
export function savePort(dir: string, port: number): void {
  try {
    writeOwnerOnly(dir, SERVER_PORT_FILE_NAME, String(port));
  } catch (e) {
    console.error(`[pixelmates] Failed to write the server port file: ${e}`);
  }
}

/** `<dir>/<name>` written atomically (tmp + rename), owner-only, in an owner-only dir. */
function writeOwnerOnly(dir: string, name: string, content: string): void {
  // A fresh install has no settings dir yet: the first persist creates it, after start.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, name);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  // The create mode does not apply to a leftover tmp file with looser bits.
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
}
