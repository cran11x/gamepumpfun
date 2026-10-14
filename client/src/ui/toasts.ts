// Stacked, auto-dismissing toasts. Identical messages within a short window refresh instead of stacking.

import type { Tone } from './core';
import { h, icon } from './dom';

const LIFETIME_MS = 3400;
const DEDUPE_MS = 1800;
const MAX_VISIBLE = 4;

interface Live {
  el: HTMLElement;
  text: string;
  at: number;
  timer: number;
}

export function createToasts(layer: HTMLElement): { show(text: string, tone?: Tone): void } {
  const live: Live[] = [];

  function dismiss(t: Live): void {
    const i = live.indexOf(t);
    if (i >= 0) live.splice(i, 1);
    window.clearTimeout(t.timer);
    t.el.classList.add('is-leaving');
    window.setTimeout(() => t.el.remove(), 260);
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
  }

  return { show };
}
