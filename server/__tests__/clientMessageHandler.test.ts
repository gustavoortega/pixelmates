import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  type AssetCache,
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
import {
  getHooksEnabled,
  grantHooksConsent,
  readConfig,
  recordHooksDecline,
} from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';
import { TokenLedger } from '../src/tokenLedger.js';
import { DEFAULT_TRIPWIRE_RULES } from '../src/tripwireDefaults.js';
import { applyTripwireHit } from '../src/tripwires.js';
import type { AgentState } from '../src/types.js';
import { UsageLimitsStore } from '../src/usage/usageLimitsStore.js';

/** Let the setHooksEnabled dispatch's async chain (side effect →
 *  areHooksInstalled → persist → send) run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

/**
 * These tests exercise the area-related dispatch branches and the load-order
 * invariant in handleWebviewReady. They isolate the on-disk config + state
 * files by redirecting $HOME to a fresh temp dir for every test, so the
 * standalone adapter writes its config.json there.
 */
describe('clientMessageHandler: areas + carpet wire ordering', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── saveAreaMappings ─────────────────────────────────────────

  describe('saveAreaMappings', () => {
    it('persists a valid mapping payload to cfg.standalone.areaMappings', () => {
      handleClientMessage(
        {
          type: 'saveAreaMappings',
          mappings: { frontend: ['Engineering'], design: ['Engineering', 'Design'] },
        },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({
        frontend: ['Engineering'],
        design: ['Engineering', 'Design'],
      });
    });

    it('is a no-op when mappings is missing or not an object', () => {
      handleClientMessage({ type: 'saveAreaMappings' }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: 'not-an-object' },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('does not leak into the vscode namespace', () => {
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(cfg.vscode.areaMappings).toEqual({});
    });
  });

  // ── setShowAreas ─────────────────────────────────────────────

  describe('setShowAreas', () => {
    it('persists the boolean via the adapter (standalone namespace)', () => {
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);

      const adapter = store.getAdapter()!;
      expect(adapter.getSetting('pixel-agents.showAreas', false)).toBe(true);

      handleClientMessage({ type: 'setShowAreas', enabled: false }, (m) => sent.push(m), ctx);
      expect(adapter.getSetting('pixel-agents.showAreas', true)).toBe(false);
    });
  });

  // ── hooksStatus (actual install state, not the hooksEnabled setting) ──

  describe('hooksStatus', () => {
    it('webviewReady reports installed: false when no hooks are in settings.json', async () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      // The provider check is async; the message lands after the sync handshake.
      await new Promise((r) => setTimeout(r, 0));

      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({ type: 'hooksStatus', providerId: 'claude', installed: false });
    });

    it('setHooksEnabled reports the actual outcome after the side effect settles', async () => {
      // An answered ask: a toggle over an unanswered one asks first (consentFlow.test.ts).
      grantHooksConsent('claude');
      let sideEffectRan = false;
      ctx.privileged = true;
      ctx.onSetHooksEnabled = async () => {
        sideEffectRan = true;
      };
      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectRan).toBe(true);
      // The side effect installed nothing (stub), so the truthful answer is false
      // even though the user just toggled the setting ON.
      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({ type: 'hooksStatus', providerId: 'claude', installed: false });
    });
  });

  // ── setHooksEnabled: preference vs reality ───────────────────

  describe('setHooksEnabled persistence', () => {
    /** Put our command on every installed event, as a real install would. */
    function seedInstalledHooks(): void {
      const command = `node "${path.join(tempHome, '.pixelmates', 'hooks', 'claude-hook.js')}"`;
      const entry = { matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] };
      fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [entry]])),
        }),
      );
    }

    // THE stranding bug: the preference was written BEFORE the uninstall, so a
    // failed removal left the entries on disk and still firing while the
    // persisted hooks-off made the next startup skip the consent/install path
    // entirely — never asked again, no route left to remove them.
    it('does not persist hooks-off when the uninstall failed', async () => {
      seedInstalledHooks();
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => {
        /* the uninstall failed: settings.json still carries our entries */
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: false },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      // The preference still says ON, so the next startup re-runs the install
      // path and the user keeps a way to turn hooks off.
      expect(getHooksEnabled('claude')).toBe(true);
      // ...and the checkbox is told the truth: they are still installed.
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
      });
    });

    // The mirror case: an install that did not happen must not persist ON.
    it('does not persist hooks-on when the install failed', async () => {
      // A declined ask records hooks-off; toggling on over an answered ask installs directly.
      recordHooksDecline('claude');
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => {
        /* the install failed: settings.json stays empty */
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(getHooksEnabled('claude')).toBe(false);
    });

    // The happy path still persists, or the toggle would do nothing at all.
    it('persists the preference when the outcome matches the request', async () => {
      grantHooksConsent('claude');
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => seedInstalledHooks();

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(getHooksEnabled('claude')).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
      });
    });

    // A non-local client (LAN peer, rebound page) never reaches the side effect
    // at all: granting consent to modify ~/.claude/settings.json is not a
    // decision a remote peer gets to make. See httpServerWs.test.ts.
    it('ignores the toggle entirely when the client is not privileged', async () => {
      let sideEffectRan = false;
      ctx.privileged = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectRan).toBe(false);
      expect(getHooksEnabled('claude')).toBe(true);
      // It still hears the truth, so a LAN viewer's checkbox shows reality
      // rather than appearing to have worked.
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
      });
    });
  });

  // ── setCozyLighting ──────────────────────────────────────────

  describe('setCozyLighting', () => {
    const lightingOnConnect = () => {
      sent = [];
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      return (sent.find((m) => m.type === 'settingsLoaded') as { cozyLighting?: boolean })
        .cozyLighting;
    };

    it('is on by default, persists a toggle, and settingsLoaded reports it', () => {
      expect(lightingOnConnect()).toBe(true);

      handleClientMessage({ type: 'setCozyLighting', enabled: false }, (m) => sent.push(m), ctx);
      expect(store.getAdapter()!.getSetting('pixel-agents.cozyLighting', true)).toBe(false);
      expect(lightingOnConnect()).toBe(false);
    });
  });

  // ── handleWebviewReady ordering ──────────────────────────────

  describe('handleWebviewReady ordering', () => {
    it('emits settingsLoaded with showAreas before areaMappingsLoaded before existingAgents', () => {
      // Seed config so the assertion proves the values round-trip via the
      // dispatch rather than just relying on hard-coded defaults.
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );
      sent = [];

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);

      const iSettings = types.indexOf('settingsLoaded');
      const iAreaMappings = types.indexOf('areaMappingsLoaded');
      const iExistingAgents = types.indexOf('existingAgents');

      expect(iSettings).toBeGreaterThanOrEqual(0);
      expect(iAreaMappings).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iSettings).toBeLessThan(iAreaMappings);
      expect(iAreaMappings).toBeLessThan(iExistingAgents);

      const settings = sent[iSettings] as { showAreas?: boolean };
      expect(settings.showAreas).toBe(true);

      const mappings = sent[iAreaMappings] as { mappings?: Record<string, string[]> };
      expect(mappings.mappings).toEqual({ frontend: ['Engineering'] });
    });

    it('emits layoutLoaded after existingAgents so buffered agents materialize', () => {
      // The webview buffers agents from existingAgents and only materializes
      // them on the next layoutLoaded. If layout arrives first, a client
      // connecting after agents were created never renders their characters.
      store.set(1, createTestAgent({ id: 1 }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iExistingAgents = types.indexOf('existingAgents');
      const iLayout = types.indexOf('layoutLoaded');

      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeLessThan(iLayout);

      const existing = sent[iExistingAgents] as { agents?: number[] };
      expect(existing.agents).toEqual([1]);
    });

    it('replays agent activity after layoutLoaded so it lands on real characters', () => {
      // Two things at once, both invisible to the helper's own unit tests:
      // that handleWebviewReady calls the replay at all, and that it runs AFTER
      // layoutLoaded. The characters the replay targets only exist once the
      // layout flush creates them, so an earlier replay is silently dropped and
      // a reconnecting client shows a working agent as Idle.
      store.set(1, createTestAgent({ id: 1, isWaiting: true }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iLayout = types.indexOf('layoutLoaded');
      const iStatus = types.indexOf('agentStatus');

      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iStatus).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeLessThan(iStatus);

      expect(sent[iStatus]).toMatchObject({ type: 'agentStatus', id: 1, status: 'waiting' });
    });

    it('ends the catch-up with handshakeDone, after the workflow presences', () => {
      // A client resyncing after a reconnect removes whatever the catch-up did not restate
      // by the time handshakeDone lands: a presence after it would cost a live helper.
      store.set(
        1,
        createTestAgent({
          id: 1,
          workflow: {
            runs: new Map(),
            watched: new Set(['wf:run1:a1']),
            runIdByToolId: new Map(),
            completedRunIds: new Set(),
            launches: new Map(),
            ignored: new Map(),
          },
        }),
      );

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      // Still synchronous: only the async hooks status and consent ask may follow.
      const types = sent.map((m) => m.type);
      expect(types.filter((t) => t === 'handshakeDone')).toHaveLength(1);
      expect(types[types.length - 1]).toBe('handshakeDone');
      expect(types).toContain('subagentPresent');
    });

    it('emits carpetTilesLoaded after wallTilesLoaded when both are present in the cache', () => {
      // Hex placeholders are test fixtures, not UI tokens — disable the
      // centralized-color rule just for this cache literal.
      /* eslint-disable pixel-agents/no-inline-colors */
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: [[['#000000']]],
        wallTiles: [[[['#aabbcc']]]],
        carpetTiles: [[[['#112233']]]],
        furniture: null,
        defaultLayout: null,
      };
      /* eslint-enable pixel-agents/no-inline-colors */
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iWalls = types.indexOf('wallTilesLoaded');
      const iCarpets = types.indexOf('carpetTilesLoaded');

      expect(iWalls).toBeGreaterThanOrEqual(0);
      expect(iCarpets).toBeGreaterThanOrEqual(0);
      expect(iWalls).toBeLessThan(iCarpets);
    });

    it('skips carpetTilesLoaded when the cache has no carpet sprites', () => {
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: null,
        wallTiles: null,
        carpetTiles: null,
        furniture: null,
        defaultLayout: null,
      };
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const carpetMsgs = sent.filter((m) => m.type === 'carpetTilesLoaded');
      expect(carpetMsgs).toHaveLength(0);
    });

    it('always emits areaMappingsLoaded, even with no persisted mappings (sends {})', () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const areaMsgs = sent.filter((m) => m.type === 'areaMappingsLoaded');
      expect(areaMsgs).toHaveLength(1);
      expect((areaMsgs[0] as { mappings: Record<string, string[]> }).mappings).toEqual({});
    });
  });
});

describe('clientMessageHandler: saveAgentSeats palette sync', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-seats-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('syncs in-range palette/hueShift onto the matching AgentState', () => {
    store.set(1, createTestAgent({ id: 1 }));
    store.set(2, createTestAgent({ id: 2, palette: 0, hueShift: 0 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: {
          '1': { palette: 4, hueShift: 120, seatId: 'seat-a' },
          '2': { palette: 2, hueShift: 60, seatId: 'seat-b' },
        },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(4);
    expect(store.get(1)?.hueShift).toBe(120);
    expect(store.get(2)?.palette).toBe(2);
    expect(store.get(2)?.hueShift).toBe(60);
  });

  it('cannot change the look of a rostered agent, but still saves its seat (R3)', () => {
    store.set(1, createTestAgent({ id: 1, palette: 2, hueShift: 40, rosterId: 'm1' }));

    handleClientMessage(
      { type: 'saveAgentSeats', seats: { '1': { palette: 4, hueShift: 120, seatId: 'seat-a' } } },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(2);
    expect(store.get(1)?.hueShift).toBe(40);
    expect(store.getAdapter()?.loadSeats()['s:sess-1']).toEqual({ seatId: 'seat-a' });
  });

  describe('seats across a restart', () => {
    const existingAgentMeta = (restarted: AgentStateStore) => {
      const out: Array<Record<string, unknown>> = [];
      handleClientMessage({ type: 'webviewReady' }, (m) => out.push(m), {
        store: restarted,
        cache: null,
      });
      const existing = out.find((m) => m.type === 'existingAgents') as {
        agentMeta: Record<number, { seatId?: string }>;
      };
      return existing.agentMeta;
    };

    it('each agent gets the seat of its session when the ids come back swapped', () => {
      store.set(1, createTestAgent({ id: 1, sessionId: 'sess-A' }));
      store.set(2, createTestAgent({ id: 2, sessionId: 'sess-B' }));
      handleClientMessage(
        {
          type: 'saveAgentSeats',
          seats: { '1': { seatId: 'seat-of-A' }, '2': { seatId: 'seat-of-B' } },
        },
        (m) => sent.push(m),
        ctx,
      );

      const restarted = new AgentStateStore();
      restarted.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
      restarted.set(1, createTestAgent({ id: 1, sessionId: 'sess-B' }));
      restarted.set(2, createTestAgent({ id: 2, sessionId: 'sess-A' }));
      const meta = existingAgentMeta(restarted);
      restarted.dispose();

      expect(meta[1].seatId).toBe('seat-of-B');
      expect(meta[2].seatId).toBe('seat-of-A');
    });

    it('a seat saved under an old numeric id is ignored, not given to whoever holds that id', () => {
      store.getAdapter()?.saveSeats({ '1': { seatId: 'stale-seat' } });
      const restarted = new AgentStateStore();
      restarted.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
      restarted.set(1, createTestAgent({ id: 1, sessionId: 'sess-new' }));
      const meta = existingAgentMeta(restarted);
      restarted.dispose();

      expect(meta[1].seatId).toBeUndefined();
    });
  });

  it('drops an out-of-range palette and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 1, hueShift: 10 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 99, hueShift: 50, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(1);
    // hueShift 50 is in range → still synced.
    expect(store.get(1)?.hueShift).toBe(50);
  });

  it('drops a negative hue shift and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 0, hueShift: 30 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 2, hueShift: -5, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    // palette 2 is in range → synced.
    expect(store.get(1)?.palette).toBe(2);
    expect(store.get(1)?.hueShift).toBe(30);
  });

  it('drops a non-integer palette and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 5, hueShift: 0 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 2.5, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(5);
    expect(store.get(1)?.hueShift).toBe(90);
  });

  it('accepts the upper hue boundary (360) and lower palette boundary (0)', () => {
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 0, hueShift: 360, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(0);
    expect(store.get(1)?.hueShift).toBe(360);
  });

  it('silently skips seat entries for unknown agent ids', () => {
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '999': { palette: 3, hueShift: 100, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(999)).toBeUndefined();
  });

  it('accepts palette 7 when the cache has 8 character sprites', () => {
    // The guard reads ctx.cache?.characters?.characters.length instead
    // of hardcoding PALETTE_COUNT. With 8 sprites, palette 7 is valid.
    const cache: AssetCache = {
      characters: {
        characters: [
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
        ],
      },
      pets: null,
      floorTiles: null,
      wallTiles: null,
      carpetTiles: null,
      furniture: null,
      defaultLayout: null,
    };
    ctx = freshCtx(cache);
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 7, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(7);
    // palette 8 is still out of range for 8 sprites → dropped.
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 8, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );
    expect(store.get(1)?.palette).toBe(7);
  });
});

describe('clientMessageHandler: ackTripwire', () => {
  let store: AgentStateStore;
  let socketA: Array<Record<string, unknown>>;
  let socketB: Array<Record<string, unknown>>;
  const alarm = {
    ruleId: 'dotenv',
    ruleName: 'Dotenv file access',
    severity: 'medium',
    since: 1_000,
  } as const;

  const ack = (id: number, count: number): void =>
    handleClientMessage({ type: 'ackTripwire', id, count }, () => {}, { store, cache: null });

  beforeEach(() => {
    store = new AgentStateStore();
    socketA = [];
    socketB = [];
    // Each open socket subscribes to the store's broadcasts (see httpServer).
    store.on('broadcast', (m) => socketA.push(m));
    store.on('broadcast', (m) => socketB.push(m));
  });

  it('clears the alarm and tells every socket when the ack covers the count', () => {
    store.set(1, createTestAgent({ id: 1, tripwire: { ...alarm, count: 2 } }));
    ack(1, 2);

    expect(store.get(1)?.tripwire).toBeUndefined();
    expect(socketA).toEqual([{ type: 'agentTripwireClear', id: 1 }]);
    expect(socketB).toEqual([{ type: 'agentTripwireClear', id: 1 }]);

    // The next hit starts a fresh count.
    const rule = DEFAULT_TRIPWIRE_RULES.find((r) => r.id === 'dotenv')!;
    expect(applyTripwireHit(store.get(1)!, rule)).toMatchObject({ count: 1 });
  });

  it('does not clear on a stale ack and re-sends the current state', () => {
    store.set(1, createTestAgent({ id: 1, tripwire: { ...alarm, count: 3 } }));
    ack(1, 2);

    expect(store.get(1)?.tripwire?.count).toBe(3);
    expect(socketA).toEqual([{ type: 'agentTripwire', id: 1, ...alarm, count: 3 }]);
    expect(socketB).toHaveLength(1);
  });

  it('ignores an unknown agent, an agent without an alarm and a malformed ack', () => {
    store.set(1, createTestAgent({ id: 1 }));
    expect(() => ack(99, 1)).not.toThrow();
    ack(1, 1);
    handleClientMessage({ type: 'ackTripwire', id: '1', count: 'x' }, () => {}, {
      store,
      cache: null,
    });
    expect(socketA).toEqual([]);
  });
});

describe('clientMessageHandler: token ledger', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let refreshed: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-ledger-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    refreshed = [];
    // Real ledger over an empty temp root: nothing is read from the real home directory.
    const tokenLedger = new TokenLedger({
      source: claudeProvider.transcriptUsage as NonNullable<typeof claudeProvider.transcriptUsage>,
      root: path.join(tempHome, 'projects'),
      cachePath: path.join(tempHome, 'ledger-cache.json'),
      getAreaMappings: () => ({}),
      getBudgets: () => {
        const { tokenBudget5h, tokenBudgetWeek } = readConfig().standalone;
        return { budget5h: tokenBudget5h, budgetWeek: tokenBudgetWeek };
      },
      onChange: (m) => refreshed.push({ ...m }),
    });
    ctx = { store, cache: null, tokenLedger };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('sends a scanning tokenUsage on connect, after the area mappings', () => {
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
    const types = sent.map((m) => m.type);
    expect(types.indexOf('tokenUsage')).toBeGreaterThan(types.indexOf('areaMappingsLoaded'));
    expect(sent.find((m) => m.type === 'tokenUsage')).toMatchObject({ scanning: true });
    expect(sent.find((m) => m.type === 'tokenUsage')).not.toHaveProperty('week');
  });

  it('persists positive budgets, drops invalid ones, and pushes a fresh tokenUsage', () => {
    handleClientMessage(
      { type: 'setTokenBudgets', budget5h: 5_000_000, budgetWeek: 'lots' },
      (m) => sent.push(m),
      ctx,
    );
    expect(readConfig().standalone.tokenBudget5h).toBe(5_000_000);
    expect(readConfig().standalone).not.toHaveProperty('tokenBudgetWeek');
    expect(refreshed.at(-1)).toMatchObject({ budget5h: 5_000_000 });

    handleClientMessage({ type: 'setTokenBudgets', budget5h: 0 }, (m) => sent.push(m), ctx);
    expect(readConfig().standalone).not.toHaveProperty('tokenBudget5h');
    expect(refreshed.at(-1)).not.toHaveProperty('budget5h');
  });

  // A reload shows the official limits this process already holds, or that it receives them at all, without waiting
  // for the next status line post.
  it('sends the official limits on connect: an empty reading first, then what the store holds', () => {
    const usageLimits = new UsageLimitsStore(store);
    const connect = (): Array<Record<string, unknown>> => {
      const out: Array<Record<string, unknown>> = [];
      handleClientMessage({ type: 'webviewReady' }, (m) => out.push(m), { ...ctx, usageLimits });
      return out.filter((m) => m.type === 'usageLimits');
    };

    expect(connect()).toEqual([
      { type: 'usageLimits', receivedAt: 0, fiveHour: null, sevenDay: null },
    ]);

    const receivedAt = Date.parse('2026-10-12T12:00:00Z');
    usageLimits.set(
      { fiveHour: { usedPercentage: 37, resetsAt: receivedAt / 1000 + 3600 }, sevenDay: null },
      receivedAt,
    );

    expect(connect()).toEqual([
      {
        type: 'usageLimits',
        receivedAt,
        fiveHour: { usedPercentage: 37, resetsAt: receivedAt + 3_600_000 },
        sevenDay: null,
      },
    ]);
  });
});
