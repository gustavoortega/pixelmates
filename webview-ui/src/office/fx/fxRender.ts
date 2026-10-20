import {
  BUBBLE_VERTICAL_OFFSET_PX,
  FX_CONFETTI_COLORS,
  FX_CONFETTI_GRAVITY,
  FX_CONFETTI_MS,
  FX_CONFETTI_PARTICLES,
  FX_HEART_COLOR,
  FX_HEART_MS,
  FX_HEART_RISE_PX,
  FX_PILLAR_BOTTOM_COLOR,
  FX_PILLAR_HEIGHT_PX,
  FX_PILLAR_MS,
  FX_PILLAR_TOP_COLOR,
  FX_PILLAR_WIDTH_PX,
  FX_RAIN_COLOR,
  FX_RAIN_DROPS,
  FX_RAIN_PERIOD_MS,
  FX_SPARKLE_COLORS,
  FX_SPARKLE_MS,
  FX_SPARKLE_PARTICLES,
  FX_STORM_BOLT_COLOR,
  FX_STORM_CLOUD_COLOR,
  FX_STORM_CLOUD_SHADE,
  FX_WEATHER_RISE_PX,
} from '../../constants.js';
import { worldToDevice } from '../projection.js';
import { seatedBubbleOffsetPx } from '../seatDraw.js';
import type { Character } from '../types.js';
import type { ActiveFx } from './fxEngine.js';
import type { MoodWeather } from './moodWeather.js';
import { makeParticles, particleAt } from './particles.js';

/** What the renderer needs to draw the canvas half of the FX; built per frame by the canvas. */
export interface FxRenderState {
  effects: readonly ActiveFx[];
  weather: MoodWeather;
  /** Date.now(): the clock the engine and the weather run on. */
  nowMs: number;
  /** World y each agent's weather hangs from (the overlay stack's top); absent falls back to the
   *  bubble anchor over the head. */
  anchors?: ReadonlyMap<number, number>;
}

const pillarCache = new Map<number, HTMLCanvasElement>();

/** The golden column, one gradient canvas per zoom. */
function pillarSprite(zoom: number): HTMLCanvasElement {
  let c = pillarCache.get(zoom);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = FX_PILLAR_WIDTH_PX * zoom;
  c.height = FX_PILLAR_HEIGHT_PX * zoom;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, FX_PILLAR_TOP_COLOR);
  grad.addColorStop(1, FX_PILLAR_BOTTOM_COLOR);
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  pillarCache.set(zoom, c);
  return c;
}

/** Rises in the first fifth, holds, fades over the last fifth. */
function envelope(t: number): number {
  return Math.min(1, t / 0.2, (1 - t) / 0.2);
}

// 5x4 cloud and 5x5 heart, as [col, row] cells.
const CLOUD_CELLS: ReadonlyArray<[number, number, boolean]> = [
  [1, 0, false],
  [2, 0, false],
  [3, 0, false],
  [0, 1, false],
  [1, 1, false],
  [2, 1, false],
  [3, 1, false],
  [4, 1, false],
  [0, 2, true],
  [1, 2, true],
  [2, 2, true],
  [3, 2, true],
  [4, 2, true],
];
// The bolt under the cloud: a two-step zigzag, [col, row] from the cloud's top-left.
const BOLT_CELLS: ReadonlyArray<[number, number]> = [
  [3, 3],
  [2, 4],
  [3, 4],
  [2, 5],
];
const HEART_CELLS: ReadonlyArray<[number, number]> = [
  [0, 0],
  [1, 0],
  [3, 0],
  [4, 0],
  [0, 1],
  [1, 1],
  [2, 1],
  [3, 1],
  [4, 1],
  [1, 2],
  [2, 2],
  [3, 2],
  [2, 3],
];

function headAnchor(ch: Character, ox: number, oy: number, zoom: number): { x: number; y: number } {
  const sit = seatedBubbleOffsetPx(ch);
  return worldToDevice(
    { offsetX: ox, offsetY: oy, zoom },
    ch.x,
    ch.y + sit - BUBBLE_VERTICAL_OFFSET_PX,
  );
}

let stormScale = 1;

/** Dev-only (the README hero scene): draws the storm cloud this many times bigger; 0 draws none. */
export function setSceneStormScale(scale: number): void {
  stormScale = scale;
}

/** Device-px box of the storm cloud: 5 x 4 cells standing FX_WEATHER_RISE_PX above `anchorY`. */
export function stormCloudRect(
  anchorX: number,
  anchorY: number,
  zoom: number,
  scale = 1,
): { x: number; y: number; w: number; h: number } {
  const cell = zoom * scale;
  return {
    x: anchorX - Math.floor((5 * cell) / 2),
    y: anchorY - 4 * cell - FX_WEATHER_RISE_PX * zoom,
    w: 5 * cell,
    h: 4 * cell,
  };
}

/** The weather's anchor in device px: the overlay stack's top when it is known, else the head. */
function weatherAnchor(
  ch: Character,
  fx: FxRenderState,
  ox: number,
  oy: number,
  zoom: number,
): { x: number; y: number } {
  const head = headAnchor(ch, ox, oy, zoom);
  const worldY = fx.anchors?.get(ch.id);
  return worldY === undefined ? head : { x: head.x, y: Math.round(oy + worldY * zoom) };
}

/** Sparkles, pillar, confetti, storm clouds and hearts. Drawn over the scene; the DOM text is in ToolOverlay. */
export function renderFx(
  ctx: CanvasRenderingContext2D,
  fx: FxRenderState,
  characters: readonly Character[],
  ox: number,
  oy: number,
  zoom: number,
): void {
  const byId = new Map(characters.map((c) => [c.id, c]));
  ctx.save();
  for (const e of fx.effects) {
    const ch = byId.get(e.agentId);
    if (!ch) continue;
    const age = fx.nowMs - e.startedAt;
    const head = headAnchor(ch, ox, oy, zoom);
    const seed = e.agentId * 7919 + Math.floor(e.startedAt);
    if (e.kind === 'pop') {
      if (age < FX_SPARKLE_MS) {
        const ps = makeParticles(seed, FX_SPARKLE_PARTICLES, 24, false, FX_SPARKLE_COLORS.length);
        ctx.globalAlpha = 1 - age / FX_SPARKLE_MS;
        for (const p of ps) {
          const pos = particleAt(p, age / 1000, 0);
          ctx.fillStyle = FX_SPARKLE_COLORS[p.colorIndex];
          ctx.fillRect(
            Math.round(head.x + pos.x * zoom),
            Math.round(head.y + pos.y * zoom),
            zoom,
            zoom,
          );
        }
      }
    } else {
      if (age < FX_PILLAR_MS) {
        const feetY = worldToDevice({ offsetX: ox, offsetY: oy, zoom }, ch.x, ch.y).y;
        const sprite = pillarSprite(zoom);
        ctx.globalAlpha = envelope(age / FX_PILLAR_MS);
        ctx.globalCompositeOperation = 'screen';
        ctx.drawImage(sprite, Math.round(head.x - sprite.width / 2), feetY - sprite.height);
        ctx.globalCompositeOperation = 'source-over';
      }
      if (age < FX_CONFETTI_MS) {
        const ps = makeParticles(seed, FX_CONFETTI_PARTICLES, 40, true, FX_CONFETTI_COLORS.length);
        ctx.globalAlpha = Math.min(1, (1 - age / FX_CONFETTI_MS) * 3);
        for (const p of ps) {
          const pos = particleAt(p, age / 1000, FX_CONFETTI_GRAVITY);
          ctx.fillStyle = FX_CONFETTI_COLORS[p.colorIndex];
          ctx.fillRect(
            Math.round(head.x + pos.x * zoom),
            Math.round(head.y + pos.y * zoom),
            zoom,
            zoom,
          );
        }
      }
    }
  }

  for (const ch of characters) {
    const alpha = fx.weather.stormAlpha(ch.id, fx.nowMs);
    if (alpha === null || stormScale === 0) continue;
    const anchor = weatherAnchor(ch, fx, ox, oy, zoom);
    const cell = zoom * stormScale;
    const { x: left, y: top } = stormCloudRect(anchor.x, anchor.y, zoom, stormScale);
    ctx.globalAlpha = alpha;
    for (const [c, r, shade] of CLOUD_CELLS) {
      ctx.fillStyle = shade ? FX_STORM_CLOUD_SHADE : FX_STORM_CLOUD_COLOR;
      ctx.fillRect(left + c * cell, top + r * cell, cell, cell);
    }
    ctx.fillStyle = FX_RAIN_COLOR;
    const age = fx.weather.stormAge(ch.id, fx.nowMs);
    for (let i = 0; i < FX_RAIN_DROPS; i++) {
      const phase = ((age / FX_RAIN_PERIOD_MS + i / FX_RAIN_DROPS) % 1) * 4;
      // Drops fall on every other column, clear of the bolt between them.
      ctx.fillRect(left + i * 2 * cell, top + (3 + Math.floor(phase)) * cell, cell, cell);
    }
    ctx.fillStyle = FX_STORM_BOLT_COLOR;
    for (const [c, r] of BOLT_CELLS) ctx.fillRect(left + c * cell, top + r * cell, cell, cell);
  }

  ctx.fillStyle = FX_HEART_COLOR;
  for (const h of fx.weather.hearts) {
    const ch = byId.get(h.agentId);
    if (!ch) continue;
    const age = fx.nowMs - h.startedAt;
    const head = weatherAnchor(ch, fx, ox, oy, zoom);
    const rise = (age / FX_HEART_MS) * FX_HEART_RISE_PX;
    ctx.globalAlpha = envelope(age / FX_HEART_MS);
    const left = head.x - Math.floor((5 * zoom) / 2);
    const top = Math.round(head.y - (4 + FX_WEATHER_RISE_PX + rise) * zoom);
    for (const [c, r] of HEART_CELLS) ctx.fillRect(left + c * zoom, top + r * zoom, zoom, zoom);
  }
  ctx.restore();
}
