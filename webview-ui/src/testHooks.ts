import { closeSheet, openSheet } from './components/inspector/sheetControl.js';
import type { ColorValue } from './components/ui/types.js';
import { type FrameCounters, requestRedraw } from './office/engine/gameLoop.js';
import { OfficeState } from './office/engine/officeState.js';
import {
  isGhostHeadlessAgentsEnabled,
  lastDrawnCrewLines,
  lastDrawnDeskHighlights,
} from './office/engine/renderer.js';
import { lastMonitorTagLayout, type TagLayoutSnapshot } from './office/monitorTags.js';
import { carpetJunctionCase } from './office/sprites/carpetTiles.js';

declare global {
  interface Window {
    /** Re-renders the monitor panels asked for (useMonitorVersion): one per frame that found the
     *  monitor stores or the selection changed, none on a quiet frame. Read deltas. */
    __pixelAgentsMonitorRenders?: number;
    __pixelAgentsTestHooks?: {
      playedSounds?: Array<{ kind: string; at: number }>;
      getCharacters?: () => Array<{
        id: number;
        matrixEffect: 'spawn' | 'despawn' | null;
        agentName?: string;
        bubbleType: 'permission' | 'waiting' | null;
        waitingAwaitingInput?: boolean;
        isHeadless?: boolean;
        isGreeter?: boolean;
      }>;
      /** Effective "Display headless as ghosts" setting the renderer is using. */
      getGhostHeadlessAgents?: () => boolean;
      // ── Carpet + Areas observability (added for carpet/areas e2e) ──
      /** Sparse list of painted carpet tiles with their grid coords. */
      getCarpetTiles?: () => Array<{
        col: number;
        row: number;
        variant: number;
        color?: ColorValue;
        accentColor?: ColorValue;
        order?: number;
      }>;
      /** 4-bit marching-squares case for a junction (NW=1,NE=2,SE=4,SW=8) via the
       *  real renderer logic — for asserting carpet autotiling. */
      getCarpetJunctionCase?: (jx: number, jy: number, variant: number) => number;
      /** Area definitions in the current layout. */
      getAreas?: () => Array<{ label: string; color: string }>;
      /** Sparse list of area-painted tiles with their grid coords. */
      getAreaTiles?: () => Array<{ col: number; row: number; label: string }>;
      /** Folder→Area mappings received by OfficeState. */
      getAreaMappings?: () => Record<string, string[]>;
      /** Effective show-areas gate (settings toggle OR active area edit). */
      getShowAreas?: () => boolean;
      /** Count of placed furniture instances — lets a spec assert furniture
       *  placed onto a carpet tile (surface placement) without it being blocked. */
      getFurnitureCount?: () => number;
      /** Seated top-level agents with the area their seat falls in (or null). */
      getAgentSeats?: () => Array<{
        id: number;
        seatId: string | null;
        areaLabel: string | null;
        folderName?: string;
      }>;
      /** All seats with grid coords + the area their tile falls in — lets a spec
       *  paint an Area over a known seat without hardcoding layout coordinates. */
      getSeats?: () => Array<{
        uid: string;
        col: number;
        row: number;
        areaLabel: string | null;
        assigned: boolean;
      }>;
      /** Drive the real edit-mode tile paint/erase handlers by (col,row),
       *  bypassing only canvas pixel→tile geometry (mirrors petClick). */
      editorTileAction?: (col: number, row: number) => void;
      editorEraseAction?: (col: number, row: number) => void;
      getPets?: () => Array<{
        id: string;
        name: string;
        petType: number;
        state: 'idle' | 'walk' | 'follow' | 'sleep';
        x: number;
        y: number;
        bubbleType: 'heart' | null;
      }>;
      petClick?: (petId: string) => void;
      addAgentLog?: Array<{
        id: number;
        skipSpawnEffect: boolean | undefined;
        matrixEffectAtCreation: 'spawn' | 'despawn' | null;
      }>;
      messageLog?: Array<{
        at: number;
        type: string;
        id?: number;
        toolName?: string;
        status?: string;
        toolId?: string;
        parentToolId?: string;
      }>;
      selectAgent?: (id: number | null) => void;
      /** The office's selection and camera follow, as a click (canvas or rail) left them. */
      getSelection?: () => { selectedAgentId: number | null; cameraFollowId: number | null };
      /** The crew lines the last drawn frame drew (canvas only, so e2e reads them here). */
      getCrewLines?: () => ReadonlyArray<{
        leadId: number;
        helperId: number;
        kind: 'crew' | 'sub';
      }>;
      /** The lit desks the last drawn frame drew (canvas only): world px, tone, blink frame, and
       *  the desk unit as the canvas drew it in page CSS px (what a DOM tag is measured against). */
      getDeskHighlights?: () => ReadonlyArray<{
        id: number;
        tone: 'wait' | 'stuck';
        rect: { x: number; y: number; w: number; h: number };
        frame: 0 | 1;
        page: { x: number; y: number; w: number; h: number } | null;
      }>;
      /** Beside the rail, what the last overlay render placed (page CSS px): the tags, every face
       *  (canvas, so no DOM), the rooms a tag may fill, the crew banners with their wall band, the
       *  room plaques. */
      getTagLayout?: () => TagLayoutSnapshot;
      /** Dev scenes only (`&camera=`): centre a named Area in the stage; false when there is none. */
      fitArea?: (name: string) => boolean;
      /** Open or close the inspector sheet the way the keys do (sheetControl.ts). */
      openSheet?: () => void;
      closeSheet?: () => void;
      /** Render loop counters (gameLoop.ts installs them when it loads): read deltas, never absolutes. */
      frames?: FrameCounters;
    };
  }
}

/**
 * Install e2e test observables on window.__pixelAgentsTestHooks. Mostly
 * read-only / append-only; the one action (selectAgent) only sets selection
 * state and changes no production logic. Called once at module-load from
 * App.tsx with the singleton officeStateRef.
 *
 * - getCharacters(): point-in-time snapshot of every character's matrix, team, and bubble state.
 * - addAgentLog: append-only history of every OfficeState.addAgent call. The
 *   log captures matrixEffect AT addAgent time (synchronously inside the
 *   wrapper), eliminating the ~300ms matrix-effect lifetime race that would
 *   let a regression slip past a snapshot-based check.
 * - playedSounds: populated separately by notificationSound.ts (same namespace,
 *   different owner).
 * - selectAgent(id): sets officeState.selectedAgentId directly, the same state
 *   a canvas click produces. Lets e2e reveal an agent's "Close agent" (×)
 *   button deterministically instead of pixel-hunting the sprite on the canvas
 *   (see closeAgentFromOverlay in e2e/helpers/office.ts). It wakes the render
 *   loop, and ToolOverlay re-renders on the frame drawn next, so the × button
 *   surfaces then.
 */
export function installTestHooks(officeStateRef: { current: OfficeState | null }): void {
  if (typeof window === 'undefined') return;
  if (!window.__pixelAgentsTestHooks) window.__pixelAgentsTestHooks = {};
  const hooks = window.__pixelAgentsTestHooks;
  if (!hooks.addAgentLog) hooks.addAgentLog = [];
  // From 0, so a spec reading a delta never mistakes "no render yet" for a missing counter.
  window.__pixelAgentsMonitorRenders ??= 0;

  hooks.getCharacters = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    // getCharacters(), not `characters`: e2e asserts on the consent greeter,
    // which lives outside the agent map and joins only at the render seam.
    return os.getCharacters().map((ch) => ({
      id: ch.id,
      matrixEffect: ch.matrixEffect,
      agentName: ch.agentName,
      bubbleType: ch.bubbleType,
      waitingAwaitingInput: ch.waitingAwaitingInput,
      isHeadless: ch.isHeadless,
      isGreeter: ch.isGreeter,
    }));
  };

  // The ghost setting lives in the renderer module (read on every drawn frame), not
  // in OfficeState, so e2e reads it from there to assert what is actually drawn.
  hooks.getGhostHeadlessAgents = () => isGhostHeadlessAgentsEnabled();

  hooks.getSelection = () => {
    const os = officeStateRef.current;
    return {
      selectedAgentId: os?.selectedAgentId ?? null,
      cameraFollowId: os?.cameraFollowId ?? null,
    };
  };

  hooks.getCrewLines = () =>
    lastDrawnCrewLines().map((l) => ({ leadId: l.leadId, helperId: l.helperId, kind: l.kind }));

  hooks.getDeskHighlights = () => {
    // The office canvas is the page's biggest: device px over the ratio, from its page corner.
    const canvas = Array.from(document.querySelectorAll('canvas')).sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0];
    const at = canvas?.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return lastDrawnDeskHighlights().map((h) => ({
      id: h.id,
      tone: h.tone,
      rect: h.rect,
      frame: h.frame,
      page: at
        ? {
            x: at.left + h.dev.x / dpr,
            y: at.top + h.dev.y / dpr,
            w: h.dev.w / dpr,
            h: h.dev.h / dpr,
          }
        : null,
    }));
  };

  hooks.getTagLayout = () => lastMonitorTagLayout();

  hooks.selectAgent = (id) => {
    const os = officeStateRef.current;
    if (os) os.selectedAgentId = id;
    requestRedraw();
  };

  hooks.openSheet = () => {
    const os = officeStateRef.current;
    if (os) openSheet(os);
  };
  hooks.closeSheet = () => {
    const os = officeStateRef.current;
    if (os) closeSheet(os);
  };

  // Point-in-time snapshot of every live pet. Pets render only on the canvas
  // (no DOM) and the heart bubble is never persisted, so e2e reads pet state
  // through here — the same rationale as getCharacters() above.
  hooks.getPets = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    return os.pets.map((pet) => ({
      id: pet.id,
      name: pet.name,
      petType: pet.petType,
      state: pet.state,
      x: pet.x,
      y: pet.y,
      bubbleType: pet.bubbleType,
    }));
  };

  // Drive the same state a canvas click on a pet produces (toggle the heart
  // bubble). Mirrors OfficeCanvas's pet-hit branch but takes a known petId
  // instead of a hit-test result, so tests don't pixel-hunt the randomly
  // spawned sprite — the same tradeoff selectAgent makes for characters.
  hooks.petClick = (petId) => {
    const os = officeStateRef.current;
    if (!os) return;
    const pet = os.pets.find((p) => p.id === petId);
    if (!pet) return;
    if (pet.bubbleType) {
      os.dismissPetBubble(petId);
    } else {
      os.showPetBubble(petId);
    }
    requestRedraw();
  };

  // ── Carpet + Areas read hooks (canvas-only state, read like getPets) ──
  hooks.getCarpetTiles = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    const layout = os.getLayout();
    const tiles = layout.carpetTiles;
    if (!tiles) return [];
    const out: Array<{
      col: number;
      row: number;
      variant: number;
      color?: ColorValue;
      accentColor?: ColorValue;
      order?: number;
    }> = [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!t) continue;
      out.push({
        col: i % layout.cols,
        row: Math.floor(i / layout.cols),
        variant: t.variant,
        color: t.color,
        accentColor: t.accentColor,
        order: t.order,
      });
    }
    return out;
  };

  hooks.getCarpetJunctionCase = (jx, jy, variant) => {
    const os = officeStateRef.current;
    if (!os) return 0;
    const layout = os.getLayout();
    return carpetJunctionCase(jx, jy, variant, layout.carpetTiles ?? [], layout.cols, layout.rows);
  };

  hooks.getAreas = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    return (os.getLayout().areas ?? []).map((a) => ({ label: a.label, color: a.color }));
  };

  hooks.getAreaTiles = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    const layout = os.getLayout();
    const tiles = layout.areaTiles;
    if (!tiles) return [];
    const out: Array<{ col: number; row: number; label: string }> = [];
    for (let i = 0; i < tiles.length; i++) {
      const label = tiles[i];
      if (!label) continue;
      out.push({ col: i % layout.cols, row: Math.floor(i / layout.cols), label });
    }
    return out;
  };

  hooks.getAreaMappings = () => {
    const os = officeStateRef.current;
    if (!os) return {};
    return os.areaMappings;
  };

  hooks.getFurnitureCount = () => {
    const os = officeStateRef.current;
    if (!os) return 0;
    return os.furniture.length;
  };

  hooks.getAgentSeats = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    return Array.from(os.characters.values())
      .filter((ch) => !ch.isSubagent)
      .map((ch) => ({
        id: ch.id,
        seatId: ch.seatId,
        areaLabel: ch.seatId ? os.seatZone(ch.seatId) : null,
        folderName: ch.folderName,
      }));
  };

  hooks.getSeats = () => {
    const os = officeStateRef.current;
    if (!os) return [];
    return Array.from(os.seats.entries()).map(([uid, seat]) => ({
      uid,
      col: seat.seatCol,
      row: seat.seatRow,
      areaLabel: os.seatZone(uid),
      assigned: seat.assigned,
    }));
  };

  const origAddAgent = OfficeState.prototype.addAgent;
  OfficeState.prototype.addAgent = function (
    id,
    preferredPalette,
    preferredHueShift,
    preferredSeatId,
    skipSpawnEffect,
    folderName,
    nearAgentId,
  ) {
    origAddAgent.call(
      this,
      id,
      preferredPalette,
      preferredHueShift,
      preferredSeatId,
      skipSpawnEffect,
      folderName,
      nearAgentId,
    );
    const ch = this.characters.get(id);
    hooks.addAgentLog?.push({
      id,
      skipSpawnEffect,
      matrixEffectAtCreation: ch?.matrixEffect ?? null,
    });
  };
}
