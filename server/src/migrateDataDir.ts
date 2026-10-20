import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CONFIG_FILE_NAME,
  DATA_DIR_MODE,
  DATA_FILE_MODE,
  LAYOUT_FILE_DIR,
  LEGACY_DATA_DIR,
  MIGRATED_FILE_NAMES,
  MIGRATED_STATE_FILE_PATTERN,
} from './constants.js';

function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Names to copy, in copy order. config.json goes last: it is the marker that
 *  ends the migration, so a crash before it makes the next start run it again. */
function namesToCopy(legacyDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(legacyDir);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if ((MIGRATED_FILE_NAMES as readonly string[]).includes(entry)) names.add(entry);
    else if (MIGRATED_STATE_FILE_PATTERN.test(entry)) names.add(entry);
  }
  return [...names].sort().concat(CONFIG_FILE_NAME);
}

/** The file's bytes to write at the target. Consent was granted to the other app,
 *  so it does not travel: pixelmates asks for its own before touching settings. */
function contentFor(name: string, source: string): Buffer | null {
  const raw = fs.readFileSync(source);
  if (name !== CONFIG_FILE_NAME) return raw;
  const parsed: unknown = JSON.parse(raw.toString('utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { hooksConsent: _dropped, ...rest } = parsed as Record<string, unknown>;
  return Buffer.from(JSON.stringify(rest, null, 2) + '\n');
}

/** Write via a temp file, then link it into place: unlike rename, link never
 *  replaces a target that appeared since the check. Returns whether it landed. */
function copyOne(name: string, legacyDir: string, dataDir: string): boolean {
  const target = path.join(dataDir, name);
  if (exists(target)) return false;
  const source = path.join(legacyDir, name);
  if (!isRegularFile(source)) return false;
  const content = contentFor(name, source);
  if (content === null) throw Object.assign(new Error('not an object'), { code: 'EINVAL' });
  const tmp = path.join(dataDir, `${name}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: DATA_FILE_MODE });
    fs.linkSync(tmp, target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' && exists(target)) return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * One-time copy of the office (layout, crew, settings, state) from upstream Pixel
 * Agents' data dir into ~/.pixelmates, so a user who comes from it keeps their room.
 *
 * Runs only while ~/.pixelmates/config.json is absent and ~/.pixel-agents/config.json
 * exists. The legacy dir is read, never written. A file that cannot be copied is
 * skipped with one warning naming it; an error that is not a filesystem error is a
 * bug and propagates. Returns how many files were copied.
 */
export function migrateDataDir(home: string = os.homedir()): number {
  const legacyDir = path.join(home, LEGACY_DATA_DIR);
  const dataDir = path.join(home, LAYOUT_FILE_DIR);
  if (exists(path.join(dataDir, CONFIG_FILE_NAME))) return 0;
  if (!isRegularFile(path.join(legacyDir, CONFIG_FILE_NAME))) return 0;

  fs.mkdirSync(dataDir, { recursive: true, mode: DATA_DIR_MODE });
  let copied = 0;
  for (const name of namesToCopy(legacyDir)) {
    try {
      if (copyOne(name, legacyDir, dataDir)) copied++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code !== 'string' && !(err instanceof SyntaxError)) throw err;
      console.warn(
        `[pixelmates] Skipped ${name} from ~/${LEGACY_DATA_DIR}: ${code ?? 'invalid JSON'}`,
      );
    }
  }
  if (copied > 0) {
    console.log(`Copied your office from ~/${LEGACY_DATA_DIR} (${copied} files).`);
  }
  return copied;
}
