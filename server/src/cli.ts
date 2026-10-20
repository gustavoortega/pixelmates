#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixelmates`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import * as os from 'os';
import * as path from 'path';

import type { HookInstallOptions } from '../../core/src/provider.js';
import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import {
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  readConfig,
} from './configPersistence.js';
import { LAYOUT_FILE_DIR, MAX_PORT, MIN_PORT, ROSTER_FILE_NAME } from './constants.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { migrateDataDir } from './migrateDataDir.js';
import { claudeProvider, copyHookScript, hookProviderById } from './providers/index.js';
import { RosterStore } from './roster.js';
import { PixelAgentsServer } from './server.js';
import { isValidServerToken } from './serverToken.js';
import { TokenLedger } from './tokenLedger.js';
import { loadTripwireRules } from './tripwireConfig.js';
import { UsageLimitsStore } from './usage/usageLimitsStore.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Unset -> the port the last run picked for itself (~/.pixelmates/server-port),
   *  else an OS-assigned one; a saved port that is taken falls back to an
   *  OS-assigned one. --port picks a fixed one for this run only (busy is an
   *  error) and is never saved. */
  port?: number;
  host: string;
  /** --token: the server token to use instead of the saved one. */
  token?: string;
  /** --new-token: replace the saved server token with a fresh one. */
  newToken: boolean;
}

/** Thrown by parseArgs on an invalid argument. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { host: '127.0.0.1', newToken: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${argv[i]}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--token') {
      const raw = argv[i + 1];
      // The value is a secret: never echo it back.
      if (raw === undefined || !isValidServerToken(raw)) {
        throw new CliArgsError(
          'invalid --token: expected 16 to 128 characters of A-Z, a-z, 0-9, ".", "_" or "-".',
        );
      }
      args.token = raw;
      i++;
    } else if (argv[i] === '--new-token') {
      args.newToken = true;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixelmates [options]

Options:
  --port, -p <number>   Port to listen on (default: the last run's port, else an
                        OS-assigned one)
  --host <string>       Host to bind to (default: 127.0.0.1; loopback binds only
                        accept loopback Host headers, use 0.0.0.0 behind a tunnel)
  --token <token>       Server token for this run (16-128 characters of A-Z a-z
                        0-9 . _ -). Default: the one saved in
                        ~/.pixelmates/server-token, created on first run
  --new-token           Replace the saved token with a new one; URLs carrying the
                        old token stop working
  --help                Show this help message`);
      process.exit(0);
    }
  }
  // --token never touches the saved token, so with it --new-token would rotate
  // nothing while the user believes the old URL is dead.
  if (args.token !== undefined && args.newToken) {
    throw new CliArgsError(
      '--token and --new-token cannot be combined: --token leaves the saved token as it is.',
    );
  }
  return args;
}

// ── Hooks consent ─────────────────────────────────────────────
// First-run consent is asked IN THE APP, not here: the server sends a
// hooksConsentRequest to privileged (tokened) connections during the
// webviewReady handshake (clientMessageHandler.ts), and the browser renders
// the dialog — the same UX the VS Code webview shows. The CLI itself never
// prompts; a headless run just starts without hooks until consent is granted
// through the UI. The one exception that needs no dialog is the silent-grant
// migration below (our hooks already installed by a pre-consent version).

/**
 * Copy the bundled scripts (hook script and status line wrapper) into
 * ~/.pixelmates/hooks/, reporting failure.
 *
 * Callers run this BEFORE installing the settings.json entries and abort when
 * it returns false: an entry whose command points at a missing script makes
 * Claude Code spawn a dead `node` process for every event (or blanks the
 * status line), which is strictly worse than no install at all.
 */
function copyHookScriptOrReport(packageRoot: string, context = ''): boolean {
  if (copyHookScript(packageRoot)) return true;
  console.error(`[pixelmates] Hooks NOT installed${context}: hook script missing.`);
  return false;
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[pixelmates] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Before anything reads or creates ~/.pixelmates: the copy runs only while it has no config.
  migrateDataDir();

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const packageRoot = path.dirname(distRoot);
  const staticDir = path.join(distRoot, 'webview');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[pixelmates] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[pixelmates] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);
  // One crew for every pixelmates process on this machine (VS Code shares the same file).
  const roster = new RosterStore({
    filePath: path.join(os.homedir(), LAYOUT_FILE_DIR, ROSTER_FILE_NAME),
  });
  roster.attach(store);

  // ── Create server ──
  const server = new PixelAgentsServer();

  try {
    // Create runtime first (before server.start, so we can pass it in)
    const runtime = new AgentRuntime(store, claudeProvider, loadTripwireRules());

    // Token ledger: started after the server is up (never from createHttpServer, which tests build directly).
    const usageSource = claudeProvider.transcriptUsage;
    const tokenLedger = usageSource
      ? new TokenLedger({
          source: usageSource,
          getAreaMappings: () => readConfig().standalone.areaMappings,
          getBudgets: () => {
            const { tokenBudget5h, tokenBudgetWeek } = readConfig().standalone;
            return { budget5h: tokenBudget5h, budgetWeek: tokenBudgetWeek };
          },
          onChange: (message) => store.broadcast({ ...message }),
        })
      : undefined;

    // Official limits from the status line wrapper. A new reset time anchors the
    // ledger's block/week, so its captions read the quota while the wrapper posts.
    const usageLimits = new UsageLimitsStore(store, (window, resetsAt, now) => {
      tokenLedger?.anchorQuota({
        window: window === 'fiveHour' ? 'block' : 'week',
        ts: now,
        resetsAt,
      });
    });

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onSetHooksEnabled side effect: install/uninstall the named provider's
    // hooks when the user toggles in the UI (or answers the consent ask).
    // Captures config from the outer scope after server.start().
    let currentConfig: { port: number; token: string } | null = null;
    const onSetHooksEnabled = async (
      providerId: string,
      enabled: boolean,
      options?: HookInstallOptions,
    ): Promise<void> => {
      if (!currentConfig) return;
      const provider = hookProviderById(providerId);
      if (!provider) return; // unknown id: nothing to install into
      if (enabled) {
        // Reached by a toggle whose ask was already answered, or by an Install
        // answer (clientMessageHandler asks first when it was not): either way
        // the user has approved modifying the provider's settings file. Every
        // registered provider runs one of the bundled scripts, so they are
        // copied before any install.
        grantHooksConsent(provider.id);
        if (!copyHookScriptOrReport(packageRoot, ' (user toggle)')) {
          return;
        }
        try {
          await provider.installHooks(
            `http://127.0.0.1:${currentConfig.port}`,
            currentConfig.token,
            options,
          );
        } catch (err) {
          console.error(`[pixelmates] ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        console.log('[pixelmates] Hooks installed (user toggle)');
      } else {
        try {
          await provider.uninstallHooks();
          console.log('[pixelmates] Hooks uninstalled (user toggle)');
        } catch (err) {
          console.error(`[pixelmates] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    // onReloadAssets side effect: re-run the shared loaders (bundled + external
    // dirs) after an external-asset-directory change, then re-broadcast the
    // updated sprites to the requesting client. Mutates the assetCache object in
    // place so already-open sockets (which captured the same reference) and
    // future webviewReady handshakes both observe the new assets. Only
    // characters/pets/furniture can come from external dirs, so only those three
    // are reloaded and re-sent (mirrors the VS Code reload path).
    const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
      const externalDirs = readConfig().externalAssetDirectories;
      const [characters, pets, furniture] = await Promise.all([
        loadAllCharacters(distRoot, externalDirs),
        loadAllPets(distRoot, externalDirs),
        loadAllFurniture(distRoot, externalDirs),
      ]);
      assetCache.characters = characters;
      assetCache.pets = pets;
      assetCache.furniture = furniture;
      if (characters) {
        send({ type: 'characterSpritesLoaded', characters: characters.characters });
      }
      if (pets) {
        send({
          type: 'petSpritesLoaded',
          pets: pets.pets,
          petNames: pets.manifests.map((m) => m.name),
        });
      }
      if (furniture) {
        send({
          type: 'furnitureAssetsLoaded',
          catalog: furniture.catalog,
          sprites: Object.fromEntries(furniture.sprites),
        });
      }
      console.log('[pixelmates] Assets reloaded (external directory change)');
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
      newToken: args.newToken,
      staticDir,
      assetCache,
      onSetHooksEnabled,
      onReloadAssets,
      tokenLedger,
      token: args.token,
      usageLimits,
    });
    currentConfig = { port: config.port, token: config.token };
    if (args.newToken && config.pid !== process.pid) {
      // start() handed back the live server, which keeps serving the token it
      // started with: a new one saved under it would revoke nothing now.
      console.error('A standalone server is already running; --new-token ignored (stop it first).');
    }

    // Sync runtime refs with persisted settings BEFORE first scan tick. The
    // runtime's single hooksEnabled ref follows the Claude provider until the
    // scanners grow per-provider awareness alongside the Settings UI.
    runtime.hooksEnabled.current = getHooksEnabled(claudeProvider.id);
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    // Install hooks on startup if the persisted setting says so — gated on the
    // one-time consent to modify ~/.claude/settings.json.
    if (runtime.hooksEnabled.current) {
      let consent = getHooksConsent(claudeProvider.id) === 'granted';
      if (!consent && (await claudeProvider.areHooksInstalled())) {
        // Our hooks are already installed and already firing — a pre-consent
        // version put them there. Grant and continue with NO prompt: the
        // install below is the 14 -> 12 migration, and it only ever REDUCES
        // scope (it drops UserPromptSubmit and TaskCreated, the two events that
        // forwarded prompt text and were consumed by nothing). Asking would buy
        // this user no protection they do not already have, so they are not
        // asked. A fresh install still is, in full — in the browser UI, when a
        // tokened client connects (clientMessageHandler's webviewReady).
        grantHooksConsent(claudeProvider.id);
        consent = true;
      }
      if (!consent) {
        console.log(
          '[pixelmates] Hooks not installed: modifying ~/.claude/settings.json needs one-time approval — open the URL below to review and approve it.',
        );
      } else if (copyHookScriptOrReport(packageRoot)) {
        try {
          await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
          console.log('[pixelmates] Hooks installed');
        } catch (err) {
          console.error(`[pixelmates] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      // Without this line, a persisted hooks-off makes startup skip the entire
      // consent/install flow with zero output — indistinguishable from a bug.
      console.log(
        '[pixelmates] Hooks disabled — enable "Instant Detection (Hooks)" in the UI settings to install them.',
      );
    }

    // Background scan of ~/.claude/projects for the Usage panel; the first pass reports `scanning: true`.
    tokenLedger?.start();

    // Start scanning for external sessions (Claude running in user's terminal)
    const cwd = process.cwd();
    const dirs = claudeProvider.getSessionDirs?.(cwd);
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      console.log(`[pixelmates] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    // The URL the operator opens has to be REACHABLE (a wildcard bind address
    // is a bind target, not an address you can browse to — `--host 0.0.0.0`
    // used to print a dead `http://0.0.0.0:PORT`) and has to carry the token,
    // which /ws requires to connect at all (see standaloneTokenValid in
    // httpServer.ts). Under `--host 0.0.0.0` a LAN viewer opens this machine's
    // own address with the same `?token=`.
    const displayHost =
      args.host === '0.0.0.0' || args.host === '::' || args.host === '' ? '127.0.0.1' : args.host;
    console.log(
      `\n  pixelmates server running at http://${displayHost}:${config.port}/?token=${config.token}\n`,
    );

    // ── Graceful shutdown ──
    function shutdown(): void {
      console.log('\nShutting down...');
      tokenLedger?.dispose();
      runtime.dispose();
      roster.dispose();
      server.stop();
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // A closed terminal sends SIGHUP, whose default kills the process before
    // stop() removes server.json, leaving a dead pid for hook scripts to find.
    process.on('SIGHUP', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
