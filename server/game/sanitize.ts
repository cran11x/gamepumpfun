// Text and settings sanitization for anything a client (or a bot) hands the server.

import { MAX_CHAT_LENGTH, MAX_NAME_LENGTH, SETTINGS_BOUNDS, type GameSettings } from '../../shared/constants';

/**
 * Control characters plus invisible / layout-breaking code points: C0/C1 controls, soft hyphen,
 * Arabic letter mark, Hangul fillers, zero-width spaces and joiners, bidi overrides and isolates,
 * word joiners, BOM and interlinear annotation marks. Stripping these keeps names from being blank,
 * invisible or able to flip the direction of surrounding UI text on stream.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
];
const esc = (cp: number) => `\\u${cp.toString(16).padStart(4, '0')}`;
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`)).join('')}]`,
  'g',
);
/** Collapse "zalgo" stacks: keep at most 3 combining marks in a row. */
const MARK_STACK = /(\p{M}{3})\p{M}+/gu;
const WHITESPACE = /\s+/gu;

function clean(raw: string): string {
  return raw
    .replace(/[\t\n\r\v\f]/g, ' ')
    .replace(INVISIBLE, '')
    .replace(MARK_STACK, '$1')
    .replace(WHITESPACE, ' ')
    .trim();
}

/** Truncate by code points so surrogate pairs (emoji) are never split. */
function truncate(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('').trim() : s;
}

/** Trimmed, control characters stripped, at most MAX_NAME_LENGTH; empty becomes `anon`. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'anon';
  const s = truncate(clean(raw.slice(0, 512)), MAX_NAME_LENGTH);
  return s.length > 0 ? s : 'anon';
}

/** Cut to MAX_CHAT_LENGTH, control characters stripped. Returns null for an empty message. */
export function sanitizeChat(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = truncate(clean(raw.slice(0, 2048)), MAX_CHAT_LENGTH);
  return s.length > 0 ? s : null;
}

type NumericSetting = keyof typeof SETTINGS_BOUNDS;
const NUMERIC_KEYS = Object.keys(SETTINGS_BOUNDS) as NumericSetting[];

/** Clamp one numeric setting into its inclusive bounds and snap it onto the step grid. */
export function clampSetting(key: NumericSetting, value: number): number {
  const { min, max, step } = SETTINGS_BOUNDS[key];
  let v = Math.min(max, Math.max(min, value));
  if (step > 0) v = min + Math.round((v - min) / step) * step;
  v = Math.min(max, Math.max(min, v));
  // Kill float noise such as 0.7500000001.
  return Math.round(v * 1000) / 1000;
}

/** Apply a partial settings patch onto `base`, clamping every field to SETTINGS_BOUNDS. Unknown or mistyped fields are ignored. */
export function clampSettings(base: GameSettings, patch: Partial<GameSettings>): GameSettings {
  const out: GameSettings = { ...base };
  for (const key of NUMERIC_KEYS) {
    const v = patch[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clampSetting(key, v);
  }
  if (typeof patch.confirmEjects === 'boolean') out.confirmEjects = patch.confirmEjects;
  if (typeof patch.isPublic === 'boolean') out.isPublic = patch.isPublic;
  return out;
}

/** Defensive copy of a full settings object with every field clamped (used for initial settings). */
export function normalizeSettings(base: GameSettings, patch?: Partial<GameSettings>): GameSettings {
  const clamped = clampSettings(base, base);
  return patch ? clampSettings(clamped, patch) : clamped;
}
