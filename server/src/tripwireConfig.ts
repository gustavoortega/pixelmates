import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR, TRIPWIRES_FILE_NAME } from './constants.js';
import { DEFAULT_TRIPWIRE_RULES } from './tripwireDefaults.js';
import type { TripwireRule, TripwireSeverity } from './tripwires.js';

const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RULE_NAME = /^[\x20-\x7E]{1,80}$/;
const RULE_FLAGS = /^[im]{0,2}$/;
const SEVERITIES: readonly string[] = ['high', 'medium', 'low'];

function tripwiresFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, TRIPWIRES_FILE_NAME);
}

/**
 * Validate one user rule. Failures return a fixed reason, never the offending
 * value: ids and names come from a file the server does not control and must
 * not reach the log or the wire unchecked.
 */
function parseRule(raw: unknown): TripwireRule | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !RULE_ID.test(r.id)) return 'invalid id';
  // `<` and `>` are rejected on top of printable ASCII: names are rendered in the office.
  if (typeof r.name !== 'string' || !RULE_NAME.test(r.name) || /[<>]/.test(r.name)) {
    return 'invalid name';
  }
  if (typeof r.severity !== 'string' || !SEVERITIES.includes(r.severity)) {
    return 'invalid severity';
  }
  if (typeof r.tool !== 'string') return 'invalid tool';
  if (r.input !== undefined && typeof r.input !== 'string') return 'invalid input';
  if (r.flags !== undefined && (typeof r.flags !== 'string' || !RULE_FLAGS.test(r.flags))) {
    return 'invalid flags';
  }
  if (
    r.ignoreKeys !== undefined &&
    (!Array.isArray(r.ignoreKeys) || r.ignoreKeys.some((k) => typeof k !== 'string'))
  ) {
    return 'invalid ignoreKeys';
  }
  try {
    const rule: TripwireRule = {
      id: r.id,
      name: r.name,
      severity: r.severity as TripwireSeverity,
      tool: new RegExp(r.tool),
    };
    if (r.input !== undefined)
      rule.input = new RegExp(r.input as string, (r.flags as string) ?? '');
    if (r.ignoreKeys !== undefined) rule.ignoreKeys = r.ignoreKeys as string[];
    return rule;
  } catch {
    return 'invalid regex';
  }
}

/**
 * Default pack merged with the user file (`{ enabled?, disable?, rules? }`).
 * A user rule with a default's id replaces it in place; `disable` drops
 * defaults by id; `enabled: false` turns every rule off. A missing or
 * malformed file means the defaults. Read once at startup: a user regex with
 * catastrophic backtracking stalls the whole server, which shares one event loop.
 * Rules run synchronously on inputs up to 1 MiB.
 */
export function loadTripwireRules(filePath: string = tripwiresFilePath()): readonly TripwireRule[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[pixelmates] Tripwires: cannot read tripwires.json, using defaults');
    }
    return DEFAULT_TRIPWIRE_RULES;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn('[pixelmates] Tripwires: tripwires.json is not valid JSON, using defaults');
    return DEFAULT_TRIPWIRE_RULES;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[pixelmates] Tripwires: tripwires.json is not an object, using defaults');
    return DEFAULT_TRIPWIRE_RULES;
  }
  const cfg = parsed as { enabled?: unknown; disable?: unknown; rules?: unknown };
  if (cfg.enabled === false) return [];

  const disabled = new Set(
    Array.isArray(cfg.disable) ? cfg.disable.filter((d) => typeof d === 'string') : [],
  );
  const merged = DEFAULT_TRIPWIRE_RULES.filter((r) => !disabled.has(r.id));

  if (Array.isArray(cfg.rules)) {
    cfg.rules.forEach((raw, index) => {
      const rule = parseRule(raw);
      if (typeof rule === 'string') {
        console.warn(`[pixelmates] Tripwires: rule #${index} skipped (${rule})`);
        return;
      }
      const existing = merged.findIndex((r) => r.id === rule.id);
      if (existing >= 0) merged[existing] = rule;
      else merged.push(rule);
    });
  }
  return merged;
}
