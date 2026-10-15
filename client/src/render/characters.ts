// Characters: capsule-pill players, ghosts, rugged bags (bodies), name labels and vent markers.
// Everything is drawn in world space around the player's collision center (x, y).
// Gradients are cached per color in local coordinates and reused with translate().

import { COLORS, FONT_MONO, labelFont, playerColor, rgba } from './palette';
import { capsulePath, EYE_SHIFT, EYE_Y, ghostPath, PILL_CY, PILL_H, PILL_R, PILL_TOP, PILL_W } from './pillGeom';
import { skinPainter, type SkinFrame } from './skins';
import { TAU, rrect } from './util';

export { PILL_TOP } from './pillGeom';

type G = CanvasRenderingContext2D;

/** Reused for every skin hook call (no per-frame allocation). */
const frame: SkinFrame = { t: 0, facing: 1, moving: false, seed: 0, ghost: false, blink: false, beamScale: 1 };

interface Grads {
  body: CanvasGradient;
  bottom: CanvasGradient;
  lyingTop: CanvasGradient;
  lyingBottom: CanvasGradient;
}

const gradCache = new WeakMap<G, Map<number, Grads>>();

function grads(g: G, color: number): Grads {
  let m = gradCache.get(g);
  if (!m) {
    m = new Map();
    gradCache.set(g, m);
  }
  let e = m.get(color);
  if (e) return e;
  const pc = playerColor(color);
  const body = g.createLinearGradient(-PILL_R, 0, PILL_R, 0);
  body.addColorStop(0, pc.dark);
  body.addColorStop(0.22, pc.body);
  body.addColorStop(0.62, pc.body);
  body.addColorStop(1, pc.dark);
  const bottom = g.createLinearGradient(-PILL_R, 0, PILL_R, 0);
  bottom.addColorStop(0, COLORS.offWhiteShade);
  bottom.addColorStop(0.25, COLORS.offWhite);
  bottom.addColorStop(0.62, '#e4e9ef');
  bottom.addColorStop(1, '#9ea8b6');
  const lyingTop = g.createLinearGradient(0, -PILL_R, 0, PILL_R);
  lyingTop.addColorStop(0, pc.body);
  lyingTop.addColorStop(0.55, pc.body);
  lyingTop.addColorStop(1, pc.dark);
  const lyingBottom = g.createLinearGradient(0, -PILL_R, 0, PILL_R);
  lyingBottom.addColorStop(0, COLORS.offWhite);
  lyingBottom.addColorStop(0.6, '#dfe4ea');
  lyingBottom.addColorStop(1, '#98a2b0');
  e = { body, bottom, lyingTop, lyingBottom };
  m.set(color, e);
  return e;
}

function blinking(t: number, seed: number): boolean {
  const period = 3.4 + (seed % 7) * 0.31;
  return (t + seed * 0.913) % period < 0.13;
}

function drawEyes(g: G, cx: number, cy: number, facing: number, closed: boolean, scale = 1): void {
  const rx = 4.7 * scale;
  const ry = 5.8 * scale;
  const gap = 4.9 * scale;
  for (const side of [-1, 1]) {
    const ex = cx + side * gap;
    g.beginPath();
    g.ellipse(ex, cy, rx, closed ? ry * 0.14 : ry, 0, 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 1;
    g.stroke();
    if (closed) continue;
    const px = ex + facing * 1.7 * scale;
    const py = cy + 0.9 * scale;
    g.beginPath();
    g.arc(px, py, 2.6 * scale, 0, TAU);
    g.fillStyle = '#07090d';
    g.fill();
    g.beginPath();
    g.arc(px - 0.9 * scale, py - 1 * scale, 0.85 * scale, 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
  }
}

export interface PillDraw {
  x: number;
  y: number;
  color: number;
  facing: 1 | -1;
  moving: boolean;
  /** Walk cycle phase in radians. */
  walk: number;
  seed: number;
  alpha?: number;
  /** Equipped pill skin id (shared/cosmetics.ts), if any. */
  skin?: string;
  /** Laser beam length multiplier for the laser skin (default 1). */
  beamScale?: number;
}

/** A living player: capsule pill with eyes, stub legs and a shadow (plus the equipped skin). */
export function drawPill(g: G, p: PillDraw, t: number): void {
  const gr = grads(g, p.color);
  const sk = skinPainter(p.skin);
  const closed = blinking(t, p.seed);
  g.save();
  g.translate(p.x, p.y);
  if (p.alpha !== undefined && p.alpha < 1) g.globalAlpha = p.alpha;
  // Shadow.
  g.fillStyle = 'rgba(0,0,0,0.38)';
  g.beginPath();
  g.ellipse(0, 14.5, 14, 4.6, 0, 0, TAU);
  g.fill();
  // Stub legs (player's dark shade, outlined so they read on the dark floor).
  const swing = p.moving ? Math.sin(p.walk) : 0;
  const lift1 = p.moving ? Math.max(0, Math.cos(p.walk)) * 2.8 : 0;
  const lift2 = p.moving ? Math.max(0, -Math.cos(p.walk)) * 2.8 : 0;
  g.beginPath();
  rrect(g, -9.5 + swing * 3.2, 6 - lift1, 7, 10, 3.5);
  rrect(g, 2.5 - swing * 3.2, 6 - lift2, 7, 10, 3.5);
  g.fillStyle = sk?.legs ? sk.legs(g) : playerColor(p.color).dark;
  g.fill();
  g.strokeStyle = 'rgba(4,6,9,0.85)';
  g.lineWidth = 1.4;
  g.stroke();
  // Body (bobs and leans while walking, breathes while idle).
  const bob = p.moving ? Math.abs(Math.cos(p.walk)) * 1.8 : 0;
  g.translate(0, -bob);
  if (p.moving) g.rotate(p.facing * 0.075);
  else {
    const breathe = 1 + Math.sin(t * 2.4 + p.seed) * 0.018;
    g.translate(0, 9);
    g.scale(1 / breathe, breathe);
    g.translate(0, -9);
  }
  g.beginPath();
  capsulePath(g, PILL_CY, PILL_W, PILL_H);
  g.lineWidth = 2.6;
  g.strokeStyle = 'rgba(4,6,9,0.92)';
  g.stroke();
  g.fillStyle = gr.bottom;
  g.fill();
  g.save();
  g.beginPath();
  g.rect(-PILL_R - 2, PILL_TOP - 2, PILL_W + 4, PILL_H / 2 + 2);
  g.clip();
  g.beginPath();
  capsulePath(g, PILL_CY, PILL_W, PILL_H);
  g.fillStyle = gr.body;
  g.fill();
  g.restore();
  if (sk) setFrame(t, p.facing, p.moving, p.seed, false, closed, p.beamScale ?? 1);
  if (sk?.surface) {
    g.save();
    g.beginPath();
    capsulePath(g, PILL_CY, PILL_W, PILL_H);
    g.clip();
    sk.surface(g, frame);
    g.restore();
  }
  // Seam.
  g.fillStyle = 'rgba(0,0,0,0.32)';
  g.fillRect(-PILL_R + 0.6, PILL_CY - 0.7, PILL_W - 1.2, 1.4);
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.fillRect(-PILL_R + 1.5, PILL_CY + 0.9, PILL_W - 3, 0.8);
  // Gloss.
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.beginPath();
  g.ellipse(-6.2, PILL_CY - 12.5, 2.4, 5.6, -0.22, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.beginPath();
  g.ellipse(-6.4, PILL_CY + 8, 1.6, 3.6, -0.2, 0, TAU);
  g.fill();
  drawEyes(g, p.facing * EYE_SHIFT, EYE_Y, p.facing, closed);
  if (sk?.over) sk.over(g, frame);
  g.restore();
}

function setFrame(t: number, facing: 1 | -1, moving: boolean, seed: number, ghost: boolean, blink: boolean, beamScale: number): void {
  frame.t = t;
  frame.facing = facing;
  frame.moving = moving;
  frame.seed = seed;
  frame.ghost = ghost;
  frame.blink = blink;
  frame.beamScale = beamScale;
}

/** Ghost: translucent pill, bobbing, wavy tail instead of legs, halo. A skin shows faded. */
export function drawGhost(g: G, x: number, y: number, color: number, facing: 1 | -1, t: number, seed: number, alpha = 0.5, skin?: string): void {
  const gr = grads(g, color);
  const sk = skinPainter(skin);
  const closed = blinking(t, seed);
  const bob = Math.sin(t * 2.4 + seed) * 3.5;
  g.save();
  g.translate(x, y);
  g.globalAlpha = alpha * 0.5;
  g.fillStyle = 'rgba(160,200,255,0.25)';
  g.beginPath();
  g.ellipse(0, 13, 11 - bob * 0.4, 3.5, 0, 0, TAU);
  g.fill();
  g.translate(0, -4 + bob);
  g.globalAlpha = alpha;
  g.beginPath();
  ghostPath(g, t, seed);
  g.fillStyle = gr.bottom;
  g.fill();
  g.save();
  g.beginPath();
  g.rect(-PILL_R - 2, PILL_TOP - 2, PILL_W + 4, PILL_H / 2 + 2);
  g.clip();
  g.beginPath();
  ghostPath(g, t, seed);
  g.fillStyle = gr.body;
  g.fill();
  g.restore();
  if (sk) setFrame(t, facing, false, seed, true, closed, 1);
  if (sk?.surface) {
    g.save();
    g.beginPath();
    ghostPath(g, t, seed);
    g.clip();
    g.globalAlpha = alpha * 0.75;
    sk.surface(g, frame);
    g.restore();
  }
  g.beginPath();
  ghostPath(g, t, seed);
  g.strokeStyle = 'rgba(200,225,255,0.5)';
  g.lineWidth = 1.5;
  g.stroke();
  drawEyes(g, facing * EYE_SHIFT, EYE_Y, facing, closed);
  if (sk?.over) {
    g.globalAlpha = alpha * 0.8;
    sk.over(g, frame);
  }
  // Halo (floats above a crown).
  const haloY = PILL_TOP - 6 - (sk ? sk.headroom * 0.65 : 0);
  g.globalAlpha = Math.min(1, alpha * 1.6);
  g.strokeStyle = rgba(COLORS.gold, 0.35);
  g.lineWidth = 4.5;
  g.beginPath();
  g.ellipse(0, haloY, 9.5, 3.2, 0, 0, TAU);
  g.stroke();
  g.strokeStyle = COLORS.gold;
  g.lineWidth = 1.7;
  g.stroke();
  g.restore();
}

const CRACK: [number, number][] = [
  [0, -13],
  [-3, -7.5],
  [1.5, -3],
  [-2.5, 2.5],
  [1.5, 7.5],
  [-1, 13],
];

/** Red floor glow under a rugged bag (or under its rug) so bags pop in the dark. */
export function drawBodyGlow(g: G, x: number, y: number, t: number, rx = 34, ry = 11): void {
  g.fillStyle = rgba(COLORS.rug, 0.16 + 0.05 * Math.sin(t * 3));
  g.beginPath();
  g.ellipse(x, y + 6, rx, ry, 0, 0, TAU);
  g.fill();
}

/**
 * Rugged bag: the pill snapped in half, lying sideways, X_X eyes, red "-99%" sticker.
 * `onRug`: a rug pattern is already drawn under it (see drawBodyRug), so skip the floor glow.
 */
export function drawBody(g: G, x: number, y: number, color: number, t: number, onRug = false): void {
  const gr = grads(g, color);
  if (!onRug) drawBodyGlow(g, x, y, t);
  g.save();
  g.translate(x, y);
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.beginPath();
  g.ellipse(0, 9, 26, 6, 0, 0, TAU);
  g.fill();
  // Left (colored) half.
  g.save();
  g.translate(-4, 0);
  g.rotate(-0.1);
  g.beginPath();
  g.moveTo(CRACK[0][0], CRACK[0][1]);
  g.lineTo(-7, -13);
  g.arc(-7, 0, 13, -Math.PI / 2, Math.PI / 2, true);
  for (let i = CRACK.length - 1; i >= 0; i--) g.lineTo(CRACK[i][0], CRACK[i][1]);
  g.closePath();
  g.fillStyle = gr.lyingTop;
  g.fill();
  g.strokeStyle = 'rgba(4,6,9,0.9)';
  g.lineWidth = 2.2;
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.beginPath();
  g.ellipse(-12, -8, 5, 1.8, -0.1, 0, TAU);
  g.fill();
  // X_X eyes.
  g.strokeStyle = '#07090d';
  g.lineWidth = 2.1;
  g.lineCap = 'round';
  for (const ex of [-14.5, -6.5]) {
    g.beginPath();
    g.moveTo(ex - 2.6, -5.6);
    g.lineTo(ex + 2.6, -0.4);
    g.moveTo(ex + 2.6, -5.6);
    g.lineTo(ex - 2.6, -0.4);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(-13.5, 4);
  g.lineTo(-7.5, 4);
  g.stroke();
  g.restore();
  // Right (off-white) half.
  g.save();
  g.translate(5, 2.5);
  g.rotate(0.22);
  // Stub legs sticking out of the bottom end (behind the shell).
  g.fillStyle = playerColor(color).dark;
  g.beginPath();
  rrect(g, 16, -7.5, 9, 6, 3);
  rrect(g, 16, 1.5, 9, 6, 3);
  g.fill();
  g.beginPath();
  g.moveTo(CRACK[0][0], CRACK[0][1]);
  g.lineTo(7, -13);
  g.arc(7, 0, 13, -Math.PI / 2, Math.PI / 2, false);
  for (let i = CRACK.length - 1; i >= 0; i--) g.lineTo(CRACK[i][0], CRACK[i][1]);
  g.closePath();
  g.fillStyle = gr.lyingBottom;
  g.fill();
  g.strokeStyle = 'rgba(4,6,9,0.9)';
  g.lineWidth = 2.2;
  g.stroke();
  g.restore();
  // Shards.
  g.fillStyle = playerColor(color).body;
  g.beginPath();
  g.moveTo(2, -16);
  g.lineTo(5, -19);
  g.lineTo(4.5, -15);
  g.closePath();
  g.fill();
  g.fillStyle = COLORS.offWhite;
  g.beginPath();
  g.moveTo(-1, 15);
  g.lineTo(3, 18);
  g.lineTo(-1.5, 18.5);
  g.closePath();
  g.fill();
  // "-99%" sticker.
  g.save();
  g.translate(0, 11);
  g.rotate(-0.22);
  g.beginPath();
  rrect(g, -13, -6, 26, 12, 3);
  g.fillStyle = COLORS.rug;
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1.2;
  g.stroke();
  g.font = `700 8.5px ${FONT_MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.fillText('-99%', 0, 0.6);
  g.restore();
  g.restore();
}

/** A fellow rugger hiding in a bridge: eyes peeking out of the hatch in their color. */
export function drawVentMarker(g: G, x: number, y: number, color: number, t: number, seed: number): void {
  const pc = playerColor(color);
  g.save();
  g.translate(x, y);
  const pulse = 0.5 + 0.5 * Math.sin(t * 3 + seed);
  g.globalAlpha = 0.55;
  g.strokeStyle = rgba(pc.body, 0.5 + pulse * 0.4);
  g.lineWidth = 2.5;
  g.beginPath();
  rrect(g, -22, -17, 44, 34, 9);
  g.stroke();
  g.fillStyle = rgba(pc.body, 0.18);
  g.fill();
  drawEyes(g, 0, -1, Math.sin(t * 0.8 + seed) > 0 ? 1 : -1, blinking(t, seed), 0.8);
  g.restore();
}

/** Name label centered at (x, y) baseline. */
export function drawLabel(g: G, text: string, x: number, y: number, color: string, size: number, alpha = 1): void {
  g.save();
  if (alpha < 1) g.globalAlpha = alpha;
  g.font = labelFont(size);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  g.lineWidth = Math.max(2, size * 0.3);
  g.strokeStyle = 'rgba(4,6,9,0.85)';
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.restore();
}

/** Small tag (e.g. OFFLINE) above a name label. */
export function drawTag(g: G, text: string, x: number, y: number, size: number, bg: string, fg: string): void {
  g.save();
  g.font = `700 ${Math.round(size * 2) / 2}px ${FONT_MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = g.measureText(text).width + size * 0.9;
  const h = size * 1.45;
  g.beginPath();
  rrect(g, x - w / 2, y - h / 2, w, h, h * 0.3);
  g.fillStyle = bg;
  g.fill();
  g.fillStyle = fg;
  g.fillText(text, x, y + size * 0.05);
  g.restore();
}
