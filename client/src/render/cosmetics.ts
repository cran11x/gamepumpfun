// Cosmetics drawing (shared/cosmetics.ts): the public entry point for the UI (shop, lobby, ejection
// previews) and the helpers the world renderer uses. Everything is purely visual.
//
//   drawPillPreview  a standing pill wearing the equipped skin, on its rug, under its name effect
//   drawRugPreview   a rug alone, flat
//   drawBodyRug      the victim's rug (plus the red floor glow) under a rugged bag in the world
//   drawNameFx       a canvas name label with a name effect; labelEffect applies the red rule
//
// The low-level art lives in skins.ts (pill skins), rugs.ts (rug patterns) and nameFx.ts.

import { TILE } from '../../../shared/constants';
import { CELL_FLOOR, CELL_OBSTACLE, cellAt } from '../../../shared/map';
import type { EquippedCosmetics } from '../../../shared/protocol';
import { drawBodyGlow, drawLabel, drawPill, type PillDraw } from './characters';
import { drawNameFx, isKnownNameFx } from './nameFx';
import { PILL_TOP } from './pillGeom';
import { drawRug, isKnownRug, RUG_FRINGE, RUG_H, RUG_W } from './rugs';
import { skinHeadroom } from './skins';

export { drawNameFx, isKnownNameFx, labelEffect, NAME_FX_IDS } from './nameFx';
export { drawRug, isKnownRug, RUG_FRINGE, RUG_H, RUG_IDS, RUG_W } from './rugs';
export { SKIN_IDS, skinHeadroom, skinPainter } from './skins';

type G = CanvasRenderingContext2D;

/** drawPillPreview at scale 1 fits a PREVIEW_BOX x PREVIEW_BOX square centered on (x, y). */
export const PREVIEW_BOX = 64;

export interface PillPreviewOptions {
  /**
   * Name drawn above the pill (with the equipped name effect). Default: the sample name "degen"
   * when a name effect is equipped, else none. null never draws a name.
   */
  label?: string | null;
  /** Default 1 (facing right). */
  facing?: 1 | -1;
  /** Walk in place. Default false. */
  moving?: boolean;
  /** Animation seed, so several previews on one screen don't blink in sync. Default 0. */
  seed?: number;
}

const PREVIEW_LABEL_SIZE = 10;
/** Rug under a preview pill: field size and center (the feet are at about y = 14). */
const PREVIEW_RUG_W = 54;
const PREVIEW_RUG_H = (PREVIEW_RUG_W * RUG_H) / RUG_W;
const PREVIEW_RUG_CY = 9;

const pill: PillDraw = { x: 0, y: 0, color: 0, facing: 1, moving: false, walk: 0, seed: 0, skin: undefined, beamScale: 0.62 };

/**
 * Draws a preview of a player wearing `equipped`: the pill (color index `color`) with its skin,
 * standing on its rug, with its name effect on a label above. At `scale` 1 everything fits a
 * 64 x 64 box centered on (x, y), so a W x H canvas uses scale = min(W, H) / 64 (times the device
 * pixel ratio if the context isn't already scaled). Pills keep the same size across items unless
 * a crown, rug and label together need more room. Animated from `timeMs` (e.g. performance.now()).
 * Draws over whatever is there (no clear). Unknown item ids are ignored.
 */
export function drawPillPreview(
  g: G,
  x: number,
  y: number,
  scale: number,
  color: number,
  equipped: EquippedCosmetics | null | undefined,
  timeMs: number,
  opts?: PillPreviewOptions,
): void {
  const t = (Number.isFinite(timeMs) ? timeMs : 0) / 1000;
  const skin = equipped?.skin;
  const rug = isKnownRug(equipped?.rug) ? equipped?.rug : undefined;
  const fx = isKnownNameFx(equipped?.name) ? (equipped?.name as string) : undefined;
  const label = opts?.label === undefined ? (fx ? 'degen' : null) : opts.label;
  const seed = opts?.seed ?? 0;
  const facing = opts?.facing === -1 ? -1 : 1;
  const moving = !!opts?.moving;

  // Content extents (pill-local units, collision center at 0, 0).
  const head = skinHeadroom(skin);
  const pillTop = PILL_TOP - head - 1;
  const top = label ? pillTop - 5 - PREVIEW_LABEL_SIZE : pillTop;
  const bottom = rug ? PREVIEW_RUG_CY + PREVIEW_RUG_H / 2 + 1.5 : 18;
  const halfW = rug ? PREVIEW_RUG_W / 2 + (RUG_FRINGE * PREVIEW_RUG_W) / RUG_W : 18;
  const fit = Math.min(1, (PREVIEW_BOX - 4) / (bottom - top), (PREVIEW_BOX - 2) / (2 * halfW));
  const k = scale * fit;
  if (!(k > 0)) return;

  g.save();
  g.translate(x, y);
  g.scale(k, k);
  g.translate(0, -(top + bottom) / 2);
  if (rug) drawRug(g, rug, 0, PREVIEW_RUG_CY, PREVIEW_RUG_W, PREVIEW_RUG_H, t);
  pill.color = color;
  pill.facing = facing;
  pill.moving = moving;
  pill.walk = moving ? t * 9 : 0;
  pill.seed = seed;
  pill.skin = skin;
  drawPill(g, pill, t);
  if (label) {
    const ly = pillTop - 4;
    if (!fx || !drawNameFx(g, fx, label, 0, ly, PREVIEW_LABEL_SIZE, 1, t, seed)) drawLabel(g, label, 0, ly, '#ffffff', PREVIEW_LABEL_SIZE);
  }
  g.restore();
}

/**
 * Draws rug `rugId` alone, flat, centered on (x, y). At `scale` 1 it is 60 px wide including the
 * fringe (it fits the same 64 px box as drawPillPreview). Returns false for an unknown id.
 */
export function drawRugPreview(g: G, x: number, y: number, scale: number, rugId: string | null | undefined, timeMs: number): boolean {
  const w = ((PREVIEW_BOX - 4) * RUG_W) / (RUG_W + RUG_FRINGE * 2);
  return drawRug(g, rugId, x, y, w * scale, ((w * RUG_H) / RUG_W) * scale, (Number.isFinite(timeMs) ? timeMs : 0) / 1000);
}

/** World size of the rug under a rugged bag. */
export const BODY_RUG_W = 88;
export const BODY_RUG_H = (BODY_RUG_W * RUG_H) / RUG_W;

function floorish(tx: number, ty: number): boolean {
  const c = cellAt(tx, ty);
  return c === CELL_FLOOR || c === CELL_OBSTACLE;
}

/**
 * The victim's rug under a rugged bag at world (x, y), with the red floor glow around it (then
 * draw the bag with drawBody(..., onRug = true)). Near a wall the rug is clipped to the floor
 * tiles, so it never lies over walls. Returns false, drawing nothing, for an unknown rug id.
 */
export function drawBodyRug(g: G, x: number, y: number, rugId: string | null | undefined, t: number): boolean {
  if (!isKnownRug(rugId)) return false;
  // Tiles under the glow and the rug (fringe and shadow included).
  const tx0 = Math.floor((x - BODY_RUG_W * 0.62) / TILE);
  const tx1 = Math.floor((x + BODY_RUG_W * 0.62) / TILE);
  const ty0 = Math.floor((y + 6 - BODY_RUG_H * 0.68) / TILE);
  const ty1 = Math.floor((y + 6 + BODY_RUG_H * 0.68) / TILE);
  let allFloor = true;
  for (let ty = ty0; ty <= ty1 && allFloor; ty++) for (let tx = tx0; tx <= tx1; tx++) if (!floorish(tx, ty)) allFloor = false;
  if (!allFloor) {
    g.save();
    g.beginPath();
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (floorish(tx, ty)) g.rect(tx * TILE, ty * TILE, TILE, TILE);
    g.clip();
  }
  drawBodyGlow(g, x, y, t, BODY_RUG_W * 0.6, BODY_RUG_H * 0.66);
  drawRug(g, rugId, x, y + 6, BODY_RUG_W, BODY_RUG_H, t);
  if (!allFloor) g.restore();
  return true;
}
