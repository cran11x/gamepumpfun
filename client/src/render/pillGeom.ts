// Pill character geometry shared by the character renderer and the cosmetic skins.
// Local coordinates: (0, 0) is the player's collision center; the pill stands above it.

type G = CanvasRenderingContext2D;

export const PILL_W = 26;
export const PILL_H = 40;
export const PILL_R = PILL_W / 2;
/** Pill center relative to the collision center. */
export const PILL_CY = -10;
/** Top of the pill relative to the collision center (for label placement). */
export const PILL_TOP = PILL_CY - PILL_H / 2;
/** Bottom of the pill. */
export const PILL_BOTTOM = PILL_CY + PILL_H / 2;
/** Eye row, how far the eyes shift toward the facing side, and half the gap between them. */
export const EYE_Y = PILL_CY - 7;
export const EYE_SHIFT = 3.6;
export const EYE_GAP = 4.9;
/** Ghost tail baseline (the waves dip below it). */
export const GHOST_BOTTOM = 8;

/** Adds the capsule outline (centered horizontally on 0) as a closed sub-path. */
export function capsulePath(g: G, cy: number, w: number, h: number): void {
  const r = w / 2;
  const top = cy - h / 2 + r;
  const bot = cy + h / 2 - r;
  g.moveTo(-r, top);
  g.arc(0, top, r, Math.PI, 0);
  g.lineTo(r, bot);
  g.arc(0, bot, r, 0, Math.PI);
  g.closePath();
}

/** Adds the ghost silhouette: the pill dome with a wavy tail (animated by `t` and `seed`). */
export function ghostPath(g: G, t: number, seed: number): void {
  const r = PILL_R;
  const topC = PILL_TOP + r;
  g.moveTo(-r, topC);
  g.arc(0, topC, r, Math.PI, 0);
  g.lineTo(r, GHOST_BOTTOM);
  const waves = 3;
  for (let k = 0; k < waves; k++) {
    const x1 = r - ((k + 0.5) * PILL_W) / waves;
    const x2 = r - ((k + 1) * PILL_W) / waves;
    const dip = 5 + Math.sin(t * 5 + k * 2 + seed) * 2;
    g.quadraticCurveTo(x1, GHOST_BOTTOM + dip, x2, GHOST_BOTTOM);
  }
  g.closePath();
}
