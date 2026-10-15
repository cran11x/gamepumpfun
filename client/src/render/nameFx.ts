// Name effects for canvas name labels (see shared/cosmetics.ts). Never red: fellow ruggers see each
// other's names in rug red, so every color here stays out of the red family (the rainbow skips red
// hues, fire stays orange-gold). And the red rule wins: a label that is red for this viewer is drawn
// plain red with no effect (labelEffect), so an effect can never hide the ally-red signal.
//
// No per-frame allocation: fonts, text widths, per-letter offsets, gradients and the rainbow palette
// are all cached.

import type { EquippedCosmetics } from '../../../shared/protocol';
import { labelFont, rgba } from './palette';
import { sparkle, twinkle } from './skins';
import { hash01 } from './util';

type G = CanvasRenderingContext2D;

export const NAME_FX_IDS: readonly string[] = ['name_gold', 'name_diamond', 'name_glitch', 'name_rainbow', 'name_fire'];

export function isKnownNameFx(id: string | null | undefined): boolean {
  return !!id && NAME_FX_IDS.includes(id);
}

/**
 * The name effect to draw on a label, or null. `red`: the label is rug red for this viewer
 * (the viewer's own rugger name, or a fellow rugger's); red always wins over any effect.
 */
export function labelEffect(red: boolean, cosmetics: EquippedCosmetics | null | undefined): string | null {
  if (red) return null;
  const id = cosmetics?.name;
  return id && isKnownNameFx(id) ? id : null;
}

// ---------- caches ----------

interface TextInfo {
  width: number;
  chars: string[] | null;
  /** Left offset of each char (plus the total width at the end). */
  offs: Float32Array | null;
}

const measures = new Map<string, Map<string, TextInfo>>();
let measured = 0;

/** Width (and optionally per-char offsets) of `text` in `font`; `g.font` must already be `font`. */
function textInfo(g: G, font: string, text: string, perChar: boolean): TextInfo {
  let m = measures.get(font);
  if (!m) {
    m = new Map();
    measures.set(font, m);
  }
  let e = m.get(text);
  if (!e) {
    if (++measured > 800) {
      measures.clear();
      measured = 0;
      m = new Map();
      measures.set(font, m);
    }
    e = { width: g.measureText(text).width, chars: null, offs: null };
    m.set(text, e);
  }
  if (perChar && !e.chars) {
    const chars = Array.from(text);
    const offs = new Float32Array(chars.length + 1);
    let prefix = '';
    for (let i = 0; i < chars.length; i++) {
      offs[i] = g.measureText(prefix).width;
      prefix += chars[i];
    }
    offs[chars.length] = e.width;
    e.chars = chars;
    e.offs = offs;
  }
  return e;
}

const gradCache = new WeakMap<G, Map<number, CanvasGradient>>();

/** Vertical text gradient in label-local coordinates (baseline at y = 0), cached per ctx and size. */
function textGrad(g: G, kind: 0 | 1, size: number): CanvasGradient {
  let m = gradCache.get(g);
  if (!m) {
    m = new Map();
    gradCache.set(g, m);
  }
  const key = Math.round(size * 2) * 2 + kind;
  let gr = m.get(key);
  if (!gr) {
    gr = g.createLinearGradient(0, -size * 0.78, 0, size * 0.05);
    if (kind === 0) {
      // Gold.
      gr.addColorStop(0, '#fff6c2');
      gr.addColorStop(0.45, '#ffd84a');
      gr.addColorStop(0.75, '#ffb300');
      gr.addColorStop(1, '#e89400');
    } else {
      // Fire: orange tips, white-hot base.
      gr.addColorStop(0, '#ff8f0f');
      gr.addColorStop(0.5, '#ffc23a');
      gr.addColorStop(1, '#fff3b0');
    }
    m.set(key, gr);
  }
  return gr;
}

function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Rainbow without red: hues sweep orange -> yellow -> green -> cyan -> blue -> violet and back. Blues
 * and violets are lifted so they keep their contrast on the dark floor.
 */
const RAINBOW: readonly string[] = Array.from({ length: 64 }, (_, k) => {
  const hue = 42 + 248 * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / 64));
  const lift = Math.max(0, Math.min(1, (hue - 190) / 50));
  return hslHex(hue, 1, 0.62 + 0.12 * lift);
});

const OUTLINE = 'rgba(4,6,9,0.85)';

// ---------- the five effects ----------

function goldFx(g: G, font: string, text: string, x: number, y: number, size: number, t: number, seed: number): void {
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 + seed);
  g.strokeStyle = rgba('#ffc53d', 0.12 + 0.12 * pulse);
  g.lineWidth = size * 0.62;
  g.strokeText(text, x, y);
  g.strokeStyle = 'rgba(38,22,0,0.92)';
  g.lineWidth = Math.max(2, size * 0.3);
  g.strokeText(text, x, y);
  g.save();
  g.translate(x, y);
  g.fillStyle = textGrad(g, 0, size);
  g.fillText(text, 0, 0);
  g.restore();
  const tw = twinkle(t, 1.7, seed * 0.1, 10);
  if (tw > 0.04) {
    const w = textInfo(g, font, text, false).width;
    sparkle(g, x + w / 2 + size * 0.05, y - size * 0.75, size * 0.55 * tw, 'rgba(255,248,220,0.95)');
  }
}

function gem(g: G, cx: number, cy: number, s: number): void {
  const top = cy - 0.36 * s;
  const gird = cy - 0.1 * s;
  const tip = cy + 0.5 * s;
  g.beginPath();
  g.moveTo(cx - 0.5 * s, gird);
  g.lineTo(cx - 0.28 * s, top);
  g.lineTo(cx + 0.28 * s, top);
  g.lineTo(cx + 0.5 * s, gird);
  g.lineTo(cx, tip);
  g.closePath();
  g.strokeStyle = 'rgba(2,14,24,0.9)';
  g.lineJoin = 'round';
  g.lineWidth = Math.max(1.6, s * 0.2);
  g.stroke();
  g.fillStyle = '#4fd3ff';
  g.fill();
  g.beginPath();
  g.moveTo(cx - 0.28 * s, top);
  g.lineTo(cx + 0.28 * s, top);
  g.lineTo(cx + 0.16 * s, gird);
  g.lineTo(cx - 0.16 * s, gird);
  g.closePath();
  g.fillStyle = '#d4faff';
  g.fill();
  g.beginPath();
  g.moveTo(cx - 0.5 * s, gird);
  g.lineTo(cx - 0.16 * s, gird);
  g.lineTo(cx, tip);
  g.closePath();
  g.fillStyle = '#9beeff';
  g.fill();
  g.beginPath();
  g.moveTo(cx + 0.16 * s, gird);
  g.lineTo(cx + 0.5 * s, gird);
  g.lineTo(cx, tip);
  g.closePath();
  g.fillStyle = '#1e98e0';
  g.fill();
}

function diamondFx(g: G, font: string, text: string, x: number, y: number, size: number, t: number, seed: number): void {
  const w = textInfo(g, font, text, false).width;
  g.strokeStyle = OUTLINE;
  g.lineWidth = Math.max(2, size * 0.3);
  g.strokeText(text, x, y);
  g.fillStyle = '#e8fbff';
  g.fillText(text, x, y);
  const s = size * 1.05;
  const gx = x - w / 2 - s * 0.62;
  const gy = y - size * 0.36;
  gem(g, gx, gy, s);
  const tw = twinkle(t, 2.4, seed * 0.13, 8);
  if (tw > 0.04) sparkle(g, gx + s * 0.3, gy - s * 0.32, s * 0.5 * tw, 'rgba(255,255,255,0.95)');
}

function glitchFx(g: G, font: string, text: string, x: number, y: number, size: number, t: number, seed: number): void {
  const bucket = Math.floor(t * 9);
  const h = hash01(bucket * 131 + seed * 7);
  const on = h < 0.22;
  const jit = on ? (hash01(bucket * 17 + 3) - 0.5) * Math.max(4, size * 0.4) : 0;
  // At small label sizes the split would vanish below a pixel: keep it visible.
  const split = on ? Math.max(2.2, size * 0.13) : Math.max(1.5, size * 0.075);
  const mx = x + jit * 0.5;
  g.strokeStyle = OUTLINE;
  g.lineWidth = Math.max(2, size * 0.3);
  g.strokeText(text, mx, y);
  g.fillStyle = on ? 'rgba(34,229,255,0.95)' : 'rgba(34,229,255,0.7)';
  g.fillText(text, mx - split + jit * 0.5, y);
  g.fillStyle = on ? 'rgba(153,69,255,0.95)' : 'rgba(153,69,255,0.75)';
  g.fillText(text, mx + split, y);
  g.fillStyle = '#ffffff';
  g.fillText(text, mx, y);
  if (on && h < 0.1) {
    // A slice of the name tears sideways.
    const w = textInfo(g, font, text, false).width;
    const by = y - size * (0.25 + hash01(bucket * 29 + 1) * 0.5);
    const bh = size * 0.26;
    const shift = (hash01(bucket * 41 + 5) < 0.5 ? -1 : 1) * size * 0.32;
    g.save();
    g.beginPath();
    g.rect(mx - w / 2 - size, by, w + size * 2, bh);
    g.clip();
    g.fillStyle = 'rgba(4,6,9,0.9)';
    g.fillRect(mx - w / 2 - size * 0.25 + shift, by, w + size * 0.5, bh);
    g.fillStyle = 'rgba(34,229,255,0.95)';
    g.fillText(text, mx + shift - split, y);
    g.fillStyle = '#ffffff';
    g.fillText(text, mx + shift, y);
    g.restore();
  }
}

function rainbowFx(g: G, font: string, text: string, x: number, y: number, size: number, t: number): void {
  const e = textInfo(g, font, text, true);
  const chars = e.chars as string[];
  const offs = e.offs as Float32Array;
  const x0 = x - e.width / 2;
  g.textAlign = 'left';
  g.strokeStyle = OUTLINE;
  g.lineWidth = Math.max(2, size * 0.3);
  const n = chars.length;
  for (let i = 0; i < n; i++) g.strokeText(chars[i], x0 + offs[i], y + Math.sin(t * 5 + i * 0.7) * size * 0.07);
  for (let i = 0; i < n; i++) {
    const k = Math.floor((t * 0.45 + i * 0.075) * 64);
    g.fillStyle = RAINBOW[((k % 64) + 64) % 64];
    g.fillText(chars[i], x0 + offs[i], y + Math.sin(t * 5 + i * 0.7) * size * 0.07);
  }
  g.textAlign = 'center';
}

function fireFx(g: G, font: string, text: string, x: number, y: number, size: number, t: number, seed: number): void {
  const w = textInfo(g, font, text, false).width;
  const n = Math.max(3, Math.round(w / (size * 0.42)));
  const cell = w / n;
  // Flames rise from just above the capitals, so they never sit over the letters (or a "…").
  const base = y - size * 0.74;
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let pass = 0; pass < 2; pass++) {
    const k = pass === 0 ? 1 : 0.58;
    g.fillStyle = pass === 0 ? 'rgba(255,122,0,0.55)' : 'rgba(255,214,64,0.65)';
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const fx = x - w / 2 + (i + 0.5) * cell;
      const fl = 0.55 + 0.45 * Math.sin(t * 9 + i * 1.7 + seed) * Math.sin(t * 5.3 + i * 2.9);
      const hgt = size * (0.34 + 0.34 * fl) * k;
      const fw = cell * 0.62 * k;
      const sway = Math.sin(t * 6 + i * 1.3) * size * 0.1;
      g.moveTo(fx - fw, base);
      g.quadraticCurveTo(fx - fw * 0.9, base - hgt * 0.6, fx + sway, base - hgt);
      g.quadraticCurveTo(fx + fw * 0.9, base - hgt * 0.6, fx + fw, base);
      g.closePath();
    }
    g.fill();
  }
  g.restore();
  g.strokeStyle = 'rgba(42,16,0,0.92)';
  g.lineWidth = Math.max(2, size * 0.3);
  g.strokeText(text, x, y);
  g.save();
  g.translate(x, y);
  g.fillStyle = textGrad(g, 1, size);
  g.fillText(text, 0, 0);
  g.restore();
  // Embers.
  for (let i = 0; i < 4; i++) {
    const ph = (t * 0.9 + hash01(i * 7 + seed)) % 1;
    const ex = x - w / 2 + hash01(i * 13 + seed) * w + Math.sin(t * 3 + i) * size * 0.15;
    const ey = y - size * 0.75 - ph * size * 1.5;
    g.fillStyle = rgba('#ffb33a', 1 - ph);
    const s = size * 0.13 * (1 - ph * 0.5);
    g.fillRect(ex - s / 2, ey - s / 2, s, s);
  }
}

/**
 * Draws `text` centered on (x, y) (alphabetic baseline) at font size `size` with name effect
 * `effect`. Returns false, drawing nothing, for an unknown effect (draw a plain label instead).
 * `t` in seconds; `seed` desyncs animations between players.
 */
export function drawNameFx(g: G, effect: string, text: string, x: number, y: number, size: number, alpha: number, t: number, seed = 0): boolean {
  if (!isKnownNameFx(effect)) return false;
  const font = labelFont(size);
  g.save();
  if (alpha < 1) g.globalAlpha *= alpha;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  switch (effect) {
    case 'name_gold':
      goldFx(g, font, text, x, y, size, t, seed);
      break;
    case 'name_diamond':
      diamondFx(g, font, text, x, y, size, t, seed);
      break;
    case 'name_glitch':
      glitchFx(g, font, text, x, y, size, t, seed);
      break;
    case 'name_rainbow':
      rainbowFx(g, font, text, x, y, size, t);
      break;
    case 'name_fire':
      fireFx(g, font, text, x, y, size, t, seed);
      break;
  }
  g.restore();
  return true;
}
