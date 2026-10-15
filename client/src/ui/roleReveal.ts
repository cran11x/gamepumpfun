// Role reveal: HOLDER (green) or RUGGER (red) with fellow ruggers.

import { maxRuggersFor, ROLE_REVEAL_MS } from '../../../shared/constants';
import type { Snapshot } from '../../../shared/protocol';
import type { Screen, UiCore } from './core';
import { h, plural } from './dom';
import { pillEl } from './pill';

export function createRoleReveal(core: UiCore): Screen {
  const el = h('div', { class: 'screen screen--solid reveal' });
  let built = false;
  let barTimer: number | null = null;

  function build(snap: Snapshot): void {
    const me = snap.me;
    if (!me) return;
    built = true;
    const rugger = me.role === 'rugger';
    const meView = snap.players.find((p) => p.id === me.id);
    const myColor = meView?.color ?? core.who(me.id)?.color ?? 0;
    const playerCount = snap.players.length;
    // The server says how many really play (ranked always plays maxRuggersFor(players)).
    const ruggers = snap.room.ruggerCount ?? Math.min(snap.room.settings.ruggers, maxRuggersFor(playerCount));
    el.classList.add(rugger ? 'reveal--rugger' : 'reveal--holder');

    const team = h('div', { class: 'reveal-team' });
    if (rugger) {
      const mates = snap.players.filter((p) => p.isRugger && p.id !== me.id);
      if (mates.length) {
        team.append(h('div', { class: 'reveal-team-k', text: mates.length === 1 ? 'FELLOW RUGGER' : 'FELLOW RUGGERS' }));
        const row = h('div', { class: 'reveal-team-row' });
        for (const m of mates) row.append(h('div', { class: 'reveal-mate' }, pillEl(m.color), h('span', { class: 'reveal-mate-name', text: m.name })));
        team.append(row);
      } else {
        team.append(h('div', { class: 'reveal-team-k', text: 'You rug alone.' }));
      }
    }

    const bar = h('div', { class: 'reveal-bar' }, h('span', { class: 'reveal-bar-fill' }));
    el.append(
      h('div', { class: 'reveal-rays', attrs: { 'aria-hidden': 'true' } }),
      h(
        'div',
        { class: 'reveal-inner' },
        h('div', { class: 'reveal-kicker', text: 'YOU ARE A' }),
        h('div', { class: 'reveal-role', text: rugger ? 'RUGGER' : 'HOLDER' }),
        h('div', { class: 'reveal-pill' }, pillEl(myColor)),
        h('p', { class: 'reveal-text', text: rugger ? "Rug them all. Don't get caught." : 'Pump the bonding curve to 100%. Find the rugger.' }),
        h('div', { class: 'reveal-count', text: `${ruggers} ${plural(ruggers, 'Rugger')} among ${playerCount} ${plural(playerCount, 'player')}` }),
        team,
        bar,
      ),
    );
    const remain = snap.phaseEndsAt ? Math.max(300, snap.phaseEndsAt - core.ctx.net.serverNow()) : ROLE_REVEAL_MS;
    const fill = bar.firstElementChild as HTMLElement;
    fill.style.transitionDuration = `${remain}ms`;
    barTimer = window.setTimeout(() => fill.classList.add('is-done'), 30);
  }

  return {
    el,
    update(snap) {
      if (!built && snap) build(snap);
    },
    destroy() {
      if (barTimer !== null) window.clearTimeout(barTimer);
    },
  };
}
