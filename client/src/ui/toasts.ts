// Stacked, auto-dismissing toasts. Identical messages within a short window refresh instead of stacking.
// Tap a toast to dismiss it, except where it lies over a HUD control (joystick, action buttons, bridge
// links): there it lets touches through, so a toast never eats a move or a RUG.

import type { Tone } from './core';
import { h, icon } from './dom';

const LIFETIME_MS = 3400;
const DEDUPE_MS = 1800;
const MAX_VISIBLE = 4;
/** Re-check overlaps while toasts show: they slide in, restack as others leave, and the HUD changes under them. */
const OVERLAP_CHECK_MS = 250;

/** HUD controls a toast must never cover with a tap target. */
export const TOAST_PASSTHROUGH_UNDER = '.joy-zone, .hud-actions .act:not([hidden]), .sab-menu:not([hidden]), .hud-vent';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Two boxes intersect (empty boxes, like a display:none control, never do). */
export function boxesOverlap(a: Box, b: Box): boolean {
  if (a.right <= a.left || a.bottom <= a.top || b.right <= b.left || b.bottom <= b.top) return false;
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

interface Live {
  el: HTMLElement;
  text: string;
  at: number;
  timer: number;
}

export function createToasts(layer: HTMLElement): { show(text: string, tone?: Tone): void } {
  const live: Live[] = [];
  let checkTimer: number | null = null;

  function syncPassthrough(): void {
    const scope: ParentNode = layer.parentElement ?? document;
    const controls = Array.from(scope.querySelectorAll(TOAST_PASSTHROUGH_UNDER), (e) => e.getBoundingClientRect());
    for (const t of live) {
      const r = t.el.getBoundingClientRect();
      t.el.classList.toggle('is-passthrough', controls.some((c) => boxesOverlap(r, c)));
    }
    if (live.length && checkTimer === null) checkTimer = window.setInterval(syncPassthrough, OVERLAP_CHECK_MS);
    else if (!live.length && checkTimer !== null) {
      window.clearInterval(checkTimer);
      checkTimer = null;
    }
  }

  function dismiss(t: Live): void {
    const i = live.indexOf(t);
    if (i >= 0) live.splice(i, 1);
    window.clearTimeout(t.timer);
    t.el.classList.add('is-leaving');
    // A leaving toast never blocks anything.
    t.el.classList.add('is-passthrough');
    window.setTimeout(() => {
      t.el.remove();
      syncPassthrough();
    }, 260);
  }

  function show(text: string, tone: Tone = 'info'): void {
    const msg = String(text ?? '').trim();
    if (!msg) return;
    const now = Date.now();
    const dup = live.find((t) => t.text === msg && now - t.at < DEDUPE_MS + LIFETIME_MS);
    if (dup) {
      dup.at = now;
      window.clearTimeout(dup.timer);
      dup.timer = window.setTimeout(() => dismiss(dup), LIFETIME_MS);
      dup.el.classList.remove('is-bump');
      void dup.el.offsetWidth;
      dup.el.classList.add('is-bump');
      return;
    }
    const el = h(
      'div',
      { class: `toast toast--${tone}`, attrs: { role: tone === 'bad' ? 'alert' : 'status' } },
      icon(tone === 'bad' ? 'warning' : tone === 'good' ? 'check' : 'bolt'),
      h('span', { class: 'toast-text', text: msg }),
    );
    const t: Live = { el, text: msg, at: now, timer: 0 };
    el.addEventListener('click', () => dismiss(t));
    layer.append(el);
    live.push(t);
    t.timer = window.setTimeout(() => dismiss(t), LIFETIME_MS);
    while (live.length > MAX_VISIBLE) dismiss(live[0]);
    syncPassthrough();
  }

  window.addEventListener('resize', () => {
    if (live.length) syncPassthrough();
  });

  return { show };
}
