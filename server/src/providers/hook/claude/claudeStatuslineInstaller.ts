import * as fs from 'fs';

import type { HookInstallOptions } from '../../../../../core/src/provider.js';
import type { ClaudeSettings } from './claudeHookInstaller.js';
import { mutateClaudeSettings, readClaudeSettings } from './claudeHookInstaller.js';
import {
  makeStatuslineCommand,
  makeTeeOnlyStatusLine,
  parseStatuslineCommand,
  parseUpstreamStatuslineCommand,
  statuslineTeePath,
} from './commandIdentity.js';

/**
 * Chains the status line wrapper (statusline-tee.js) in front of the user's statusLine command in
 * ~/.claude/settings.json, and takes it out again. Every write goes through the hook installer's guarded cycle
 * (exclusive-create one-time backup, atomic tmp + rename, re-read verify), so the two installers share one set of
 * write rules.
 *
 * The restore source is the chained command itself: the wrapper's single argument IS the original command, so
 * uninstall needs no saved copy that could drift from what the file says (docs/adr/0002).
 */

/** Thrown, with the shape found, when statusLine is something we did not author and cannot wrap safely. */
export const STATUSLINE_UNEXPECTED_SHAPE =
  'statusLine in ~/.claude/settings.json is not a command pixelmates can wrap';

/** Logged when uninstall finds a statusLine that is no longer ours: it is left exactly as it is. */
export const STATUSLINE_LEFT_IN_PLACE = 'statusLine was changed by hand; left as is.';

/** Thrown by the provider's install on Windows: the wrapper runs the original through `sh`. */
export const STATUSLINE_UNSUPPORTED_PLATFORM =
  'Status line chaining is not supported on Windows yet.';

/** Thrown when the wrapper script is not on disk: a chained command pointing at a missing script would blank the
 *  user's status line instead of running it. */
export const STATUSLINE_TEE_MISSING =
  'The status line wrapper script is missing from ~/.pixelmates/hooks';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The wrapper's view of a statusLine value: the original it wraps, or null when it is not ours. */
function parseOurs(statusLine: unknown): { original: string | null } | null {
  if (!isPlainObject(statusLine) || typeof statusLine.command !== 'string') return null;
  return parseStatuslineCommand(statusLine.command);
}

/** The statusLine's command when upstream Pixel Agents' wrapper is in it, else null. */
function upstreamWrapperOf(statusLine: unknown): { original: string | null } | null {
  if (!isPlainObject(statusLine) || typeof statusLine.command !== 'string') return null;
  return parseUpstreamStatuslineCommand(statusLine.command);
}

/** Whether statusLine.command runs upstream Pixel Agents' wrapper: the consent ask then offers to replace it. An
 *  unreadable file reads as "no", like isStatuslineInstalled. */
export function hasUpstreamStatusline(): boolean {
  try {
    return upstreamWrapperOf(readClaudeSettings().statusLine) !== null;
  } catch {
    return false;
  }
}

/** "found …" for the unexpected-shape error: the keys of an object, or what the value is instead. */
function describeShape(value: unknown): string {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return keys.length > 0 ? `keys: ${keys.join(', ')}` : 'an empty object';
  }
  if (Array.isArray(value)) return 'an array';
  return value === null ? 'null' : `a ${typeof value}`;
}

/** Whether statusLine.command in ~/.claude/settings.json is our wrapper. An unreadable file reads as "not
 *  installed", like the hooks: install then refuses to touch it rather than rewrite it. */
export function isStatuslineInstalled(): boolean {
  let settings: ClaudeSettings;
  try {
    settings = readClaudeSettings();
  } catch {
    return false;
  }
  return parseOurs(settings.statusLine) !== null;
}

/**
 * Wrap the user's statusLine command.
 *
 * - No statusLine: write `{type: 'command', command: <wrapper, no argument>}`.
 * - A plain object with `type: 'command'` and a non-empty command: replace the command only, keeping every other
 *   field verbatim (padding, refreshInterval, keys we do not know).
 * - Already ours: nothing to do. The wrapper never wraps itself.
 * - Upstream Pixel Agents' wrapper: wrapped like any other command (its text stays inside ours, untouched) unless
 *   `replaceLegacy`, which unwraps it first so ours wraps the command the user had before it.
 * - Anything else: refuse before any write, naming what was found.
 */
export async function installStatusline(options: HookInstallOptions = {}): Promise<void> {
  const teePath = statuslineTeePath();
  let wrote: boolean;
  try {
    if (!fs.existsSync(teePath)) throw new Error(STATUSLINE_TEE_MISSING);
    wrote = await mutateClaudeSettings((settings) => {
      const current = settings.statusLine;
      if (current === undefined) {
        settings.statusLine = makeTeeOnlyStatusLine(teePath);
        return true;
      }
      if (parseOurs(current) !== null) return false;
      const upstream = options.replaceLegacy === true ? upstreamWrapperOf(current) : null;
      if (upstream !== null && isPlainObject(current)) {
        // Unwrapped: ours wraps what upstream wrapped, or stands alone when upstream wrapped nothing.
        settings.statusLine = {
          ...current,
          command:
            upstream.original === null || upstream.original.trim() === ''
              ? makeTeeOnlyStatusLine(teePath).command
              : makeStatuslineCommand(teePath, upstream.original),
        };
        return true;
      }
      if (
        isPlainObject(current) &&
        current.type === 'command' &&
        typeof current.command === 'string' &&
        current.command.trim() !== ''
      ) {
        // Spread keeps the key order: `command` is replaced where it stands.
        settings.statusLine = {
          ...current,
          command: makeStatuslineCommand(teePath, current.command),
        };
        return true;
      }
      throw new Error(`${STATUSLINE_UNEXPECTED_SHAPE} (found ${describeShape(current)})`);
    });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}; status line left unchanged.`, {
      cause: e,
    });
  }
  if (wrote) {
    console.log('[pixelmates] Status line wrapper chained in ~/.claude/settings.json');
  }
}

/**
 * Put the user's statusLine back: the original read out of our wrapper's argument goes back into
 * statusLine.command with every other field as it is now, and a wrapper we created from nothing takes the whole key
 * with it. A statusLine that is not ours by the identity rule is never written to: the user changed it after the
 * install, and anything we wrote back would be a guess.
 */
export async function uninstallStatusline(): Promise<void> {
  let leftInPlace = false;
  let wrote: boolean;
  try {
    wrote = await mutateClaudeSettings((settings) => {
      leftInPlace = false;
      const current = settings.statusLine;
      if (current === undefined) return false;
      const ours = parseOurs(current);
      if (ours === null) {
        leftInPlace = true;
        return false;
      }
      if (ours.original === null) {
        delete settings.statusLine;
      } else {
        settings.statusLine = { ...(current as Record<string, unknown>), command: ours.original };
      }
      return true;
    });
  } catch (e) {
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}; status line wrapper left in place.`,
      { cause: e },
    );
  }
  if (leftInPlace) console.log(`[pixelmates] ${STATUSLINE_LEFT_IN_PLACE}`);
  if (wrote) console.log('[pixelmates] Status line restored in ~/.claude/settings.json');
}
