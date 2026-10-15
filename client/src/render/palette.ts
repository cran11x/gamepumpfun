// Color tokens and fonts for the canvas world (mirrors the SPEC art direction).

import { PLAYER_COLORS } from '../../../shared/constants';

export const COLORS = {
  bg: '#07090d',
  floor: '#10151d',
  wall: '#1b2330',
  wallFaceTop: '#151c27',
  wallFaceBottom: '#0b0f15',
  hallNeon: '#6f86a8',
  pump: '#2bff88',
  rug: '#ff3b5c',
  gold: '#ffd400',
  sol: '#9945ff',
  solGreen: '#14f195',
  offWhite: '#f2f4f7',
  offWhiteShade: '#b9c2ce',
  ink: '#05070a',
  text: '#e8eef5',
  legs: '#1a202b',
  darkness: 'rgba(3, 5, 9, 0.9)',
  darknessFud: 'rgba(2, 3, 6, 0.95)',
} as const;

export const FONT_TITLE = 'Bungee, "Space Grotesk", system-ui, sans-serif';
export const FONT_TEXT = '"Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

const labelFontCache = new Map<number, string>();
/** Bold text font for canvas name labels, cached per half-pixel size. */
export function labelFont(size: number): string {
  const q = Math.round(size * 2) / 2;
  let f = labelFontCache.get(q);
  if (!f) {
    f = `700 ${q}px ${FONT_TEXT}`;
    labelFontCache.set(q, f);
  }
  return f;
}

export function playerColor(i: number): { name: string; body: string; dark: string } {
  const n = PLAYER_COLORS.length;
  const idx = Number.isFinite(i) ? ((Math.trunc(i) % n) + n) % n : 0;
  return PLAYER_COLORS[idx];
}

const rgbCache = new Map<string, [number, number, number]>();
const rgbaCache = new Map<string, string>();

function parseHex(hex: string): [number, number, number] {
  let v = rgbCache.get(hex);
  if (v) return v;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  v = Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
  rgbCache.set(hex, v);
  return v;
}

/** `#rrggbb` + alpha -> cached `rgba()` string (alpha quantized to 1/100 to bound the cache). */
export function rgba(hex: string, a: number): string {
  const q = Math.round(Math.max(0, Math.min(1, a)) * 100);
  const key = hex + '|' + q;
  let s = rgbaCache.get(key);
  if (s === undefined) {
    const [r, g, b] = parseHex(hex);
    s = `rgba(${r},${g},${b},${q / 100})`;
    rgbaCache.set(key, s);
  }
  return s;
}

/** Mix two hex colors (t = 0 -> a, 1 -> b). */
export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bl = Math.round(b1 + (b2 - b1) * t);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}
