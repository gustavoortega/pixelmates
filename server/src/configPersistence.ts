import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILE_NAME, LAYOUT_FILE_DIR } from './constants.js';
import { hookProviderById } from './providers/index.js';

export interface AdapterSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  showModelFlair: boolean;
  cozyLighting: boolean;
  watchAllSessions: boolean;
  hooksInfoShown: boolean;
  showAreas: boolean;
  areaMappings: Record<string, string[]>;
  /** Token budgets in cost-weighted tokens; absent = no budget (no percent anywhere). */
  tokenBudget5h?: number;
  tokenBudgetWeek?: number;
}

/** All keys in AdapterSettings. Used by adapters to map `pixel-agents.foo` → `foo`.
 *  The hooks preference is NOT here: it is per-provider and machine-global
 *  (the hooks it governs live in one home-directory file per provider), so it
 *  lives beside `hooksConsent` at the config top level, not per namespace. */
export const ADAPTER_SETTING_KEYS = [
  'soundEnabled',
  'lastSeenVersion',
  'alwaysShowLabels',
  'ghostHeadlessAgents',
  'showModelFlair',
  'cozyLighting',
  'watchAllSessions',
  'hooksInfoShown',
  'showAreas',
  'areaMappings',
  'tokenBudget5h',
  'tokenBudgetWeek',
] as const;

export type AdapterSettingKey = (typeof ADAPTER_SETTING_KEYS)[number];

/** Namespaces = adapter identities sharing the same config.json file. */
export type ConfigNamespace = 'vscode' | 'standalone';

/** What the user answered a provider's consent ask with, durably. `granted` is recorded BEFORE the install writes, so
 *  it can exist with nothing on disk; `declined` means the ANSWER itself turned hooks off, the provenance a revised
 *  "Not Now" needs to know the preference is its to take back (a Settings toggle never records consent). Absent =
 *  unanswered, the ask is still open. */
export type HooksConsentState = 'granted' | 'declined';

export interface PixelAgentsConfig {
  vscode: AdapterSettings;
  standalone: AdapterSettings;
  externalAssetDirectories: string[];
  /** Per-provider consent to modify that provider's settings file (Claude:
   *  ~/.claude/settings.json). Shared across surfaces — consent is per-human
   *  per-provider, not per-adapter. A provider absent from the map has never
   *  been answered. */
  hooksConsent: Record<string, HooksConsentState>;
  /** Per-provider hooks preference, machine-global for the same reason as the
   *  consent above. A provider absent from the map takes its default
   *  (HookProvider.defaultEnabled, true unless the provider says otherwise). */
  hooksEnabled: Record<string, boolean>;
}

const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  ghostHeadlessAgents: false,
  showModelFlair: true,
  cozyLighting: true,
  watchAllSessions: false,
  hooksInfoShown: false,
  showAreas: false,
  areaMappings: {},
};

function getConfigFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
}

/** Coerce a loose object into the per-provider consent map, dropping entries whose value is not exactly 'granted' or
 *  'declined'. */
function parseHooksConsent(raw: unknown): Record<string, HooksConsentState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, HooksConsentState> = {};
  for (const [providerId, state] of Object.entries(raw as Record<string, unknown>)) {
    if (state === 'granted' || state === 'declined') out[providerId] = state;
  }
  return out;
}

/** Coerce a loose object into the per-provider hooks-preference map, dropping non-boolean values. */
function parseHooksEnabled(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [providerId, enabled] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof enabled === 'boolean') out[providerId] = enabled;
  }
  return out;
}

/**
 * Coerce a loose object into `Record<string, string[]>`, dropping any entries whose value is not an array of strings.
 * Returns `{}` if the input isn't an object. Used to defensively load folder→area mappings from config.json, which
 * may have been hand-edited or written by an older build.
 */
export function parseAreaMappings(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [folder, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof folder !== 'string') {
      continue;
    }
    if (!Array.isArray(labels)) {
      continue;
    }
    const filtered = labels.filter((l): l is string => typeof l === 'string');
    out[folder] = filtered;
  }
  return out;
}

/** A usable budget: a positive finite number, else undefined (unset). */
export function parseTokenBudget(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** Coerce a loose object into a valid AdapterSettings with defaults for missing/wrong-typed fields. */
function parseAdapterSettings(raw: unknown): AdapterSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AdapterSettings>;
  const budget5h = parseTokenBudget(obj.tokenBudget5h);
  const budgetWeek = parseTokenBudget(obj.tokenBudgetWeek);
  return {
    soundEnabled:
      typeof obj.soundEnabled === 'boolean'
        ? obj.soundEnabled
        : DEFAULT_ADAPTER_SETTINGS.soundEnabled,
    lastSeenVersion:
      typeof obj.lastSeenVersion === 'string'
        ? obj.lastSeenVersion
        : DEFAULT_ADAPTER_SETTINGS.lastSeenVersion,
    alwaysShowLabels:
      typeof obj.alwaysShowLabels === 'boolean'
        ? obj.alwaysShowLabels
        : DEFAULT_ADAPTER_SETTINGS.alwaysShowLabels,
    ghostHeadlessAgents:
      typeof obj.ghostHeadlessAgents === 'boolean'
        ? obj.ghostHeadlessAgents
        : DEFAULT_ADAPTER_SETTINGS.ghostHeadlessAgents,
    showModelFlair:
      typeof obj.showModelFlair === 'boolean'
        ? obj.showModelFlair
        : DEFAULT_ADAPTER_SETTINGS.showModelFlair,
    cozyLighting:
      typeof obj.cozyLighting === 'boolean'
        ? obj.cozyLighting
        : DEFAULT_ADAPTER_SETTINGS.cozyLighting,
    watchAllSessions:
      typeof obj.watchAllSessions === 'boolean'
        ? obj.watchAllSessions
        : DEFAULT_ADAPTER_SETTINGS.watchAllSessions,
    hooksInfoShown:
      typeof obj.hooksInfoShown === 'boolean'
        ? obj.hooksInfoShown
        : DEFAULT_ADAPTER_SETTINGS.hooksInfoShown,
    showAreas:
      typeof obj.showAreas === 'boolean' ? obj.showAreas : DEFAULT_ADAPTER_SETTINGS.showAreas,
    areaMappings: parseAreaMappings(obj.areaMappings),
    // Spread so an unset budget is an absent key, not `undefined`.
    ...(budget5h !== undefined && { tokenBudget5h: budget5h }),
    ...(budgetWeek !== undefined && { tokenBudgetWeek: budgetWeek }),
  };
}

export function readConfig(): PixelAgentsConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return {
        vscode: { ...DEFAULT_ADAPTER_SETTINGS },
        standalone: { ...DEFAULT_ADAPTER_SETTINGS },
        externalAssetDirectories: [],
        hooksConsent: {},
        hooksEnabled: {},
      };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PixelAgentsConfig>;
    return {
      vscode: parseAdapterSettings(parsed.vscode),
      standalone: parseAdapterSettings(parsed.standalone),
      externalAssetDirectories: Array.isArray(parsed.externalAssetDirectories)
        ? parsed.externalAssetDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      hooksConsent: parseHooksConsent(parsed.hooksConsent),
      hooksEnabled: parseHooksEnabled(parsed.hooksEnabled),
    };
  } catch (err) {
    console.error('[pixelmates] Failed to read config file:', err);
    return {
      vscode: { ...DEFAULT_ADAPTER_SETTINGS },
      standalone: { ...DEFAULT_ADAPTER_SETTINGS },
      externalAssetDirectories: [],
      hooksConsent: {},
      hooksEnabled: {},
    };
  }
}

// ── Per-provider hooks consent + preference ─────────────────
// The provider id keys these maps (HookProvider.id — 'claude' today). All
// writers go through readConfig→writeConfig, so a hand-edited or older file
// degrades to "unanswered"/default rather than crashing.

/** What the user durably answered this provider's ask with, or 'unanswered'. */
export function getHooksConsent(providerId: string): HooksConsentState | 'unanswered' {
  return readConfig().hooksConsent[providerId] ?? 'unanswered';
}

/** Persist the one-time approval for modifying this provider's settings file. A grant REPLACING a decline also
 *  deletes that decline's hooks-off remnant in the same write: without it, an install that then FAILS leaves a grant
 *  beside the retracted hooks-off, and a later "Not Now" (which leaves the preference alone, since the grant never
 *  wrote it) ends at unanswered + hooks-off — an ask that never returns. A successful install persists hooks-on
 *  anyway, so this only changes the failure path. */
export function grantHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'granted') {
    const replacingDecline = cfg.hooksConsent[providerId] === 'declined';
    cfg.hooksConsent[providerId] = 'granted';
    if (replacingDecline) delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Record a durable decline ("Don't Ask Again"): consent 'declined' AND hooks-off, in ONE readConfig→writeConfig
 *  cycle. They are one logical answer — split across two writes, a failed second leaves a state the answer disavows
 *  (a decline with the default-on preference, or a hooks-off with no provenance). */
export function recordHooksDecline(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'declined' || cfg.hooksEnabled[providerId] !== false) {
    cfg.hooksConsent[providerId] = 'declined';
    cfg.hooksEnabled[providerId] = false;
    writeConfig(cfg);
  }
}

/** Un-record an answer AND restore the preference default in ONE cycle — the revised-notNow revert over a decline.
 *  Both keys go together so "never answered" and "answered and reverted" are indistinguishable on disk, and no
 *  partial-write order can leave a half-reverted answer. */
export function clearHooksAnswer(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent || providerId in cfg.hooksEnabled) {
    delete cfg.hooksConsent[providerId];
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Un-record an answer entirely, so the ask genuinely returns. Used when the
 *  user walks the Intro back from its closing step and revises an earlier
 *  answer down to "Not Now": whatever that answer left (a grant, a decline)
 *  must go, or the consent gate reads it as asked-and-answered forever.
 *  Callers only clear a grant after any uninstall verifiably landed. */
export function clearHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent) {
    delete cfg.hooksConsent[providerId];
    writeConfig(cfg);
  }
}

/** A provider's preference before anything was recorded: on, unless the
 *  provider declares itself off by default (the status line wrapper). */
function defaultHooksEnabled(providerId: string): boolean {
  return hookProviderById(providerId)?.defaultEnabled ?? true;
}

/** The per-provider hooks preference. Absent = the provider's default. */
export function getHooksEnabled(providerId: string): boolean {
  return readConfig().hooksEnabled[providerId] ?? defaultHooksEnabled(providerId);
}

/** Whether the preference is recorded ON for a provider that is off by
 *  default: only a Settings toggle-on writes that, so an open ask in this state
 *  is the toggle's, and declining it must take the preference back (see
 *  consentActionFor). Always false for a default-on provider, whose recorded
 *  `true` means nothing the default does not. */
export function hooksPreferenceRaisedFromDefault(providerId: string): boolean {
  return readConfig().hooksEnabled[providerId] === true && !defaultHooksEnabled(providerId);
}

export function setHooksEnabled(providerId: string, enabled: boolean): void {
  const cfg = readConfig();
  if (cfg.hooksEnabled[providerId] !== enabled) {
    cfg.hooksEnabled[providerId] = enabled;
    writeConfig(cfg);
  }
}

/** Restore the provider's preference to its default by REMOVING the key. Deleting rather than writing the default
 *  keeps "never answered" and "answered and reverted" indistinguishable on disk. */
export function clearHooksEnabled(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksEnabled) {
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Called on extension uninstall: return every hooks-related choice to factory state — all providers' consent and
 *  preferences cleared, hooksInfoShown back to default in both namespaces. Those choices belonged to an installation
 *  that no longer exists, so a future install starts from the first-run experience rather than inheriting a stale
 *  hooks-off that would skip the ask forever. */
export function resetHooksConfig(): void {
  const cfg = readConfig();
  cfg.hooksConsent = {};
  cfg.hooksEnabled = {};
  for (const ns of ['vscode', 'standalone'] as const) {
    cfg[ns].hooksInfoShown = DEFAULT_ADAPTER_SETTINGS.hooksInfoShown;
  }
  writeConfig(cfg);
}

export function writeConfig(config: PixelAgentsConfig): void {
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(config, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[pixelmates] Failed to write config file:', err);
  }
}
