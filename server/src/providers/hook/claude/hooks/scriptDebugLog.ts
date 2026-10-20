import * as fs from 'fs';

import type { ServerTarget } from '../../../../serverConfig.js';

/**
 * CI / e2e diagnostic for the bundled scripts: when PIXELMATES_DEBUG_LOG is
 * set, record each script's outcome at every exit point. The delivery chain
 * (spawn the script -> read the registry -> POST to every live server) is
 * otherwise 100% silent: every failure path resolves quietly, so a dropped
 * event is invisible in CI. Logging here lets a failing run show exactly where
 * delivery dies (bad-stdin, no-server-json, per-server POST
 * error/timeout/status). Zero cost when the env var is unset. Never logs a
 * token.
 *
 * The env var is the primary source, but it doesn't reliably reach a spawned
 * script across platforms (macOS VS Code terminal profiles with
 * inheritEnv:false, etc.). After reading the registry a script falls back to a
 * live server's `debugLog` field, which the server populated from the same env
 * var (adoptFrom).
 */
export interface ScriptDebugLog {
  log(line: string): void;
  /** Adopt the first target's debug-log path if the env var didn't reach us
   *  (diagnostic-only; harmless if more than one server has it set). */
  adoptFrom(targets: readonly ServerTarget[]): void;
}

export function createScriptDebugLog(tag: string): ScriptDebugLog {
  let logPath = process.env['PIXELMATES_DEBUG_LOG'];
  return {
    log(line) {
      if (!logPath) return;
      try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${tag} ${line}\n`);
      } catch {
        /* never let diagnostics break the script */
      }
    },
    adoptFrom(targets) {
      if (logPath) return;
      const withDebugLog = targets.find((s) => s.debugLog);
      if (withDebugLog?.debugLog) logPath = withDebugLog.debugLog;
    },
  };
}
