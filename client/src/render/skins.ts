// Pill skins (see shared/cosmetics.ts). Purely visual. Every skin keeps the player's color clearly
// recognisable: it only adds marks, accessories or translucent light on top of the colored half,
// prints on the off-white half, or decorates the rim and legs.
//
// A skin is a set of hooks the character renderer calls while drawing a pill or a ghost, in the
// pill's local coordinates (see pillGeom.ts):
//   legs     fill style for the stub legs instead of the player's dark shade
//   surface  clipped to the body silhouette, after the colors and before the seam, gloss and eyes
//   over     after the eyes, unclipped (shades, beams, crown, rim)
// Gradients are cached per context in local coordinates; textures are cached canvases.

import { PILL_BOTTOM, PILL_CY, PILL_H, PILL_R, PILL_TOP, PILL_W, EYE_GAP, EYE_SHIFT, EYE_Y, capsulePath, ghostPath } from './pillGeom';
import { createCanvas, get2d, mulberry32, TAU } from './util';

type G = CanvasRenderingContext2D;

/** Per-draw state handed to the skin hooks. Callers reuse one object (no per-frame allocation). */
export interface SkinFrame {
  /** Seconds. */
  t: number;
  facing: 1 | -1;
  moving: boolean;
  seed: number;
  /** Drawing a ghost (silhouette = ghostPath, no legs). */
  ghost: boolean;
  /** The eyes are closed this frame. */
  blink: boolean;
  /** Laser beam length multiplier (1 in the world, shorter in small previews). */
  beamScale: number;
}

export interface SkinPainter {
  /** Extra height above the pill top (px), so name labels clear accessories like the crown. */
  headroom: number;
  legs?: (g: G) => string | CanvasGradient;
  surface?: (g: G, f: SkinFrame) => void;
  over?: (g: G, f: SkinFrame) => void;
}

// ---------- shared helpers ----------

/** 4-point twinkle star. */
export function sparkle(g: G, x: number, y: number, r: number, color: string): void {
  if (r <= 0.05) return;
  g.beginPath();
  g.moveTo(x, y - r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.quadraticCurveTo(x, y, x, y + r);
  g.quadraticCurveTo(x, y, x - r, y);
  g.quadraticCurveTo(x, y, x, y - r);
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

/** Sharp periodic peaks in [0, 1] (mostly 0): a twinkle envelope. */
export function twinkle(t: number, rate: number, phase: number, sharp = 8): number {
  const s = Math.sin(t * rate + phase);
  return s > 0 ? Math.pow(s, sharp) : 0;
}

function silhouette(g: G, f: SkinFrame): void {
  g.beginPath();
  if (f.ghost) ghostPath(g, f.t, f.seed);
  else capsulePath(g, PILL_CY, PILL_W, PILL_H);
}

interface Grads {
  lens: CanvasGradient;
  lensSheen: CanvasGradient;
  goldBand: CanvasGradient;
  goldRim: CanvasGradient;
  crown: CanvasGradient;
  crownBand: CanvasGradient;
  beamCore: CanvasGradient;
  beamOuter: CanvasGradient;
  laserGlow: CanvasGradient;
}

const gradCache = new WeakMap<G, Grads>();

function grads(g: G): Grads {
  let k = gradCache.get(g);
  if (k) return k;
  const lens = g.createLinearGradient(0, EYE_Y - 3, 0, EYE_Y + 2.7);
  lens.addColorStop(0, '#3b4252');
  lens.addColorStop(0.45, '#0d1016');
  lens.addColorStop(1, '#000000');
  const lensSheen = g.createLinearGradient(-9, 0, 9, 0);
  lensSheen.addColorStop(0, '#9945ff');
  lensSheen.addColorStop(1, '#14f195');
  const goldBand = g.createLinearGradient(0, PILL_CY - 1.8, 0, PILL_CY + 1.8);
  goldBand.addColorStop(0, '#fff3a8');
  goldBand.addColorStop(0.45, '#ffcc2e');
  goldBand.addColorStop(1, '#a87400');
  const goldRim = g.createLinearGradient(-PILL_R, PILL_TOP, PILL_R, PILL_BOTTOM);
  goldRim.addColorStop(0, '#fff6bf');
  goldRim.addColorStop(0.3, '#ffd23a');
  goldRim.addColorStop(0.6, '#c98d00');
  goldRim.addColorStop(0.8, '#ffe066');
  goldRim.addColorStop(1, '#a87400');
  const crown = g.createLinearGradient(0, -12, 0, 0);
  crown.addColorStop(0, '#fff6bf');
  crown.addColorStop(0.4, '#ffd23a');
  crown.addColorStop(1, '#d08f00');
  const crownBand = g.createLinearGradient(0, -3.6, 0, 0);
  crownBand.addColorStop(0, '#ffcf33');
  crownBand.addColorStop(1, '#a36d00');
  const beamCore = g.createLinearGradient(0, 0, 1, 0);
  beamCore.addColorStop(0, 'rgba(255,246,214,1)');
  beamCore.addColorStop(0.25, 'rgba(255,170,110,0.95)');
  beamCore.addColorStop(0.7, 'rgba(255,84,36,0.55)');
  beamCore.addColorStop(1, 'rgba(255,60,20,0)');
  const beamOuter = g.createLinearGradient(0, 0, 1, 0);
  beamOuter.addColorStop(0, 'rgba(255,96,40,0.75)');
  beamOuter.addColorStop(0.6, 'rgba(255,70,30,0.3)');
  beamOuter.addColorStop(1, 'rgba(255,60,20,0)');
  const laserGlow = g.createRadialGradient(0, 0, 0, 0, 0, 7);
  laserGlow.addColorStop(0, 'rgba(255,236,200,0.95)');
  laserGlow.addColorStop(0.3, 'rgba(255,110,50,0.7)');
  laserGlow.addColorStop(1, 'rgba(255,60,20,0)');
  k = { lens, lensSheen, goldBand, goldRim, crown, crownBand, beamCore, beamOuter, laserGlow };
  gradCache.set(g, k);
  return k;
}

// ---------- Green Candles: a pump chart printed on the off-white half ----------

// x, body top, body bottom, wick top, wick bottom
const CANDLES = [-8.2, 1.2, 5.2, -0.6, 6.8, -3.1, -1.8, 2.8, -3.6, 4.2, 2.0, -4.8, -0.4, -6.6, 1.0, 7.1, -8.0, -3.0, -10.2, -1.6];
const CANDLE_W = 3.6;

function candlesSurface(g: G, f: SkinFrame): void {
  const pump = 0.5 + 0.5 * Math.sin(f.t * 3.1 + f.seed);
  // Faint chart grid on the off-white half.
  g.fillStyle = 'rgba(20,90,55,0.13)';
  for (let y = -6; y <= 6; y += 4) g.fillRect(-PILL_R, y, PILL_W, 0.5);
  g.lineWidth = 0.9;
  g.strokeStyle = '#0a5a35';
  g.beginPath();
  for (let i = 0; i < CANDLES.length; i += 5) {
    const last = i === CANDLES.length - 5;
    const x = CANDLES[i];
    g.moveTo(x, CANDLES[i + 3] - (last ? pump * 1.8 : 0));
    g.lineTo(x, CANDLES[i + 4]);
  }
  g.stroke();
  g.beginPath();
  for (let i = 0; i < CANDLES.length; i += 5) {
    const last = i === CANDLES.length - 5;
    const top = CANDLES[i + 1] - (last ? pump * 1.4 : 0);
    g.rect(CANDLES[i] - CANDLE_W / 2, top, CANDLE_W, CANDLES[i + 2] - top);
  }
  g.fillStyle = '#16c46c';
  g.fill();
  g.lineWidth = 0.8;
  g.stroke();
  // Candle highlights.
  g.fillStyle = 'rgba(255,255,255,0.45)';
  for (let i = 0; i < CANDLES.length; i += 5) {
    const last = i === CANDLES.length - 5;
    const top = CANDLES[i + 1] - (last ? pump * 1.4 : 0);
    g.fillRect(CANDLES[i] - CANDLE_W / 2 + 0.6, top + 0.6, 0.8, CANDLES[i + 2] - top - 1.2);
  }
}

// ---------- Cabal Shades ----------

function lensPath(g: G, cx: number): void {
  const top = EYE_Y - 3;
  const bot = EYE_Y + 2.7;
  g.moveTo(cx - 4.7, top);
  g.lineTo(cx + 4.7, top);
  g.lineTo(cx + 4.3, top + 2.4);
  g.quadraticCurveTo(cx + 3.9, bot, cx, bot);
  g.quadraticCurveTo(cx - 3.9, bot, cx - 4.3, top + 2.4);
  g.closePath();
}

function shadesOver(g: G, f: SkinFrame): void {
  const k = grads(g);
  const fx = f.facing;
  const c0 = fx * EYE_SHIFT;
  const a0 = g.globalAlpha;
  const top = EYE_Y - 3;
  // Temple arm toward the back of the head, and the bridge.
  g.strokeStyle = '#05070a';
  g.lineCap = 'round';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(c0 - fx * (EYE_GAP + 4.2), top + 0.9);
  g.lineTo(-fx * (PILL_R - 0.6), top + 0.4);
  g.moveTo(c0 - 1.4, top + 0.9);
  g.lineTo(c0 + 1.4, top + 0.9);
  g.stroke();
  // Lenses.
  g.beginPath();
  lensPath(g, c0 - EYE_GAP);
  lensPath(g, c0 + EYE_GAP);
  g.fillStyle = k.lens;
  g.fill();
  g.lineJoin = 'round';
  g.lineWidth = 1.3;
  g.stroke();
  // Solana sheen along the top rim, and a static reflection.
  g.fillStyle = k.lensSheen;
  g.globalAlpha = a0 * 0.95;
  g.fillRect(c0 - EYE_GAP - 3.9, top + 0.55, 7.8, 0.85);
  g.fillRect(c0 + EYE_GAP - 3.9, top + 0.55, 7.8, 0.85);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  for (let s = -1; s <= 1; s += 2) {
    const cx = c0 + s * EYE_GAP;
    g.beginPath();
    g.moveTo(cx - 2.6, top + 1.9);
    g.lineTo(cx - 1.4, top + 1.9);
    g.lineTo(cx - 2.6, top + 4.6);
    g.lineTo(cx - 3.4, top + 4.0);
    g.closePath();
    g.fill();
  }
  // A glint slides across now and then.
  const p = ((f.t + f.seed * 0.0137) % 3.6) / 0.55;
  if (p < 1) {
    g.save();
    g.beginPath();
    lensPath(g, c0 - EYE_GAP);
    lensPath(g, c0 + EYE_GAP);
    g.clip();
    const gx = c0 - 11 + p * 22;
    g.globalAlpha = a0 * 0.85;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(gx, top - 1);
    g.lineTo(gx + 2.2, top - 1);
    g.lineTo(gx - 1.2, top + 7);
    g.lineTo(gx - 3.4, top + 7);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.globalAlpha = a0;
}

// ---------- Diamond Hands: crystal facets + sparkles ----------

// Facet mesh vertices (x, y).
const DV = [
  0, -31, -13, -25, -4.5, -26.4, 4.5, -26.4, 13, -25, // 0-4: top
  -14, -17.5, -7, -19.2, 0, -20.6, 7, -19.2, 14, -17.5, // 5-9: middle
  -14, -10, -5, -10, 5, -10, 14, -10, // 10-13: seam
  -13, 1.5, -4, 3.8, 4, 3.8, 13, 1.5, 0, 11, // 14-18: bottom half
];
// Triangles grouped by tone: light, mid, dark (top half), then ice tones for the bottom half.
const TRI_LIGHT = [0, 1, 2, 0, 3, 4, 1, 5, 6, 2, 6, 7, 3, 7, 8, 5, 10, 6, 6, 11, 7, 8, 12, 13];
const TRI_MID = [0, 2, 3, 1, 6, 2, 3, 8, 4, 7, 12, 8, 6, 10, 11];
const TRI_DARK = [2, 7, 3, 4, 8, 9, 7, 11, 12, 8, 13, 9];
const TRI_ICE_A = [10, 14, 11, 11, 15, 12, 12, 17, 13, 15, 18, 16];
const TRI_ICE_B = [11, 14, 15, 12, 15, 16, 12, 16, 17, 14, 18, 15, 16, 18, 17];
const SPARKS = [-6.5, -24, 7.5, -21.5, -9.5, -13.5, 3.5, -27.5, 1.5, 1.5, 9, 5];

function trianglesPath(g: G, tris: readonly number[]): void {
  g.beginPath();
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 2;
    const b = tris[i + 1] * 2;
    const c = tris[i + 2] * 2;
    g.moveTo(DV[a], DV[a + 1]);
    g.lineTo(DV[b], DV[b + 1]);
    g.lineTo(DV[c], DV[c + 1]);
    g.closePath();
  }
}

function diamondSurface(g: G, f: SkinFrame): void {
  const a0 = g.globalAlpha;
  const shimmer = f.moving ? 0.5 + 0.5 * Math.sin(f.t * 9 + f.seed) : 0.5 + 0.5 * Math.sin(f.t * 2.2 + f.seed);
  // Light facets stay gentle so the saturated player color shows through (Red vs Pink stays clear).
  trianglesPath(g, TRI_LIGHT);
  g.fillStyle = 'rgba(255,255,255,1)';
  g.globalAlpha = a0 * (0.2 + 0.12 * shimmer);
  g.fill();
  trianglesPath(g, TRI_MID);
  g.fillStyle = 'rgba(190,240,255,1)';
  g.globalAlpha = a0 * (0.1 + 0.08 * (1 - shimmer));
  g.fill();
  trianglesPath(g, TRI_DARK);
  g.fillStyle = 'rgba(0,10,30,1)';
  g.globalAlpha = a0 * 0.26;
  g.fill();
  trianglesPath(g, TRI_ICE_A);
  g.fillStyle = 'rgba(120,220,255,1)';
  g.globalAlpha = a0 * 0.22;
  g.fill();
  trianglesPath(g, TRI_ICE_B);
  g.fillStyle = 'rgba(40,90,140,1)';
  g.globalAlpha = a0 * 0.08;
  g.fill();
  // Facet edges.
  g.globalAlpha = a0;
  g.beginPath();
  for (let pass = 0; pass < 5; pass++) {
    const tris = pass === 0 ? TRI_LIGHT : pass === 1 ? TRI_MID : pass === 2 ? TRI_DARK : pass === 3 ? TRI_ICE_A : TRI_ICE_B;
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i] * 2;
      const b = tris[i + 1] * 2;
      const c = tris[i + 2] * 2;
      g.moveTo(DV[a], DV[a + 1]);
      g.lineTo(DV[b], DV[b + 1]);
      g.lineTo(DV[c], DV[c + 1]);
      g.closePath();
    }
  }
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.lineWidth = 0.6;
  g.stroke();
}

function diamondOver(g: G, f: SkinFrame): void {
  const rate = f.moving ? 7 : 2.4;
  const boost = f.moving ? 1.25 : 1;
  for (let i = 0; i < SPARKS.length; i += 2) {
    const tw = twinkle(f.t, rate, i * 1.37 + f.seed * 0.1, 10);
    if (tw < 0.04) continue;
    const x = SPARKS[i];
    const y = SPARKS[i + 1];
    sparkle(g, x, y, 4.2 * tw * boost, 'rgba(255,255,255,0.95)');
    g.beginPath();
    g.arc(x, y, 0.9 * tw * boost, 0, TAU);
    g.fillStyle = '#bff6ff';
    g.fill();
  }
}

// ---------- On-Chain: hex digits streaming down ----------
// Two textures with the same digits: light ones on the colored half, dark terminal-green ones on
// the off-white half, so the streams read on every player color and continue across the seam.

const HEX_COLS = 4;
const HEX_COL_W = 6;
const HEX_ROWS = 16;
const HEX_ROW_H = 5.2;
const HEX_LOOP = HEX_ROWS * HEX_ROW_H;
const HEX_PX = 4;
/** Brightness down a stream's trail, from its head (the lowest, newest digit) upward. */
const HEX_TRAIL = [1, 0.62, 0.42, 0.27, 0.16];
let hexStrips: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
let hexStripFonts = false;

function fontsLoaded(): boolean {
  const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
  return !!fonts && fonts.status === 'loaded';
}

function buildHexStrip(dark: boolean): HTMLCanvasElement {
  const c = createCanvas(HEX_COLS * HEX_COL_W * HEX_PX, HEX_LOOP * HEX_PX);
  const g = get2d(c);
  g.scale(HEX_PX, HEX_PX);
  g.font = `700 4.9px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  // Same seed for both variants: identical digits and streams.
  const rnd = mulberry32(0x0c4a17);
  const digits = '0123456789abcdef';
  for (let col = 0; col < HEX_COLS; col++) {
    const h1 = Math.floor(rnd() * HEX_ROWS);
    const h2 = (h1 + 7 + Math.floor(rnd() * 3)) % HEX_ROWS;
    const x = (col + 0.5) * HEX_COL_W;
    for (let j = 0; j < HEX_ROWS; j++) {
      const ch = digits[Math.floor(rnd() * 16)];
      const d = Math.min((h1 - j + HEX_ROWS) % HEX_ROWS, (h2 - j + HEX_ROWS) % HEX_ROWS);
      if (d >= HEX_TRAIL.length) continue;
      const a = HEX_TRAIL[d];
      const y = (j + 0.5) * HEX_ROW_H;
      if (dark) {
        g.fillStyle = d === 0 ? '#08a35f' : `rgba(16,52,40,${(a * 0.85).toFixed(3)})`;
      } else {
        g.strokeStyle = `rgba(4,8,12,${(0.45 * a).toFixed(3)})`;
        g.lineWidth = 1.1;
        g.strokeText(ch, x, y);
        g.fillStyle = d === 0 ? '#eafff3' : `rgba(255,255,255,${(a * 0.9).toFixed(3)})`;
      }
      g.fillText(ch, x, y);
    }
  }
  return c;
}

function drawHexColumns(g: G, strip: HTMLCanvasElement, f: SkinFrame): void {
  const sw = HEX_COL_W * HEX_PX;
  const sh = HEX_LOOP * HEX_PX;
  const x0 = -(HEX_COLS * HEX_COL_W) / 2;
  for (let col = 0; col < HEX_COLS; col++) {
    const speed = 8 + ((col * 7) % 4) * 2.3;
    const off = (f.t * speed + col * 17.3 + f.seed) % HEX_LOOP;
    const y0 = PILL_TOP - HEX_LOOP + off;
    const dx = x0 + col * HEX_COL_W;
    g.drawImage(strip, col * sw, 0, sw, sh, dx, y0, HEX_COL_W, HEX_LOOP);
    g.drawImage(strip, col * sw, 0, sw, sh, dx, y0 + HEX_LOOP, HEX_COL_W, HEX_LOOP);
  }
}

function onchainSurface(g: G, f: SkinFrame): void {
  if (!hexStrips || (!hexStripFonts && fontsLoaded())) {
    hexStripFonts = fontsLoaded();
    hexStrips = [buildHexStrip(false), buildHexStrip(true)];
  }
  g.save();
  g.beginPath();
  g.rect(-PILL_R - 2, PILL_TOP - 2, PILL_W + 4, PILL_H / 2 + 2);
  g.clip();
  drawHexColumns(g, hexStrips[0], f);
  g.restore();
  g.save();
  g.beginPath();
  g.rect(-PILL_R - 2, PILL_CY, PILL_W + 4, PILL_H);
  g.clip();
  drawHexColumns(g, hexStrips[1], f);
  g.restore();
}

// ---------- Laser Eyes ----------

function laserOver(g: G, f: SkinFrame): void {
  if (f.blink) return;
  const k = grads(g);
  const a0 = g.globalAlpha;
  const c0 = f.facing * EYE_SHIFT;
  const flick = 0.85 + 0.15 * Math.sin(f.t * 37 + f.seed) * Math.sin(f.t * 11.3);
  const len = 30 * f.beamScale * (0.93 + 0.07 * Math.sin(f.t * 17 + f.seed));
  const ang = f.facing > 0 ? 0.13 : Math.PI - 0.13;
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let s = -1; s <= 1; s += 2) {
    const px = c0 + s * EYE_GAP + f.facing * 1.7;
    const py = EYE_Y + 0.9;
    g.save();
    g.translate(px, py);
    g.rotate(ang + s * f.facing * 0.035);
    g.scale(len, 1);
    g.globalAlpha = a0 * 0.6 * flick;
    g.fillStyle = k.beamOuter;
    g.beginPath();
    g.moveTo(0, -3.4);
    g.lineTo(1, -1.4);
    g.lineTo(1, 1.4);
    g.lineTo(0, 3.4);
    g.closePath();
    g.fill();
    g.globalAlpha = a0 * flick;
    g.fillStyle = k.beamCore;
    g.beginPath();
    g.moveTo(0, -1.25);
    g.lineTo(1, -0.4);
    g.lineTo(1, 0.4);
    g.lineTo(0, 1.25);
    g.closePath();
    g.fill();
    g.restore();
    g.save();
    g.translate(px, py);
    g.globalAlpha = a0 * (0.8 + 0.2 * flick);
    g.fillStyle = k.laserGlow;
    g.beginPath();
    g.arc(0, 0, 7, 0, TAU);
    g.fill();
    g.restore();
  }
  g.restore();
  // Glowing irises over the pupils.
  for (let s = -1; s <= 1; s += 2) {
    const px = c0 + s * EYE_GAP + f.facing * 1.7;
    const py = EYE_Y + 0.9;
    g.beginPath();
    g.arc(px, py, 2.7, 0, TAU);
    g.fillStyle = '#ff5420';
    g.fill();
    g.beginPath();
    g.arc(px - 0.4, py - 0.4, 1.25, 0, TAU);
    g.fillStyle = '#fff6dc';
    g.fill();
  }
}

// ---------- Gold Trim ----------
// Gold stays a trim: a thin rim, the seam band and a shine sweep on the off-white half. The legs and the
// colored cap keep the player's own color, so a Gold Trim pill never reads as "the gold player".

function goldSurface(g: G, f: SkinFrame): void {
  const a0 = g.globalAlpha;
  g.save();
  // Only the off-white half: the colored cap stays a solid player color.
  g.beginPath();
  g.rect(-PILL_R - 2, PILL_CY + 1.7, PILL_W + 4, PILL_H);
  g.clip();
  const p = ((f.t + f.seed * 0.01) % 2.8) / 2.8;
  const x = -26 + p * 56;
  g.globalAlpha = a0 * 0.4;
  g.fillStyle = '#fff6cf';
  g.beginPath();
  g.moveTo(x, PILL_TOP - 4);
  g.lineTo(x + 5, PILL_TOP - 4);
  g.lineTo(x - 9, PILL_BOTTOM + 6);
  g.lineTo(x - 14, PILL_BOTTOM + 6);
  g.closePath();
  g.fill();
  g.globalAlpha = a0 * 0.55;
  g.beginPath();
  g.moveTo(x + 7, PILL_TOP - 4);
  g.lineTo(x + 8.6, PILL_TOP - 4);
  g.lineTo(x - 5.4, PILL_BOTTOM + 6);
  g.lineTo(x - 7, PILL_BOTTOM + 6);
  g.closePath();
  g.fill();
  g.restore();
  g.globalAlpha = a0;
}

function goldOver(g: G, f: SkinFrame): void {
  const k = grads(g);
  if (!f.ghost) {
    // Gold seam band.
    g.fillStyle = k.goldBand;
    g.fillRect(-PILL_R + 0.5, PILL_CY - 1.7, PILL_W - 1, 3.4);
    g.fillStyle = 'rgba(70,40,0,0.55)';
    g.fillRect(-PILL_R + 0.5, PILL_CY + 1.7, PILL_W - 1, 0.5);
    // Rim, just inside the dark outline.
    g.beginPath();
    capsulePath(g, PILL_CY, PILL_W - 1.7, PILL_H - 1.7);
  } else {
    silhouette(g, f);
  }
  g.strokeStyle = k.goldRim;
  g.lineWidth = 1;
  g.stroke();
  const tw = twinkle(f.t, 1.9, f.seed, 12);
  if (tw > 0.04) sparkle(g, -8.5, PILL_TOP + 4.5, 3.6 * tw, 'rgba(255,250,220,0.95)');
}

// ---------- Whale Crown ----------

function crownOver(g: G, f: SkinFrame): void {
  const k = grads(g);
  g.save();
  g.translate(f.facing * 1.2, PILL_TOP + 3.4);
  g.rotate(f.facing * 0.09);
  g.beginPath();
  g.moveTo(-9, 0);
  g.lineTo(-9.8, -9.4);
  g.lineTo(-4.7, -5.0);
  g.lineTo(0, -11.8);
  g.lineTo(4.7, -5.0);
  g.lineTo(9.8, -9.4);
  g.lineTo(9, 0);
  g.closePath();
  g.fillStyle = k.crown;
  g.fill();
  g.lineJoin = 'round';
  g.lineWidth = 1.2;
  g.strokeStyle = '#3d2600';
  g.stroke();
  // Band.
  g.beginPath();
  g.rect(-9.2, -3.6, 18.4, 3.6);
  g.fillStyle = k.crownBand;
  g.fill();
  g.lineWidth = 0.9;
  g.stroke();
  // Highlights.
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = 0.7;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(-8.2, -4.4);
  g.lineTo(-8.7, -7.6);
  g.moveTo(-0.9, -5.4);
  g.lineTo(-0.4, -9.6);
  g.stroke();
  // Gems (never red).
  g.beginPath();
  g.arc(0, -1.8, 1.55, 0, TAU);
  g.fillStyle = '#2f8cff';
  g.fill();
  g.beginPath();
  g.arc(-5.2, -1.8, 1.1, 0, TAU);
  g.arc(5.2, -1.8, 1.1, 0, TAU);
  g.fillStyle = '#14f195';
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(-0.7, -2.7, 0.7, 0.7);
  // Pearls on the tips.
  g.beginPath();
  g.arc(-9.8, -9.6, 1.4, 0, TAU);
  g.moveTo(1.4, -12.1);
  g.arc(0, -12.1, 1.4, 0, TAU);
  g.moveTo(11.2, -9.6);
  g.arc(9.8, -9.6, 1.4, 0, TAU);
  g.fillStyle = '#fff8dc';
  g.fill();
  g.lineWidth = 0.6;
  g.strokeStyle = '#3d2600';
  g.stroke();
  const tw = twinkle(f.t, 1.6, f.seed * 0.3, 10);
  if (tw > 0.04) sparkle(g, 0, -12.1, 4.2 * tw, 'rgba(255,255,255,0.95)');
  g.restore();
}

// ---------- Holo Pill: animated rainbow foil ----------

const HOLO_P = 36;
const HOLO_W = PILL_W + HOLO_P + 2;
const HOLO_H = PILL_H + 22;
const HOLO_PX = 3;
let holoStrip: HTMLCanvasElement | null = null;

function buildHolo(): HTMLCanvasElement {
  const c = createCanvas(HOLO_W * HOLO_PX, HOLO_H * HOLO_PX);
  const g = get2d(c);
  g.scale(HOLO_PX, HOLO_PX);
  const grad = g.createLinearGradient(0, 0, HOLO_P, 0);
  grad.addColorStop(0, '#ff7ad9');
  grad.addColorStop(0.17, '#ffd36e');
  grad.addColorStop(0.34, '#9dff8a');
  grad.addColorStop(0.5, '#6ee7ff');
  grad.addColorStop(0.67, '#7d8bff');
  grad.addColorStop(0.84, '#c77dff');
  grad.addColorStop(1, '#ff7ad9');
  g.transform(1, 0, -0.6, 1, 0, 0);
  for (let k = -1; k * HOLO_P < HOLO_W + HOLO_H; k++) {
    g.save();
    g.translate(k * HOLO_P, 0);
    g.fillStyle = grad;
    g.fillRect(0, 0, HOLO_P, HOLO_H);
    g.restore();
  }
  // Fine foil lines.
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 0.35;
  g.beginPath();
  for (let x = 0; x < HOLO_W + HOLO_H; x += 2.25) {
    g.moveTo(x, 0);
    g.lineTo(x, HOLO_H);
  }
  g.stroke();
  return c;
}

const GLITTER = [-7, -24, 6, -19, -3, -13, 8, -2, -8, 3, 2, 7, 9, -27];

function holoSurface(g: G, f: SkinFrame): void {
  holoStrip ??= buildHolo();
  const a0 = g.globalAlpha;
  const off = (f.t * 14 + f.seed) % HOLO_P;
  const dx = -PILL_R - 1 - off;
  // Off-white half: full foil.
  g.save();
  g.beginPath();
  g.rect(-PILL_R - 2, PILL_CY, PILL_W + 4, PILL_H);
  g.clip();
  g.globalAlpha = a0 * 0.7;
  g.drawImage(holoStrip, dx, PILL_TOP, HOLO_W, HOLO_H);
  g.restore();
  // Colored half: soft iridescence that keeps the hue.
  g.save();
  g.beginPath();
  g.rect(-PILL_R - 2, PILL_TOP - 2, PILL_W + 4, PILL_H / 2 + 2);
  g.clip();
  g.globalCompositeOperation = 'soft-light';
  g.globalAlpha = a0 * 0.7;
  g.drawImage(holoStrip, dx, PILL_TOP, HOLO_W, HOLO_H);
  g.globalCompositeOperation = 'lighter';
  const p = ((f.t * 0.55 + f.seed * 0.01) % 1) * 60 - 22;
  g.globalAlpha = a0 * 0.3;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(p, PILL_TOP - 4);
  g.lineTo(p + 4, PILL_TOP - 4);
  g.lineTo(p - 8, PILL_CY + 4);
  g.lineTo(p - 12, PILL_CY + 4);
  g.closePath();
  g.fill();
  g.restore();
  // Glitter.
  for (let i = 0; i < GLITTER.length; i += 2) {
    const tw = twinkle(f.t, 3.1, i * 0.9 + f.seed * 0.07, 6);
    if (tw > 0.05) sparkle(g, GLITTER[i], GLITTER[i + 1], 2.6 * tw, 'rgba(255,255,255,0.95)');
  }
}

// ---------- registry ----------

const SKINS: Record<string, SkinPainter> = {
  skin_candles: { headroom: 0, surface: candlesSurface },
  skin_shades: { headroom: 0, over: shadesOver },
  skin_diamond: { headroom: 0, surface: diamondSurface, over: diamondOver },
  skin_onchain: { headroom: 0, surface: onchainSurface },
  skin_laser: { headroom: 0, over: laserOver },
  skin_gold: { headroom: 0, surface: goldSurface, over: goldOver },
  skin_crown: { headroom: 11, over: crownOver },
  skin_holo: { headroom: 0, surface: holoSurface },
};

/** The painter for a skin id, or undefined (none equipped, or an id this client doesn't know). */
export function skinPainter(id: string | null | undefined): SkinPainter | undefined {
  return id && Object.prototype.hasOwnProperty.call(SKINS, id) ? SKINS[id] : undefined;
}

/** Extra space a skin needs above the pill top (0 for most). */
export function skinHeadroom(id: string | null | undefined): number {
  return skinPainter(id)?.headroom ?? 0;
}

export const SKIN_IDS: readonly string[] = Object.keys(SKINS);
