import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CacheTtlSeconds,
  HealthReason,
  HealthState,
  HooksConsentRequest,
  PermissionMode,
  TokenUsage,
  UsageLimits,
} from '../../../core/src/messages.js';
import type { ModelTier } from '../../../core/src/provider.js';
import { areaShares } from '../components/usageView.js';
import {
  playAlarmSound,
  playDoneSound,
  playPermissionSound,
  setSoundEnabled,
} from '../notificationSound.js';
import type { PendingAgent } from '../office/engine/existingAgents.js';
import { requestRedraw } from '../office/engine/gameLoop.js';
import type { OfficeState } from '../office/engine/officeState.js';
import {
  setCozyLighting as setRendererCozyLighting,
  setGhostHeadlessAgents as setRendererGhostHeadlessAgents,
  setShowModelFlair as setRendererShowModelFlair,
} from '../office/engine/renderer.js';
import { setFloorSprites } from '../office/floorTiles.js';
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js';
import { setCarpetSprites } from '../office/sprites/carpetTiles.js';
import { setPetTemplates } from '../office/sprites/petSpriteData.js';
import { setCharacterTemplates } from '../office/sprites/spriteData.js';
import { setProviderCapabilities } from '../office/toolUtils.js';
import type { OfficeLayout, ToolActivity } from '../office/types.js';
import { setWallSprites } from '../office/wallTiles.js';
import { isE2E } from '../runtime.js';
import { transport } from '../transport/index.js';
import {
  type AgentListSink,
  applyAgentClosed,
  applyAgentTeamInfo,
  applyExistingAgents,
  applyHandshakeDone,
  isHeadlessAgent,
} from './agentListMessages.js';
import {
  applyAgentStatusMessage,
  applyAgentToolStart,
  applyAgentTripwireMessage,
} from './agentMessages.js';
import { admitLayoutLoaded } from './layoutLoadedGate.js';
import { applyMonitorMessage } from './monitorMessages.js';
import {
  applySubagentMessage,
  applyToolStartHelper,
  type SubagentCharacter,
  type SubagentSink,
} from './subagentMessages.js';

/**
 * Every host message wakes the render loop: it may change what the office shows. A type listed
 * here does not, for a periodic message that would otherwise keep a quiet office drawing at full
 * rate; what it changes shows on the next idle redraw.
 * - tokenUsage: the ledger re-sends it every 30 s even when nothing is used, since its windows
 *   move with the clock. The Usage panel is DOM, and the room-sign bars can wait a second.
 * - usageLimits: every open Claude Code session re-posts its status line, idle ones included, and
 *   each accepted post is broadcast. Only the DOM reads it (the Usage panel, the HUD card).
 */
const NO_WAKE_MESSAGE_TYPES: ReadonlySet<string> = new Set<string>(['tokenUsage', 'usageLimits']);

interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface WorkspaceFolder {
  name: string;
  path: string;
}

interface ExtensionMessageState {
  agents: number[];
  selectedAgent: number | null;
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  layoutReady: boolean;
  layoutWasReset: boolean;
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> };
  workspaceFolders: WorkspaceFolder[];
  /** Distinct folderNames seen across agents this session — source for the Areas folder dropdown. */
  agentFolderNames: string[];
  externalAssetDirectories: string[];
  lastSeenVersion: string;
  extensionVersion: string;
  watchAllSessions: boolean;
  setWatchAllSessions: (v: boolean) => void;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  setGhostHeadlessAgents: (v: boolean) => void;
  showModelFlair: boolean;
  setShowModelFlair: (v: boolean) => void;
  cozyLighting: boolean;
  setCozyLighting: (v: boolean) => void;
  hooksEnabled: boolean;
  setHooksEnabled: (v: boolean) => void;
  /** Actual install state per provider (hooksStatus messages) — absent/false
   *  while first-run consent is pending, unlike hooksEnabled which defaults
   *  true. Keyed by providerId; today's Settings checkbox reads 'claude'. */
  hooksInstalled: Record<string, boolean>;
  /** Bumped per provider on every hooksStatus message. `hooksInstalled` alone cannot say "the server answered": a
   *  failed install re-reports the `false` already held, so no effect runs. The Intro needs the ARRIVAL to tell a
   *  pending install from a failed one, per provider — A's status is never a verdict on B's install. */
  hooksStatusSeq: Record<string, number>;
  hooksInfoShown: boolean;
  /** First-run consent ask (hooksConsentRequest). Non-null while the server waits on an answer; carries the provider
   *  and the server's exact disclosure copy, so the consent step renders the terms being approved with no client
   *  duplicate to drift. Cleared on answer/dismissal, and by a matching provider's hooksStatus installed=true. */
  consentRequest: HooksConsentRequest | null;
  dismissConsentRequest: (providerId: string | null) => void;
  // Areas
  areaMappings: Record<string, string[]>;
  setAreaMappings: (m: Record<string, string[]>) => void;
  showAreas: boolean;
  setShowAreas: (v: boolean) => void;
  /** Latest token ledger aggregate (tokenUsage), null until the first one arrives. */
  tokenUsage: TokenUsage | null;
  /** Latest official limits (usageLimits), null until the server says it receives them: a VS Code window reusing
   *  another window's server never gets one. */
  usageLimits: UsageLimits | null;
}

function saveAgentSeats(os: OfficeState): void {
  transport.send({ type: 'saveAgentSeats', seats: os.getPersistableSeats() });
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null);
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({});
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({});
  const [subagentTools, setSubagentTools] = useState<
    Record<number, Record<string, ToolActivity[]>>
  >({});
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([]);
  const [layoutReady, setLayoutReady] = useState(false);
  const [layoutWasReset, setLayoutWasReset] = useState(false);
  const [loadedAssets, setLoadedAssets] = useState<
    { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined
  >();
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  const [agentFolderNames, setAgentFolderNames] = useState<string[]>([]);
  const [externalAssetDirectories, setExternalAssetDirectories] = useState<string[]>([]);
  const [lastSeenVersion, setLastSeenVersion] = useState('');
  const [extensionVersion, setExtensionVersion] = useState('');
  const [watchAllSessions, setWatchAllSessions] = useState(false);
  const [alwaysShowLabels, setAlwaysShowLabels] = useState(false);
  const [ghostHeadlessAgents, setGhostHeadlessAgentsState] = useState(false);
  const [showModelFlair, setShowModelFlairState] = useState(true);
  const [cozyLighting, setCozyLightingState] = useState(true);
  const [hooksEnabled, setHooksEnabled] = useState(true);
  const [hooksInstalled, setHooksInstalled] = useState<Record<string, boolean>>({});
  const [hooksStatusSeq, setHooksStatusSeq] = useState<Record<string, number>>({});
  const [hooksInfoShown, setHooksInfoShown] = useState(true);
  // FIFO of pending consent asks, at most one per provider (consentAskSeenRef admits one per page load). The HEAD is
  // what the Intro renders; answering, dismissing, or mooting it advances to the next provider's ask rather than
  // dropping it: the server sends one request per provider on the same handshake.
  const [consentQueue, setConsentQueue] = useState<HooksConsentRequest[]>([]);
  const consentRequest = consentQueue[0] ?? null;
  const [areaMappings, setAreaMappings] = useState<Record<string, string[]>>({});
  const [showAreas, setShowAreas] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [usageLimits, setUsageLimits] = useState<UsageLimits | null>(null);

  // The renderer keeps its own module-level copy (read on every drawn frame), so both
  // sources of truth move together — the persisted value on settingsLoaded and
  // the user's click in Settings. A quiet office draws rarely, so each setter wakes it.
  const applyGhostHeadlessAgents = useCallback((enabled: boolean) => {
    setGhostHeadlessAgentsState(enabled);
    setRendererGhostHeadlessAgents(enabled);
    requestRedraw();
  }, []);

  // Same pairing as the ghost setting: the renderer reads its own copy every frame.
  const applyShowModelFlair = useCallback((enabled: boolean) => {
    setShowModelFlairState(enabled);
    setRendererShowModelFlair(enabled);
    requestRedraw();
  }, []);

  // Same pairing: the tint is React (DOM div), the glows read the renderer's copy each frame.
  const applyCozyLighting = useCallback((enabled: boolean) => {
    setCozyLightingState(enabled);
    setRendererCozyLighting(enabled);
    requestRedraw();
  }, []);

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false);

  // Live background spawn tools per agent (runInBackground agentToolStart, or a
  // lazily-created watched sub). Their sub-characters outlive the parent's turn:
  // agentToolsClear must NOT remove them — despawning and re-creating moved the
  // character to a new tile every turn. Cleared by subagentClear/agentClosed.
  const backgroundParentToolIdsRef = useRef<Record<number, Set<string>>>({});

  // Each agent's team as its latest agentTeamInfo said, read by the resync's helper sweep.
  // A ref mirrored on write: the handler below is bound once, so state it read would be
  // the mount-time value.
  const agentTeamInfoRef = useRef<Record<number, string | undefined>>({});

  // Providers whose consent ask already reached this page. The handshake after a
  // reconnect asks again; queueing that would replay an Intro the user already answered
  // or closed. An unanswered ask returns on the next page load.
  const consentAskSeenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: PendingAgent[] = [];

    // Accumulate distinct folderNames seen across agents (never removed during the
    // session): the source for the Areas folder-mapping dropdown, so a folder stays
    // editable even after its agents close.
    const noteFolderName = (name?: string) => {
      if (!name) return;
      setAgentFolderNames((prev) => (prev.includes(name) ? prev : [...prev, name]));
    };

    const subagentSink = (os: OfficeState): SubagentSink => ({
      os,
      background: backgroundParentToolIdsRef.current,
      updateTools: setSubagentTools,
      updateCharacters: setSubagentCharacters,
    });

    // Built per message: `pendingAgents` is replaced at every layoutLoaded.
    const agentListSink = (os: OfficeState): AgentListSink => ({
      ...subagentSink(os),
      teams: agentTeamInfoRef.current,
      pending: pendingAgents,
      layoutReady: layoutReadyRef.current,
      updateAgents: setAgents,
      updateSelectedAgent: setSelectedAgent,
      updateAgentTools: setAgentTools,
      updateAgentStatuses: setAgentStatuses,
      noteFolderName,
      saveSeats: () => saveAgentSeats(os),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (msg: any) => {
      if (!NO_WAKE_MESSAGE_TYPES.has(msg.type)) requestRedraw();
      const os = getOfficeState();
      // CI / e2e diagnostic: record every received transport message on the
      // window-side log. The fixture reads window.__pixelAgentsTestHooks.
      // messageLog and attaches as JSON so CI failures can see the exact
      // sequence of messages the webview actually processed. Gated on the e2e
      // harness flag so this unbounded log never grows in a real session.
      if (isE2E && typeof window !== 'undefined') {
        if (!window.__pixelAgentsTestHooks) window.__pixelAgentsTestHooks = {};
        if (!window.__pixelAgentsTestHooks.messageLog) {
          window.__pixelAgentsTestHooks.messageLog = [];
        }
        window.__pixelAgentsTestHooks.messageLog.push({
          at: Date.now(),
          type: msg.type,
          id: msg.id,
          toolName: msg.toolName,
          status: msg.status,
          toolId: msg.toolId,
          parentToolId: msg.parentToolId,
        });
      }

      // The monitor messages and the `since` fields: stored by id, read by the monitor panels.
      applyMonitorMessage(os, msg);

      if (msg.type === 'providerCapabilities') {
        setProviderCapabilities({
          readingTools: msg.readingTools,
          subagentToolNames: msg.subagentToolNames,
        });
        return;
      }

      if (msg.type === 'layoutLoaded') {
        if (!admitLayoutLoaded(msg)) {
          console.log(
            '[Webview] Skipping layout update: unsaved editor changes, or a resync restating the current layout',
          );
          return;
        }
        const rawLayout = msg.layout as OfficeLayout | null;
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null;
        if (layout) {
          os.rebuildFromLayout(layout);
          onLayoutLoaded?.(layout);
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout());
        }
        // Add buffered agents now that layout (and seats) are correct
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName, undefined, false);
          if (p.isHeadless) os.setHeadless(p.id, true);
        }
        pendingAgents = [];
        layoutReadyRef.current = true;
        setLayoutReady(true);
        if (msg.wasReset) {
          setLayoutWasReset(true);
        }
        if (os.characters.size > 0) {
          saveAgentSeats(os);
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number;
        const folderName = msg.folderName as string | undefined;
        const isTeammate = msg.isTeammate as boolean | undefined;
        const teammateName = msg.teammateName as string | undefined;
        const teammateParentId = msg.parentAgentId as number | undefined;
        const teamName = msg.teamName as string | undefined;
        // Adopted sessions have an unknown status: idle until the server says
        // otherwise. Terminals launched from the UI start working.
        const isExternalAgent = msg.isExternal === true;
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]));
        // Don't auto-select teammates (keep focus on lead)
        if (!isTeammate) {
          setSelectedAgent(id);
        }
        if (isTeammate && teammateParentId !== undefined) {
          // Teammate: inherit parent's palette and workspace folderName (teammate runs
          // in the same workspace as the lead). Name shown via agentName (teamRoleLabel).
          // Seat them at the free seat closest to the lead so the team clusters.
          const parentCh = os.characters.get(teammateParentId);
          const palette = parentCh ? parentCh.palette : undefined;
          const hueShift = parentCh ? parentCh.hueShift : undefined;
          os.addAgent(
            id,
            palette,
            hueShift,
            undefined,
            undefined,
            parentCh?.folderName,
            teammateParentId,
            !isExternalAgent,
          );
          noteFolderName(parentCh?.folderName);
          // Set team metadata on the character
          const ch = os.characters.get(id);
          if (ch) {
            ch.leadAgentId = teammateParentId;
            ch.teamName = teamName ?? parentCh?.teamName;
            ch.agentName = teammateName;
          }
        } else {
          const palette = msg.palette as number | undefined;
          const hueShift = msg.hueShift as number | undefined;
          os.addAgent(
            id,
            palette,
            hueShift,
            undefined,
            undefined,
            folderName,
            undefined,
            !isExternalAgent,
          );
          noteFolderName(folderName);
          if (isHeadlessAgent(msg.isExternal as boolean | undefined)) {
            os.setHeadless(id, true);
          }
        }
        saveAgentSeats(os);
      } else if (msg.type === 'agentClosed') {
        applyAgentClosed(agentListSink(os), msg);
      } else if (msg.type === 'existingAgents') {
        applyExistingAgents(agentListSink(os), msg);
      } else if (msg.type === 'handshakeDone') {
        applyHandshakeDone(agentListSink(os));
      } else if (msg.type === 'agentToolStart') {
        applyAgentToolStart(os, setAgentTools, msg);
        // A Task/Agent tool draws its Subtask helper; the runInBackground routing lives there.
        applyToolStartHelper(subagentSink(os), msg);
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number;
        const toolId = msg.toolId as string;
        setAgentTools((prev) => {
          const list = prev[id];
          if (!list) return prev;
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          };
        });
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number;
        const bgSet = backgroundParentToolIdsRef.current[id];
        setAgentTools((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        // Keep sub-tool rows of live background spawns: their sub-characters
        // survive the parent's turn end and stay animated by their own activity.
        setSubagentTools((prev) => {
          const agentSubs = prev[id];
          if (!agentSubs) return prev;
          const kept: Record<string, ToolActivity[]> = {};
          for (const [parentToolId, rows] of Object.entries(agentSubs)) {
            if (bgSet?.has(parentToolId)) kept[parentToolId] = rows;
          }
          const next = { ...prev };
          if (Object.keys(kept).length === 0) {
            delete next[id];
          } else {
            next[id] = kept;
          }
          return next;
        });
        // Remove this agent's sub-agent characters, EXCEPT:
        // - team leads with inline teammates: their sub-agents represent real
        //   teammates, removed only by SubagentStop/subagentClear;
        // - live background spawns: removing + re-creating them on every turn
        //   end teleported the character (subagentClear removes them for real).
        const clearCh = os.characters.get(id);
        const hasInlineTeammates =
          clearCh?.teamName && clearCh?.isTeamLead && !clearCh?.teamUsesTmux;
        if (!hasInlineTeammates) {
          const doomed: string[] = [];
          for (const meta of os.subagentMeta.values()) {
            if (meta.parentAgentId === id && !bgSet?.has(meta.parentToolId)) {
              doomed.push(meta.parentToolId);
            }
          }
          for (const parentToolId of doomed) {
            os.removeSubagent(id, parentToolId);
          }
          setSubagentCharacters((prev) =>
            prev.filter((s) => s.parentAgentId !== id || bgSet?.has(s.parentToolId)),
          );
        }
        os.setAgentTool(id, null);
        os.clearPermissionBubble(id);
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number;
        setSelectedAgent(id);
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number;
        const status = msg.status as string;
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          }
          return { ...prev, [id]: status };
        });
        applyAgentStatusMessage(os, msg, playDoneSound);
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number;
        setAgentTools((prev) => {
          const list = prev[id];
          if (!list) return prev;
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          };
        });
        os.showPermissionBubble(id);
        playPermissionSound();
      } else if (
        msg.type === 'subagentToolStart' ||
        msg.type === 'subagentPresent' ||
        msg.type === 'subagentToolDone' ||
        msg.type === 'subagentClear' ||
        msg.type === 'subagentToolPermission'
      ) {
        applySubagentMessage(subagentSink(os), msg);
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number;
        setAgentTools((prev) => {
          const list = prev[id];
          if (!list) return prev;
          const hasPermission = list.some((t) => t.permissionWait);
          if (!hasPermission) return prev;
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          };
        });
        os.clearPermissionBubble(id);
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId);
          }
        }
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{
          down: string[][][];
          up: string[][][];
          right: string[][][];
        }>;
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`);
        setCharacterTemplates(characters);
      } else if (msg.type === 'petSpritesLoaded') {
        const pets = msg.pets;
        if (!Array.isArray(pets)) {
          return;
        }
        const petNames = Array.isArray(msg.petNames) ? (msg.petNames as string[]) : undefined;
        console.log(`[Webview] Received ${pets.length} pet sprites`);
        setPetTemplates(
          pets as Array<{
            walkDown: string[][][];
            idleDown: string[][][];
            walkUp: string[][][];
            idleUp: string[][][];
            walkRight: string[][][];
          }>,
          petNames,
        );
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][];
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`);
        setFloorSprites(sprites);
      } else if (msg.type === 'wallTilesLoaded') {
        const sets = msg.sets as string[][][][];
        console.log(`[Webview] Received ${sets.length} wall tile set(s)`);
        setWallSprites(sets);
      } else if (msg.type === 'carpetTilesLoaded') {
        const sets = msg.sets as string[][][][];
        console.log(`[Webview] Received ${sets.length} carpet variant(s)`);
        setCarpetSprites(sets);
      } else if (msg.type === 'areaMappingsLoaded') {
        const mappings = (msg.mappings ?? {}) as Record<string, string[]>;
        setAreaMappings(mappings);
        os.setAreaMappings(mappings);
      } else if (msg.type === 'tokenUsage') {
        const usage = msg as TokenUsage;
        setTokenUsage(usage);
        // Room signs show each Area's share of the current block; none while there is no block.
        os.setAreaUsage(areaShares(usage.block));
      } else if (msg.type === 'usageLimits') {
        setUsageLimits(msg as UsageLimits);
      } else if (msg.type === 'workspaceFolders') {
        const folders = msg.folders as WorkspaceFolder[];
        setWorkspaceFolders(folders);
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean;
        setSoundEnabled(soundOn);
        if (typeof msg.watchAllSessions === 'boolean') {
          setWatchAllSessions(msg.watchAllSessions as boolean);
        }
        if (typeof msg.alwaysShowLabels === 'boolean') {
          setAlwaysShowLabels(msg.alwaysShowLabels as boolean);
        }
        if (typeof msg.ghostHeadlessAgents === 'boolean') {
          applyGhostHeadlessAgents(msg.ghostHeadlessAgents as boolean);
        }
        if (typeof msg.showModelFlair === 'boolean') {
          applyShowModelFlair(msg.showModelFlair as boolean);
        }
        if (typeof msg.cozyLighting === 'boolean') {
          applyCozyLighting(msg.cozyLighting as boolean);
        }
        if (typeof msg.hooksEnabled === 'boolean') {
          setHooksEnabled(msg.hooksEnabled as boolean);
        }
        if (typeof msg.hooksInfoShown === 'boolean') {
          setHooksInfoShown(msg.hooksInfoShown as boolean);
        }
        if (typeof msg.showAreas === 'boolean') {
          setShowAreas(msg.showAreas as boolean);
        }
        if (Array.isArray(msg.externalAssetDirectories)) {
          setExternalAssetDirectories(msg.externalAssetDirectories as string[]);
        }
        if (typeof msg.lastSeenVersion === 'string') {
          setLastSeenVersion(msg.lastSeenVersion as string);
        }
        if (typeof msg.extensionVersion === 'string') {
          setExtensionVersion(msg.extensionVersion as string);
        }
      } else if (msg.type === 'hooksStatus') {
        if (typeof msg.installed === 'boolean' && typeof msg.providerId === 'string') {
          const providerId = msg.providerId as string;
          const installed = msg.installed as boolean;
          setHooksInstalled((m) => ({ ...m, [providerId]: installed }));
          setHooksStatusSeq((m) => ({ ...m, [providerId]: (m[providerId] ?? 0) + 1 }));
          if (installed) {
            // Moot once THIS provider's hooks are installed — the Settings toggle or another tab granted consent
            // while the dialog was open. Drop it from the queue (head or queued) rather than let a stale approval
            // re-install; another provider's status is not about this ask.
            setConsentQueue((q) => q.filter((r) => r.providerId !== providerId));
          }
        }
      } else if (msg.type === 'hooksConsentRequest') {
        if (
          typeof msg.providerId === 'string' &&
          typeof msg.headline === 'string' &&
          typeof msg.disclosure === 'string'
        ) {
          const providerId = msg.providerId as string;
          // Once per provider per page load: a reconnect's handshake asks again.
          if (consentAskSeenRef.current.has(providerId)) return;
          consentAskSeenRef.current.add(providerId);
          const request: HooksConsentRequest = {
            type: 'hooksConsentRequest',
            providerId,
            headline: msg.headline as string,
            disclosure: msg.disclosure as string,
            ...(typeof msg.replaceLegacyLabel === 'string'
              ? { replaceLegacyLabel: msg.replaceLegacyLabel }
              : {}),
          };
          setConsentQueue((q) => [...q, request]);
        }
      } else if (msg.type === 'externalAssetDirectoriesUpdated') {
        if (Array.isArray(msg.dirs)) {
          setExternalAssetDirectories(msg.dirs as string[]);
        }
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[];
          const sprites = msg.sprites as Record<string, string[][]>;
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`);
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites });
          setLoadedAssets({ catalog, sprites });
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err);
        }
      } else if (msg.type === 'agentTeamInfo') {
        applyAgentTeamInfo(agentListSink(os), msg);
      } else if (msg.type === 'agentContextUsage') {
        const id = msg.id as number;
        os.setAgentContext(id, msg.contextTokens as number, msg.maxContextTokens as number);
      } else if (msg.type === 'agentModel') {
        os.setAgentModel(
          msg.id as number,
          msg.model as string | undefined,
          msg.tier as ModelTier | undefined,
        );
      } else if (msg.type === 'agentSessionTitle') {
        os.setSessionTitle(msg.id as number, msg.title as string | undefined);
      } else if (msg.type === 'agentCache') {
        os.setAgentCache(
          msg.id as number,
          msg.ttlSeconds as CacheTtlSeconds | undefined,
          msg.expiresAt as number | undefined,
        );
      } else if (msg.type === 'agentMode') {
        os.setAgentMode(msg.id as number, msg.mode as PermissionMode | undefined);
      } else if (msg.type === 'agentShells') {
        os.setAgentShells(msg.id as number, msg.running as number);
      } else if (msg.type === 'agentTripwire') {
        applyAgentTripwireMessage(os, msg, playAlarmSound);
      } else if (msg.type === 'agentTripwireClear') {
        os.setTripwire(msg.id as number, undefined);
      } else if (msg.type === 'agentHealth') {
        os.setHealth(msg.id as number, {
          state: msg.state as HealthState,
          reason: msg.reason as HealthReason,
          count: msg.count as number,
        });
      } else if (msg.type === 'agentHealthClear') {
        os.setHealth(msg.id as number, undefined);
      } else if (msg.type === 'agentRoster') {
        os.setRoster(msg.id, {
          memberId: msg.memberId,
          name: msg.name,
          level: msg.level,
          xp: msg.xp,
          xpToNext: msg.xpToNext,
          streak: msg.streak,
          mood: msg.mood,
        });
      } else if (msg.type === 'rosterEvent') {
        os.setRosterEvent(msg.id, msg, Date.now());
      }
    };
    const unsubscribe = transport.onMessage(handler);
    transport.send({ type: 'webviewReady' });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getOfficeState]);

  // Idle sub-agent characters between their turns: when every tracked tool row
  // for a sub is done, stop its typing animation (a later subagentToolStart
  // reactivates it). Watched background sub-agents get a synthesized done for
  // each live tool at their turn end, so they sit idle instead of typing forever.
  useEffect(() => {
    const os = getOfficeState();
    for (const sub of subagentCharacters) {
      const rows = subagentTools[sub.parentAgentId]?.[sub.parentToolId];
      if (rows && rows.length > 0 && rows.every((t) => t.done)) {
        os.setAgentTool(sub.id, null);
        os.setAgentActive(sub.id, false);
        requestRedraw();
      }
    }
  }, [subagentTools, subagentCharacters, getOfficeState]);

  return {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    workspaceFolders,
    agentFolderNames,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    alwaysShowLabels,
    ghostHeadlessAgents,
    setGhostHeadlessAgents: applyGhostHeadlessAgents,
    showModelFlair,
    setShowModelFlair: applyShowModelFlair,
    cozyLighting,
    setCozyLighting: applyCozyLighting,
    hooksEnabled,
    hooksInstalled,
    hooksStatusSeq,
    setHooksEnabled,
    hooksInfoShown,
    consentRequest,
    // Called when a tour ends (answer + Let's Go, the X, Escape) with the providerId that tour was ABOUT, removing
    // that entry so the next provider's ask becomes the head. Keyed by id, not a blind shift: an answered ask's own
    // installed:true moot may already have removed the head, and a shift would then drop the NEXT provider's ask
    // unanswered. An aborted ask returns on the next page load (in-session reconnects are deduped by the webview);
    // the queue never re-adds it here.
    dismissConsentRequest: useCallback(
      (providerId: string | null) =>
        setConsentQueue((q) =>
          providerId === null ? q.slice(1) : q.filter((r) => r.providerId !== providerId),
        ),
      [],
    ),
    areaMappings,
    setAreaMappings,
    showAreas,
    setShowAreas,
    tokenUsage,
    usageLimits,
  };
}
