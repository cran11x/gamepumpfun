// Animated pill previews on small canvases (shop cards, profile preview, lobby rows, meeting / ejection /
// game-over pills with a skin). They draw with render/cosmetics drawPillPreview, the same code as the
// world, from one shared requestAnimationFrame loop capped at ~30 fps. Canvases that leave the DOM
// for a couple of seconds are dropped automatically, so screens that rebuild rows never leak them.

import type { EquippedCosmetics } from '../../../shared/protocol';
import { drawPillPreview, type PillPreviewOptions } from '../render/cosmetics';

export interface PreviewOpts extends PillPreviewOptions {
  /** Extra zoom over the default fit (1 = the 64 px preview box fills the shorter canvas side). */
  zoom?: number;
  /** Vertical nudge as a fraction of the canvas height (positive = down). */
  shiftY?: number;
}

export interface PillPreview {
  el: HTMLCanvasElement;
  set(color: number, equipped: EquippedCosmetics | null | undefined, opts?: PreviewOpts): void;
  destroy(): void;
}

interface Entry {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D | null;
  w: number;
  h: number;
  color: number;
  equipped: EquippedCosmetics | null;
  opts: PreviewOpts;
  dirty: boolean;
  goneSince: number;
  dpr: number;
}

const FRAME_MS = 33;
const PRUNE_MS = 2500;
const live = new Set<Entry>();
let raf = 0;
let lastFrame = 0;

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function draw(e: Entry, t: number): void {
  const g = e.g;
  if (!g) return;
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  if (dpr !== e.dpr) {
    e.dpr = dpr;
    e.canvas.width = Math.round(e.w * dpr);
    e.canvas.height = Math.round(e.h * dpr);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, e.canvas.width, e.canvas.height);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scale = (Math.min(e.w, e.h) / 64) * (e.opts.zoom ?? 1);
  try {
    drawPillPreview(g, e.w / 2, e.h / 2 + (e.opts.shiftY ?? 0) * e.h, scale, e.color, e.equipped, t, e.opts);
  } catch (err) {
    console.error('[ui] pill preview failed', err);
    e.g = null;
  }
  e.dirty = false;
}

function loop(now: number): void {
  raf = 0;
  if (!live.size) return;
  const animate = !reducedMotion();
  if (now - lastFrame >= FRAME_MS || !animate) {
    lastFrame = now;
    for (const e of live) {
      if (!e.canvas.isConnected) {
        if (!e.goneSince) e.goneSince = now;
        else if (now - e.goneSince > PRUNE_MS) live.delete(e);
        continue;
      }
      e.goneSince = 0;
      // Hidden (display:none tab, closed panel): skip until it shows again.
      if (e.canvas.offsetParent === null) continue;
      if (animate || e.dirty) draw(e, animate ? now : 1200);
    }
  }
  if (live.size) raf = requestAnimationFrame(loop);
}

function kick(): void {
  if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(loop);
}

/** A `w` x `h` CSS-pixel canvas drawing a pill preview (h defaults to w). */
export function createPillPreview(
  w: number,
  color: number,
  equipped: EquippedCosmetics | null | undefined,
  opts: PreviewOpts & { h?: number; cls?: string } = {},
): PillPreview {
  const canvas = document.createElement('canvas');
  const h = opts.h ?? w;
  canvas.className = `pv ${opts.cls ?? ''}`.trim();
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.setAttribute('aria-hidden', 'true');
  let g: CanvasRenderingContext2D | null = null;
  try {
    g = canvas.getContext('2d');
  } catch {
    g = null;
  }
  const e: Entry = { canvas, g, w, h, color, equipped: equipped ? { ...equipped } : null, opts: { ...opts }, dirty: true, goneSince: 0, dpr: 0 };
  live.add(e);
  draw(e, 1200);
  kick();
  return {
    el: canvas,
    set(c, eq, o) {
      e.color = c;
      e.equipped = eq ? { ...eq } : null;
      if (o) e.opts = { ...e.opts, ...o };
      e.dirty = true;
      if (!live.has(e)) live.add(e);
      draw(e, performance.now());
      kick();
    },
    destroy() {
      live.delete(e);
    },
  };
}

/** Equipped cosmetics as other players see them outside your own bag: the skin only (rugs stay private). */
export function publicLook(c: EquippedCosmetics | null | undefined): EquippedCosmetics | null {
  return c?.skin ? { skin: c.skin } : null;
}
