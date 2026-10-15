// Ejection: the blacklisted pill drifts off-screen along a red candle, then the verdict types out.

import { EJECTION_MS } from '../../../shared/constants';
import type { Snapshot } from '../../../shared/protocol';
import type { Screen, UiCore } from './core';
import { h, plural } from './dom';
import { pillSvg } from './pill';
import { applyNameFx } from './names';
import { createPillPreview } from './previews';
import { isAllyRed } from './ranked';

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
  // The server only sends the remaining count when blacklists are confirmed (it would otherwise leak the role).
  const sub = n !== undefined ? `${n} ${plural(n, 'Rugger')} ${n === 1 ? 'remains' : 'remain'}.` : '';
  return { main, sub, tie: e.tie };
}

export function createEjection(core: UiCore): Screen {
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
    const ejId = e.ejectedId;
    const who = ejId ? core.who(ejId) : null;
    const looks = (ejId ? snap.players.find((p) => p.id === ejId)?.cosmetics : undefined) ?? who?.cosmetics;
    const isMe = !!ejId && ejId === (snap.me?.id ?? core.myId());
    if (ejId) {
      // Your own rug rides along on your own ejection; everyone else only shows a skin.
      const ride = isMe ? { ...(looks?.skin ? { skin: looks.skin } : {}), ...(looks?.rug ? { rug: looks.rug } : {}) } : looks?.skin ? { skin: looks.skin } : {};
      const pill = h('div', { class: 'ej-pill' });
      if (ride.skin || ride.rug) {
        pill.classList.add('ej-pill--pv');
        pill.append(createPillPreview(110, e.ejectedColor ?? 0, ride, { cls: 'ej-pv', h: 120, zoom: ride.rug ? 1.05 : 1.3 }).el);
      } else {
        pill.innerHTML = pillSvg(e.ejectedColor ?? 0, { legs: true });
      }
      pill.style.animationDuration = `${Math.round(EJECTION_MS * 0.85)}ms`;
      lane.append(pill);
    }
    const mainEl = h('div', { class: 'ej-main', attrs: { 'aria-live': 'polite', 'aria-label': main } });
    // The name types out inside its own span so it can carry the player's name effect (red ally wins).
    const nameLen = ejId && e.ejectedName && main.startsWith(e.ejectedName) ? e.ejectedName.length : 0;
    const red = isAllyRed(snap.me?.role, who?.isRugger || (e.wasRugger === true && snap.me?.role === 'rugger'));
    const nameEl = h('span', { class: `ej-name${red ? ' is-ally' : ''}` });
    const restEl = h('span');
    mainEl.append(nameEl, restEl);
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
          nameEl.textContent = main.slice(0, Math.min(i, nameLen));
          restEl.textContent = main.slice(nameLen, Math.max(nameLen, i));
          if (nameLen) applyNameFx(nameEl, looks, red);
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
