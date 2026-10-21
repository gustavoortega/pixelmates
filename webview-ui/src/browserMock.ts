/**
 * Browser runtime mock — fetches assets and injects the same postMessage
 * events the VS Code extension would send.
 *
 * In Vite dev, it prefers pre-decoded JSON endpoints from middleware.
 * In plain browser builds, it falls back to decoding PNGs at runtime.
 *
 * Only imported in browser runtime; tree-shaken from VS Code webview runtime.
 */

import type { RgbaImage } from '../../core/src/assets/artDensity.ts';
import {
  decodeCharacterSheet,
  decodeFloorTile,
  decodeFurnitureImage,
  decodePetSheet,
  decodeWallSet,
} from '../../core/src/assets/artDensity.ts';
import type {
  AssetIndex,
  CatalogEntry,
  CharacterDirectionSprites,
  PetSpriteFrames,
} from '../../core/src/assets/types.ts';
import {
  freezeHeroOffice,
  HERO_LAYOUT_PATH,
  heroMessages,
  type HeroOffice,
  type HeroSceneOptions,
  heroZoomFor,
  monitorHelperStart,
  monitorMessages,
  type MonitorSeating,
  parseHeroScene,
  parseMonitorScene,
  type SceneCamera,
  seatHeroAgents,
  seatMonitorCast,
  startHeroStage,
  startMonitorStage,
} from './heroScene.ts';
import {
  areaCenter,
  clampPan,
  panForPoint,
  type Point,
  type RoomLayout,
  roomsOf,
} from './office/camera.ts';

interface MockPayload {
  characters: CharacterDirectionSprites[];
  floorSprites: string[][][];
  wallSets: string[][][][];
  carpetSets: string[][][][];
  furnitureCatalog: CatalogEntry[];
  furnitureSprites: Record<string, string[][]>;
  layout: unknown;
  /** Set only for `?scene=hero`. */
  hero: { options: HeroSceneOptions; pets: PetSpriteFrames[]; petNames: string[] } | null;
  /** `?scene=empty`: the bundled office with no pets and the cozy lighting off, where nothing moves. */
  empty: boolean;
  /** Set only for `?scene=monitor` (the bundled office). */
  monitor: HeroSceneOptions | null;
}

// ── Module-level state ─────────────────────────────────────────────────────────

let mockPayload: MockPayload | null = null;
let heroStaged = false;
let monitorStaged = false;

// ── PNG decode helpers (browser fallback) ───────────────────────────────────
// Slicing and density detection are the core decoders the server uses, so a 1x and a 2x asset
// directory decode the same here as over the wire.

async function decodePng(url: string): Promise<RgbaImage> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch PNG: ${url} (${res.status.toString()})`);
  }
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Failed to create 2d canvas context for PNG decode');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: imageData.data };
}

async function fetchJsonOptional<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function getIndexedAssetPath(kind: 'characters' | 'floors' | 'walls', relPath: string): string {
  return relPath.startsWith(`${kind}/`) ? relPath : `${kind}/${relPath}`;
}

async function decodeCharactersFromPng(
  base: string,
  index: AssetIndex,
): Promise<CharacterDirectionSprites[]> {
  const sprites: CharacterDirectionSprites[] = [];
  for (const relPath of index.characters) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('characters', relPath)}`);
    sprites.push(decodeCharacterSheet(png));
  }
  return sprites;
}

async function decodeFloorsFromPng(base: string, index: AssetIndex): Promise<string[][][]> {
  const floors: string[][][] = [];
  for (const relPath of index.floors) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('floors', relPath)}`);
    floors.push(decodeFloorTile(png));
  }
  return floors;
}

async function decodeWallsFromPng(base: string, index: AssetIndex): Promise<string[][][][]> {
  const wallSets: string[][][][] = [];
  for (const relPath of index.walls) {
    const png = await decodePng(`${base}assets/${getIndexedAssetPath('walls', relPath)}`);
    wallSets.push(decodeWallSet(png));
  }
  return wallSets;
}

async function decodeFurnitureFromPng(
  base: string,
  catalog: CatalogEntry[],
): Promise<Record<string, string[][]>> {
  const sprites: Record<string, string[][]> = {};
  for (const entry of catalog) {
    const png = await decodePng(`${base}assets/${entry.furniturePath}`);
    try {
      sprites[entry.id] = decodeFurnitureImage(png, entry.id, entry.width, entry.height);
    } catch (err) {
      console.warn(`[BrowserMock] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return sprites;
}

const HERO_PET_DIRS = ['claudio', 'gitcat'];

async function decodeHeroPets(
  base: string,
): Promise<{ pets: PetSpriteFrames[]; petNames: string[] }> {
  const pets: PetSpriteFrames[] = [];
  const petNames: string[] = [];
  for (const dir of HERO_PET_DIRS) {
    const manifest = (await fetch(`${base}assets/pets/${dir}/manifest.json`).then((r) =>
      r.json(),
    )) as { name: string };
    pets.push(decodePetSheet(await decodePng(`${base}assets/pets/${dir}/pet.png`)));
    petNames.push(manifest.name);
  }
  return { pets, petNames };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Call before createRoot() in main.tsx.
 * Fetches all pre-decoded assets from the Vite dev server and stores them
 * for dispatchMockMessages().
 */
export async function initBrowserMock(): Promise<void> {
  console.log('[BrowserMock] Loading assets...');

  const base = import.meta.env.BASE_URL; // '/' in dev, '/sub/' with a subpath, './' in production

  const [assetIndex, catalog] = await Promise.all([
    fetch(`${base}assets/asset-index.json`).then((r) => r.json()) as Promise<AssetIndex>,
    fetch(`${base}assets/furniture-catalog.json`).then((r) => r.json()) as Promise<CatalogEntry[]>,
  ]);

  const shouldTryDecoded = import.meta.env.DEV;
  const [decodedCharacters, decodedFloors, decodedWalls, decodedFurniture] = shouldTryDecoded
    ? await Promise.all([
        fetchJsonOptional<CharacterDirectionSprites[]>(`${base}assets/decoded/characters.json`),
        fetchJsonOptional<string[][][]>(`${base}assets/decoded/floors.json`),
        fetchJsonOptional<string[][][][]>(`${base}assets/decoded/walls.json`),
        fetchJsonOptional<Record<string, string[][]>>(`${base}assets/decoded/furniture.json`),
      ])
    : [null, null, null, null];

  const hasDecoded = !!(decodedCharacters && decodedFloors && decodedWalls && decodedFurniture);

  if (!hasDecoded) {
    if (shouldTryDecoded) {
      console.log('[BrowserMock] Decoded JSON not found, decoding PNG assets in browser...');
    } else {
      console.log('[BrowserMock] Decoding PNG assets in browser...');
    }
  }

  const [characters, floorSprites, wallSets, furnitureSprites] = hasDecoded
    ? [decodedCharacters!, decodedFloors!, decodedWalls!, decodedFurniture!]
    : await Promise.all([
        decodeCharactersFromPng(base, assetIndex),
        decodeFloorsFromPng(base, assetIndex),
        decodeWallsFromPng(base, assetIndex),
        decodeFurnitureFromPng(base, catalog),
      ]);

  const heroOptions = parseHeroScene(window.location.search);
  const empty = new URLSearchParams(window.location.search).get('scene') === 'empty';
  const layoutPath = heroOptions ? HERO_LAYOUT_PATH : assetIndex.defaultLayout;
  const fetched: Record<string, unknown> | null = layoutPath
    ? await fetch(`${base}assets/${layoutPath}`).then((r) => r.json())
    : null;
  const layout = empty && fetched ? { ...fetched, pets: [] } : fetched;
  // The dev mock sends no pets; the scene's cat needs its sprites.
  const heroPets = heroOptions ? await decodeHeroPets(base) : null;

  // Carpets only have a decoded-JSON endpoint (no PNG fallback / asset-index
  // entry); empty array is fine — the carpet tab just won't render variants.
  const carpetSets =
    (shouldTryDecoded
      ? await fetchJsonOptional<string[][][][]>(`${base}assets/decoded/carpets.json`)
      : null) ?? [];

  mockPayload = {
    characters,
    floorSprites,
    wallSets,
    carpetSets,
    furnitureCatalog: catalog,
    furnitureSprites,
    layout,
    hero: heroOptions && heroPets ? { options: heroOptions, ...heroPets } : null,
    empty,
    monitor: parseMonitorScene(window.location.search),
  };

  console.log(
    `[BrowserMock] Ready (${hasDecoded ? 'decoded-json' : 'browser-png-decode'}) — ${characters.length} chars, ${floorSprites.length} floors, ${wallSets.length} wall sets, ${carpetSets.length} carpets, ${catalog.length} furniture items`,
  );
}

/**
 * Call inside a useEffect in App.tsx -- after the window message listener
 * in useExtensionMessages has been registered.
 *
 * Only used in Vite dev mode (npm run dev). In standalone server mode and
 * VS Code mode, the server/extension sends all state over the transport.
 */
export function dispatchMockMessages(host?: {
  office: HeroOffice & MonitorSeating;
  /** Fix the camera at this zoom (fit-to-activity stops). */
  setZoom: (zoom: number) => void;
  /** The layout the rooms are read from (the scene's `&camera=`). */
  roomLayout: () => RoomLayout;
  /** Put the camera at this pan (device px), as a drag would. */
  setPan: (pan: Point) => void;
}): void {
  if (!mockPayload) return;

  const {
    characters,
    floorSprites,
    wallSets,
    carpetSets,
    furnitureCatalog,
    furnitureSprites,
    layout,
    hero,
    empty,
    monitor,
  } = mockPayload;

  function dispatch(data: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  // Must match the load order defined in CLAUDE.md:
  // characterSpritesLoaded -> floorTilesLoaded -> wallTilesLoaded -> carpetTilesLoaded
  //   -> furnitureAssetsLoaded -> layoutLoaded
  dispatch({ type: 'characterSpritesLoaded', characters });
  if (hero) dispatch({ type: 'petSpritesLoaded', pets: hero.pets, petNames: hero.petNames });
  dispatch({ type: 'floorTilesLoaded', sprites: floorSprites });
  dispatch({ type: 'wallTilesLoaded', sets: wallSets });
  dispatch({ type: 'carpetTilesLoaded', sets: carpetSets });
  dispatch({ type: 'furnitureAssetsLoaded', catalog: furnitureCatalog, sprites: furnitureSprites });
  dispatch({ type: 'layoutLoaded', layout });
  dispatch({
    type: 'settingsLoaded',
    soundEnabled: false,
    extensionVersion: '1.3.0',
    // The scene gets no "what's new" toast (a frozen scene gets none either, hero or monitor).
    lastSeenVersion: hero || monitor?.freeze ? '1.3' : '1.2',
    // Fairy lights twinkle at night with the lighting on: the empty scene keeps it off.
    ...(empty ? { cozyLighting: false } : {}),
  });

  // StrictMode runs the mount effect twice in dev; the scene stages once.
  if (hero && host && !heroStaged) {
    heroStaged = true;
    seatHeroAgents(host.office);
    for (const msg of heroMessages()) dispatch(msg);
    if (hero.options.freeze) freezeHeroOffice(host.office);
    startHeroStage(host.office, dispatch, Date.now, hero.options);
    const fit = (): void =>
      host.setZoom(
        hero.options.zoom ??
          heroZoomFor(
            host.office.getLayout(),
            { width: window.innerWidth, height: window.innerHeight },
            window.devicePixelRatio || 1,
          ),
      );
    fit();
    window.addEventListener('resize', fit);
    hideHud(hero.options);
  }

  if (monitor && host && !monitorStaged) {
    monitorStaged = true;
    const { baseMs, at } = startMonitorStage(Date.now, monitor.clock, monitor);
    seatMonitorCast(host.office, monitor.seat);
    // Caught up first, as after a real handshake: from here a helper the page sees spawn gets a
    // start, so the inspector's rows count minutes from each helper's own start time.
    dispatch({ type: 'handshakeDone' });
    if (monitor.zoom) host.setZoom(monitor.zoom);
    if (monitor.camera) frameMonitorCamera(host, monitor);
    for (const msg of monitorMessages(baseMs, monitor)) {
      const startedAt = monitorHelperStart(msg, baseMs);
      if (startedAt === undefined) dispatch(msg);
      else at(startedAt, () => dispatch(msg));
    }
    // The last agentCreated selects its agent; the scene opens on the whole office.
    host.office.selectedAgentId = null;
    if (monitor.freeze) host.office.frozen = true;
    hideHud(monitor);
    if (monitor.plaques) keepPlaques(monitor.plaques);
  }

  console.log('[BrowserMock] Messages dispatched');
}

/**
 * `&hud=0`: the scene is a screenshot, so the clock, the bottom bar, the status badge and the monitor's
 * rail and sheet stay out of it. `&hud=office` keeps the rail and the sheet and drops the rest.
 * `&freeze=1` alone drops the connection pill, which a recording must never catch mid-connect.
 */
function hideHud(o: Pick<HeroSceneOptions, 'hud' | 'hudOffice' | 'freeze' | 'pace'>): void {
  const hidden: string[] = [];
  if (!o.pace) hidden.push('[data-testid="pace-panel"]');
  if (!o.hud) {
    hidden.push(
      '[data-testid="stage-clock"]',
      '[data-testid="bottom-toolbar"]',
      '[data-testid="connection-indicator"]',
    );
    if (!o.hudOffice) hidden.push('[data-testid="monitor-rail"]', '[data-testid="monitor-sheet"]');
  } else if (o.freeze) {
    hidden.push('[data-testid="connection-indicator"]');
  }
  if (hidden.length === 0) return;
  const style = document.createElement('style');
  style.textContent = hidden.join(', ') + ' { display: none !important; }';
  document.head.appendChild(style);
}

/** The camera's pan settles a few ticks after a zoom change (the canvas re-anchors on it), so the scene frames twice. */
const CAMERA_SETTLE_MS = [100, 600];

/**
 * `&camera=STUDIO[:dx,dy]` (dev only): centres that Area in the stage column the capture crop keeps
 * (`&crop=`), or in the whole canvas without one. Also reachable as `fitArea(name)` on the test hooks.
 */
function frameMonitorCamera(
  host: { roomLayout: () => RoomLayout; setPan: (pan: Point) => void },
  o: Pick<HeroSceneOptions, 'camera' | 'crop' | 'zoom'>,
): void {
  const frame = (cam: SceneCamera): boolean => {
    const canvas = document.querySelector('canvas');
    const layout = host.roomLayout();
    const center = areaCenter(roomsOf(layout), cam.area);
    if (!canvas || !center) return false;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // The zoom the canvas is at: its own, not the option (a zoom the scene did not ask for still frames).
    const zoom = o.zoom ?? Math.round(2 * dpr);
    const stage = o.crop
      ? { x: (rect.left + o.crop.width) / 2 - rect.left, y: o.crop.height / 2 - rect.top }
      : { x: rect.width / 2, y: rect.height / 2 };
    const map = { cols: layout.cols, rows: layout.rows };
    const view = { width: canvas.width, height: canvas.height };
    const at = { x: center.x + cam.dx, y: center.y + cam.dy };
    const pan = panForPoint(at, stage, view, dpr, map, zoom);
    host.setPan(cam.free ? pan : clampPan(pan, view, map, zoom));
    return true;
  };
  if (!o.camera) return;
  const cam = o.camera;
  for (const ms of CAMERA_SETTLE_MS) setTimeout(() => frame(cam), ms);
  const hooks = (window.__pixelAgentsTestHooks ??= {});
  hooks.fitArea = (name) => frame({ area: name, dx: 0, dy: 0, free: false });
}

/** `&plaques=Studio,Lab`: every other room's plaque is hidden (the plaque carries its Area's label in `data-area`). */
function keepPlaques(areas: string[]): void {
  const style = document.createElement('style');
  const kept = areas.map((a) => `:not([data-area="${CSS.escape(a)}"])`).join('');
  style.textContent = `[data-testid="room-plaque"]${kept} { display: none !important; }`;
  document.head.appendChild(style);
}
