import * as fs from 'fs';
import * as path from 'path';

import { SERVER_JSON_DIR, SERVER_JSON_NAME, SERVERS_DIR } from '../../../constants.js';
import type { ServerConfig, ServerTarget } from '../../../serverConfig.js';
import { isServerConfig, isServerTarget } from '../../../serverConfig.js';

/**
 * Which pixelmates servers a bundled script should POST to. Shared by the hook script and the status line wrapper,
 * so both reach exactly the same servers by the same rules.
 */

/** True if a process with this PID is alive. Best-effort: a false positive on
 *  PID reuse just costs one extra, harmless, failed POST -- never a crash. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate every live registry entry under ~/.pixelmates/servers/, so the
 * event can fan out to each running server (VS Code embedded + a standalone
 * `npx @pixelmates/cli`, or several of either, all at once). Entries whose owning
 * PID is no longer alive are skipped (the owning server prunes its own stale
 * file on next start; this script only needs to not POST to it). Returns an
 * empty array when the directory is absent/empty/unreadable -- the caller
 * falls back to the legacy single-target server.json (forward-compat with a
 * server that predates the registry).
 */
function readRegistry(registryDir: string, debug: (line: string) => void): ServerConfig[] {
  let files: string[];
  try {
    files = fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const live: ServerConfig[] = [];
  for (const file of files) {
    const filePath = path.join(registryDir, file);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!isServerConfig(entry)) {
        debug(`registry-skip reason=malformed file=${file} err=invalid-server-config`);
        continue;
      }
      if (isProcessAlive(entry.pid)) {
        live.push(entry);
      } else {
        debug(`registry-skip reason=dead-pid file=${file} pid=${entry.pid}`);
      }
    } catch (e) {
      debug(
        `registry-skip reason=malformed file=${file} err=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return live;
}

/**
 * Every live server in the registry (D4 multi-server fan-out); the single
 * legacy server.json only when the registry has no live entry, e.g. a server
 * on disk that predates the registry (A1/A2). Empty when neither yields a
 * valid target. `debug` receives one line per skipped entry, never a token.
 */
export function readServerTargets(
  home: string,
  debug: (line: string) => void = () => {},
): ServerTarget[] {
  const live = readRegistry(path.join(home, SERVER_JSON_DIR, SERVERS_DIR), debug);
  if (live.length > 0) return live;
  const legacyPath = path.join(home, SERVER_JSON_DIR, SERVER_JSON_NAME);
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as unknown;
    if (!isServerTarget(legacy)) {
      throw new Error('invalid legacy server config');
    }
    return [legacy];
  } catch (e) {
    debug(`legacy-skip path=${legacyPath} err=${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
