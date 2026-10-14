// Ejection: the blacklisted pill drifts off-screen along a red candle, then the verdict types out.

import { EJECTION_MS } from '../../../shared/constants';
import type { Snapshot } from '../../../shared/protocol';
import type { Screen, UiCore } from './core';
import { h, plural } from './dom';
import { pillSvg } from './pill';

export function ejectionText(snap: Snapshot): { main: string; sub: string; tie: boolean } {
  const e = snap.ejection!;
  let main: string;
  if (e.ejectedId) {
    const name = e.ejectedName ?? 'Someone';
    main = e.wasRugger === undefined ? `${name} was blacklisted.` : e.wasRugger ? `${name} was the Rugger.` : `${name} was not the Rugger.`;
  } else {
    main = 'No one was blacklisted.';
  }
  const n = e.ruggersLeft;
  // Without confirmed blacklists the remaining count would leak the role, so only show it when confirmed.
  const sub = snap.room.settings.confirmEjects ? `${n} ${plural(n, 'Rugger')} ${n === 1 ? 'remains' : 'remain'}.` : '';
  return { main, sub, tie: e.tie };
}

export function createEjection(_core: UiCore): Screen {
  const el = h('div', { class: 'screen screen--solid eject' });
  let built = false;
  const timers: number[] = [];

  function build(snap: Snapshot): void {
    const e = snap.ejection;
    if (!e) return;
    built = true;
    const { main, sub, tie } = ejectionText(snap);
    const stars = h('div', { class: 'ej-stars', attrs: { 'aria-hidden': 'true' } });
    for (let i = 0; i < 40; i++) {
      const s = h('span', { class: 'ej-star' });
      s.style.left = `${(i * 37.7) % 100}%`;
      s.style.top = `${(i * 61.3) % 100}%`;
      s.style.animationDelay = `${(i % 7) * 0.4}s`;
      stars.append(s);
    }
    // A faded, descending candle chart behind the lane.
    const chart = h('div', { class: 'ej-chart', attrs: { 'aria-hidden': 'true' } });
    for (let i = 0; i < 16; i++) {
      const b = h('span', { class: 'ej-bar' });
      const x = 3 + i * 6.2;
      b.style.left = `${x}%`;
      b.style.top = `${12 + i * 3.6 + ((i * 7) % 5) * 2}%`;
      b.style.height = `${26 + ((i * 37) % 60)}px`;
      b.style.animationDelay = `${i * 40}ms`;
      chart.append(b);
    }
    const lane = h('div', { class: 'ej-lane', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'ej-wick' }), h('span', { class: 'ej-candle' }));
    if (e.ejectedId) {
      const pill = h('div', { class: 'ej-pill', html: pillSvg(e.ejectedColor ?? 0, { legs: true }) });
      pill.style.animationDuration = `${Math.round(EJECTION_MS * 0.85)}ms`;
      lane.append(pill);
    }
    const mainEl = h('div', { class: 'ej-main', attrs: { 'aria-live': 'polite', 'aria-label': main } });
    const subEl = h('div', { class: 'ej-sub', text: [tie && !e.ejectedId ? 'Tie vote.' : '', sub].filter(Boolean).join(' ') });
    el.classList.add(e.wasRugger === true ? 'eject--rugger' : e.ejectedId ? 'eject--holder' : 'eject--none');
    el.append(stars, chart, lane, h('div', { class: 'ej-copy' }, mainEl, subEl));

    // Typewriter.
    const startDelay = e.ejectedId ? 1100 : 500;
    const perChar = Math.max(28, Math.min(60, 1500 / Math.max(1, main.length)));
    let i = 0;
    timers.push(
      window.setTimeout(() => {
        const iv = window.setInterval(() => {
          i++;
          mainEl.textContent = main.slice(0, i);
          if (i >= main.length) {
            window.clearInterval(iv);
            subEl.classList.add('is-shown');
          }
        }, perChar);
        timers.push(iv);
      }, startDelay),
    );
  }

  return {
    el,
    update(snap) {
      if (!built && snap) build(snap);
    },
    destroy() {
      for (const t of timers) {
        window.clearTimeout(t);
        window.clearInterval(t);
      }
    },
  };
}
