// Game over: GRADUATED (holders) or RUGGED (ruggers), reason, every role, BACK TO LOBBY (host) / LEAVE.

import type { GameOverReason, Role, Snapshot } from '../../../shared/protocol';
import { createChat } from './chat';
import type { Screen, UiCore } from './core';
import { button, clear, h, setHidden, setText } from './dom';
import { pillSvg } from './pill';
import { applyNameFx } from './names';
import { createPillPreview, type PillPreview } from './previews';
import { isAllyRed } from './ranked';

export const REASON_TEXT: Record<GameOverReason, string> = {
  tasks: 'The bonding curve hit 100%.',
  ruggersEjected: 'Every Rugger got blacklisted.',
  parity: 'The Ruggers matched the Holders.',
  devDump: 'The DEV DUMP was never stopped.',
  abandoned: 'Not enough players left.',
};

export function createGameOver(core: UiCore): Screen {
  const { ctx } = core;
  let built = false;
  let rosterSig = '';
  let previews: PillPreview[] = [];
  const grid = h('div', { class: 'over-grid' });
  const backBtn = button('BACK TO LOBBY', { cls: 'btn--green', icon: 'users', onClick: () => ctx.net.send({ t: 'backToLobby' }) });
  const leaveBtn = button('LEAVE', { cls: 'btn--ghost', icon: 'door', onClick: () => core.leaveRoom() });
  const waitEl = h('span', { class: 'over-wait' }, h('span', { class: 'spinner' }), 'Waiting for the host…');
  const chat = createChat(core, {
    channels: ['lobby', 'system'],
    placeholder: 'gg…',
    emptyText: 'Say gg.',
    cls: 'over-chat',
    since: () => core.gameStartedAt(),
  });
  const head = h('div', { class: 'over-head' });
  const el = h(
    'div',
    { class: 'screen screen--solid over' },
    h('div', { class: 'over-fx', attrs: { 'aria-hidden': 'true' } }, ...Array.from({ length: 16 }, (_, i) => fx(i))),
    h(
      'div',
      { class: 'over-inner' },
      head,
      grid,
      h('div', { class: 'over-actions' }, backBtn, waitEl, leaveBtn),
      h('div', { class: 'over-chatwrap panel' }, chat.el),
    ),
  );

  function build(snap: Snapshot): void {
    const go = snap.gameOver!;
    built = true;
    const holders = go.winner === 'holders';
    el.classList.add(holders ? 'over--holders' : 'over--ruggers');
    const myRole: Role | undefined = (snap.me && go.roles[snap.me.id]) || snap.me?.role;
    const won = myRole ? (holders ? myRole === 'holder' : myRole === 'rugger') : null;
    head.append(
      h('div', { class: 'over-title', text: holders ? 'GRADUATED' : 'RUGGED' }),
      h('div', { class: 'over-sub', text: holders ? 'Holders win' : 'Ruggers win' }),
      h('div', { class: 'over-reason', text: REASON_TEXT[go.reason] ?? '' }),
    );
    if (won !== null) head.append(h('div', { class: `over-you ${won ? 'is-win' : 'is-loss'}`, text: won ? 'YOU WON' : 'YOU LOST' }));
  }

  function renderRoster(snap: Snapshot): void {
    const go = snap.gameOver!;
    const ids = new Set<string>(Object.keys(go.roles));
    for (const p of snap.players) ids.add(p.id);
    const rows = [...ids].map((id) => {
      const p = snap.players.find((x) => x.id === id);
      const w = core.who(id);
      return {
        id,
        name: p?.name ?? w?.name ?? '???',
        color: p?.color ?? w?.color ?? 0,
        alive: p?.alive ?? false,
        left: !p,
        role: go.roles[id] ?? (p?.isRugger ? 'rugger' : 'holder'),
        looks: p?.cosmetics ?? w?.cosmetics ?? null,
      };
    });
    rows.sort((a, b) => (a.role === b.role ? 0 : a.role === 'rugger' ? -1 : 1));
    const sig = JSON.stringify(rows);
    if (sig === rosterSig) return;
    rosterSig = sig;
    clear(grid);
    for (const pv of previews) pv.destroy();
    previews = [];
    const me = snap.me?.id ?? core.myId();
    const myRole: Role | undefined = (snap.me && go.roles[snap.me.id]) || snap.me?.role;
    for (const r of rows) {
      const skin = r.alive ? r.looks?.skin : undefined;
      let pill: HTMLElement;
      if (skin) {
        const pv = createPillPreview(48, r.color, { skin }, { cls: 'over-card-pv', h: 56, zoom: 1.3, seed: r.color * 5 + 2 });
        previews.push(pv);
        pill = h('span', { class: 'over-card-pill over-card-pill--pv' }, pv.el);
      } else {
        pill = h('span', { class: 'over-card-pill', html: pillSvg(r.color, { variant: r.alive ? 'alive' : 'dead', legs: false }) });
      }
      // Ruggers see their own team in rug red; red wins over any name effect.
      const red = isAllyRed(myRole, r.role === 'rugger');
      const name = h('span', { class: `over-card-name${red ? ' is-ally' : ''}`, text: r.name });
      applyNameFx(name, r.looks, red);
      grid.append(
        h(
          'div',
          { class: `over-card over-card--${r.role}${r.id === me ? ' is-me' : ''}${r.left ? ' is-left' : ''}` },
          pill,
          h(
            'span',
            { class: 'over-card-info' },
            name,
            h(
              'span',
              { class: 'over-card-meta' },
              h('span', { class: 'over-card-role', text: r.role === 'rugger' ? 'RUGGER' : 'HOLDER' }),
              h('span', { class: 'over-card-state', text: r.left ? 'LEFT' : r.alive ? 'ALIVE' : 'OUT' }),
            ),
          ),
        ),
      );
    }
  }

  return {
    el,
    update(snap) {
      if (!snap || !snap.gameOver) return;
      if (!built) build(snap);
      renderRoster(snap);
      const host = snap.room.hostId === core.myId();
      setHidden(backBtn, !host);
      setHidden(waitEl, host);
      setText(leaveBtn.querySelector('.btn-label')!, 'LEAVE');
    },
    destroy() {
      chat.destroy();
      for (const pv of previews) pv.destroy();
    },
  };
}

function fx(i: number): HTMLElement {
  const s = h('span', { class: 'over-candle' });
  s.style.setProperty('--x', `${(i * 6.7 + (i % 3) * 2) % 100}%`);
  s.style.setProperty('--d', `${2.5 + ((i * 7) % 5) * 0.6}s`);
  s.style.setProperty('--delay', `${(i % 8) * 0.35}s`);
  s.style.setProperty('--h', `${24 + ((i * 29) % 50)}px`);
  return s;
}
