// Lobby: room code + invite link, player list, color picker, host settings, chat, START.

import { MAX_PLAYERS, MIN_PLAYERS, PLAYER_COLORS, SETTINGS_BOUNDS, maxRuggersFor, type GameSettings } from '../../../shared/constants';
import type { PlayerView, Snapshot } from '../../../shared/protocol';
import { createChat } from './chat';
import type { Screen, UiCore } from './core';
import { button, clear, h, icon, plural, setDisabled, setHidden, setText, toggleClass } from './dom';
import { pillSvg } from './pill';

type NumKey = keyof typeof SETTINGS_BOUNDS;
type BoolKey = 'confirmEjects' | 'isPublic';

const NUM_SETTINGS: Array<{ key: NumKey; label: string; fmt: (v: number) => string }> = [
  { key: 'ruggers', label: 'Ruggers', fmt: (v) => String(v) },
  { key: 'killCooldown', label: 'Rug cooldown', fmt: (v) => `${v}s` },
  { key: 'playerSpeed', label: 'Speed', fmt: (v) => `${fmtMult(v)}×` },
  { key: 'crewVision', label: 'Holder vision', fmt: (v) => `${fmtMult(v)}×` },
  { key: 'ruggerVision', label: 'Rugger vision', fmt: (v) => `${fmtMult(v)}×` },
  { key: 'discussionTime', label: 'Discussion', fmt: (v) => `${v}s` },
  { key: 'votingTime', label: 'Voting', fmt: (v) => `${v}s` },
  { key: 'tasksPerPlayer', label: 'Tasks each', fmt: (v) => String(v) },
  { key: 'emergencyMeetings', label: 'SPACES calls each', fmt: (v) => String(v) },
];

const BOOL_SETTINGS: Array<{ key: BoolKey; label: string; on: string; off: string }> = [
  { key: 'confirmEjects', label: 'Confirm blacklists', on: 'Reveal role', off: 'Hidden' },
  { key: 'isPublic', label: 'Lobby', on: 'Public', off: 'Private' },
];

function fmtMult(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function createLobby(core: UiCore): Screen {
  const { ctx } = core;
  const pendingNum = new Map<NumKey, { value: number; at: number }>();
  const pendingBool = new Map<BoolKey, { value: boolean; at: number }>();
  let pendingColor: { value: number; at: number } | null = null;
  let lastPlayersSig = '';
  let last: Snapshot | null = null;

  // ----- Top bar -----
  const codeEl = h('div', { class: 'lobby-code', attrs: { title: 'Copy room code' } });
  const visChip = h('span', { class: 'chip chip--sm' });
  const tickerChip = h('span', { class: 'chip chip--sm chip--ticker' });
  const inviteBtn = button('COPY INVITE LINK', { cls: 'btn--sm btn--cyan', icon: 'link' });
  const leaveBtn = button('LEAVE', { cls: 'btn--sm btn--ghost', icon: 'door', onClick: () => core.leaveRoom() });
  codeEl.addEventListener('click', () => last && core.copy(last.room.code, 'room code'));
  inviteBtn.addEventListener('click', () => {
    if (!last) return;
    core.copy(`${location.origin}/?room=${last.room.code}`, 'invite link');
  });
  const top = h(
    'div',
    { class: 'lobby-top' },
    leaveBtn,
    h('div', { class: 'lobby-codewrap' }, h('span', { class: 'lobby-code-k', text: 'ROOM' }), codeEl, h('div', { class: 'lobby-chips' }, visChip, tickerChip)),
    inviteBtn,
  );

  // ----- Players -----
  const countEl = h('span', { class: 'panel-count' });
  const playerList = h('ul', { class: 'lobby-players' });
  const addBotBtn = button('BOT', { cls: 'btn--sm btn--ghost', icon: 'plus', title: 'Add a bot', onClick: () => ctx.net.send({ t: 'addBot' }) });
  const rmBotBtn = button('BOT', { cls: 'btn--sm btn--ghost', icon: 'minus', title: 'Remove a bot', onClick: () => ctx.net.send({ t: 'removeBot' }) });
  const botRow = h('div', { class: 'lobby-botrow' }, addBotBtn, rmBotBtn);
  const playersPanel = h(
    'section',
    { class: 'panel lobby-panel lobby-panel--players' },
    h('header', { class: 'panel-head' }, icon('users'), h('h2', { text: 'PLAYERS' }), countEl),
    playerList,
    botRow,
  );

  // ----- Colors -----
  const swatches: HTMLButtonElement[] = PLAYER_COLORS.map((c, i) => {
    const b = h('button', {
      class: 'swatch',
      type: 'button',
      title: c.name,
      attrs: { 'aria-label': c.name },
      html: pillSvg(i, { legs: false }),
    });
    b.style.setProperty('--sw', c.body);
    b.addEventListener('click', () => {
      if (b.disabled) return;
      pendingColor = { value: i, at: Date.now() };
      ctx.net.send({ t: 'setColor', color: i });
      if (last) update(last);
    });
    return b;
  });
  const colorName = h('span', { class: 'panel-count' });
  const colorsPanel = h(
    'section',
    { class: 'panel lobby-panel lobby-panel--colors' },
    h('header', { class: 'panel-head' }, h('h2', { text: 'YOUR PILL' }), colorName),
    h('div', { class: 'swatches' }, ...swatches),
  );

  // ----- Settings -----
  const settingsNote = h('span', { class: 'panel-count' });
  const settingsGrid = h('div', { class: 'settings' });
  const numRows = new Map<NumKey, { val: HTMLElement; minus: HTMLButtonElement; plus: HTMLButtonElement; hint: HTMLElement }>();
  for (const s of NUM_SETTINGS) {
    const b = SETTINGS_BOUNDS[s.key];
    const val = h('span', { class: 'stepper-val' });
    const minus = h('button', { class: 'stepper-btn', type: 'button', attrs: { 'aria-label': `Lower ${s.label}` } }, icon('minus'));
    const plus = h('button', { class: 'stepper-btn', type: 'button', attrs: { 'aria-label': `Raise ${s.label}` } }, icon('plus'));
    const hint = h('span', { class: 'setting-hint' });
    minus.addEventListener('click', () => step(s.key, -b.step));
    plus.addEventListener('click', () => step(s.key, b.step));
    settingsGrid.append(
      h('div', { class: 'setting' }, h('span', { class: 'setting-label' }, s.label, hint), h('span', { class: 'stepper' }, minus, val, plus)),
    );
    numRows.set(s.key, { val, minus, plus, hint });
  }
  const boolRows = new Map<BoolKey, { btn: HTMLButtonElement; txt: HTMLElement }>();
  for (const s of BOOL_SETTINGS) {
    const txt = h('span', { class: 'toggle-txt' });
    const btn = h('button', { class: 'toggle', type: 'button', attrs: { role: 'switch', 'aria-label': s.label } }, h('span', { class: 'toggle-knob' }));
    btn.addEventListener('click', () => {
      if (!last || !isHost()) return;
      const cur = effBool(s.key, last.room.settings);
      pendingBool.set(s.key, { value: !cur, at: Date.now() });
      ctx.net.send({ t: 'settings', settings: { [s.key]: !cur } as Partial<GameSettings> });
      update(last);
    });
    settingsGrid.append(h('div', { class: 'setting setting--bool' }, h('span', { class: 'setting-label', text: s.label }), h('span', { class: 'toggle-wrap' }, txt, btn)));
    boolRows.set(s.key, { btn, txt });
  }
  const settingsPanel = h(
    'section',
    { class: 'panel lobby-panel lobby-panel--settings' },
    h('header', { class: 'panel-head' }, h('h2', { text: 'SETTINGS' }), settingsNote),
    settingsGrid,
  );

  // ----- Chat -----
  const chat = createChat(core, { channels: ['lobby', 'system'], placeholder: 'Talk in the lobby…', emptyText: 'Lobby chat. Say gm.' });
  const chatPanel = h(
    'section',
    { class: 'panel lobby-panel lobby-panel--chat' },
    h('header', { class: 'panel-head' }, icon('chat'), h('h2', { text: 'LOBBY CHAT' })),
    chat.el,
  );

  // ----- Start -----
  const startBtn = button('START', { cls: 'btn--green btn--xl', icon: 'play', onClick: () => ctx.net.send({ t: 'start' }) });
  const startHint = h('span', { class: 'lobby-start-hint' });
  startBtn.id = 'btn-start';
  addBotBtn.id = 'btn-add-bot';
  rmBotBtn.id = 'btn-remove-bot';
  leaveBtn.id = 'btn-leave';
  inviteBtn.id = 'btn-invite';
  codeEl.id = 'lobby-code';
  const waitEl = h('div', { class: 'lobby-wait' }, h('span', { class: 'spinner' }), h('span', { text: 'Waiting for the host to start…' }));
  const bottom = h('div', { class: 'lobby-bottom' }, h('div', { class: 'lobby-start' }, startBtn, startHint), waitEl);

  const el = h(
    'div',
    { class: 'screen screen--solid lobby' },
    h('div', { class: 'lobby-inner' }, top, h('div', { class: 'lobby-grid' }, playersPanel, h('div', { class: 'lobby-col' }, colorsPanel, settingsPanel), chatPanel), bottom),
  );

  function isHost(): boolean {
    return !!last && last.room.hostId === core.myId();
  }

  function effNum(key: NumKey, s: GameSettings): number {
    const p = pendingNum.get(key);
    if (p && Date.now() - p.at < 2000 && p.value !== s[key]) return p.value;
    pendingNum.delete(key);
    return s[key];
  }

  function effBool(key: BoolKey, s: GameSettings): boolean {
    const p = pendingBool.get(key);
    if (p && Date.now() - p.at < 2000 && p.value !== s[key]) return p.value;
    pendingBool.delete(key);
    return s[key];
  }

  function step(key: NumKey, delta: number): void {
    if (!last || !isHost()) return;
    const b = SETTINGS_BOUNDS[key];
    const cur = effNum(key, last.room.settings);
    const next = round2(Math.min(b.max, Math.max(b.min, cur + delta)));
    if (next === cur) return;
    pendingNum.set(key, { value: next, at: Date.now() });
    ctx.net.send({ t: 'settings', settings: { [key]: next } as Partial<GameSettings> });
    update(last);
  }

  function playerRow(p: PlayerView, host: boolean, meHost: boolean, me: string | null): HTMLElement {
    const li = h('li', { class: `lp${p.id === me ? ' lp--me' : ''}${p.disconnected ? ' lp--dc' : ''}` });
    li.append(h('span', { class: 'lp-pill', html: pillSvg(p.color) }));
    const name = h('span', { class: 'lp-name', text: p.name });
    const badges = h('span', { class: 'lp-badges' });
    if (host) badges.append(h('span', { class: 'badge badge--host', title: 'Host' }, icon('crown'), 'HOST'));
    if (p.id === me) badges.append(h('span', { class: 'badge badge--you', text: 'YOU' }));
    if (p.isBot) badges.append(h('span', { class: 'badge badge--bot', title: 'Bot' }, icon('bot'), 'BOT'));
    if (p.wallet) badges.append(h('span', { class: 'badge badge--wallet', title: 'Signed in with Phantom' }, icon('phantom'), p.wallet));
    if (p.disconnected) badges.append(h('span', { class: 'badge badge--dc', text: 'RECONNECTING' }));
    li.append(h('span', { class: 'lp-who' }, name, badges));
    if (meHost && p.id !== me) {
      const kick = h('button', { class: 'icon-btn icon-btn--danger lp-kick', type: 'button', title: `Kick ${p.name}`, attrs: { 'aria-label': `Kick ${p.name}` } }, icon('close'));
      kick.addEventListener('click', () => ctx.net.send({ t: 'kick', playerId: p.id }));
      li.append(kick);
    }
    return li;
  }

  function update(snap: Snapshot | null): void {
    if (!snap) return;
    last = snap;
    const me = core.myId();
    const host = snap.room.hostId === me;
    const players = snap.players;
    const n = players.length;
    const s = snap.room.settings;

    setText(codeEl, snap.room.code);
    setText(tickerChip, snap.room.ticker);
    visChip.textContent = '';
    visChip.append(icon(s.isPublic ? 'globe' : 'lock'), s.isPublic ? 'PUBLIC' : 'PRIVATE');
    setText(countEl, `${n}/${MAX_PLAYERS}`);
    toggleClass(el, 'is-host', host);

    // Players (rebuild only when something visible changed).
    const sig = JSON.stringify([snap.room.hostId, me, players.map((p) => [p.id, p.name, p.color, p.isBot, p.wallet ?? '', !!p.disconnected])]);
    if (sig !== lastPlayersSig) {
      lastPlayersSig = sig;
      clear(playerList);
      for (const p of players) playerList.append(playerRow(p, p.id === snap.room.hostId, host, me));
      for (let i = n; i < MAX_PLAYERS; i++) playerList.append(h('li', { class: 'lp lp--empty' }, h('span', { class: 'lp-slot', text: 'open seat' })));
    }
    setHidden(botRow, !host);
    const bots = players.filter((p) => p.isBot).length;
    setDisabled(addBotBtn, n >= MAX_PLAYERS);
    setDisabled(rmBotBtn, bots === 0);

    // Colors.
    const mine = players.find((p) => p.id === me);
    if (pendingColor && (Date.now() - pendingColor.at > 2000 || mine?.color === pendingColor.value)) pendingColor = null;
    const myColor = pendingColor?.value ?? mine?.color ?? -1;
    const taken = new Set(players.filter((p) => p.id !== me).map((p) => p.color));
    swatches.forEach((b, i) => {
      setDisabled(b, taken.has(i));
      toggleClass(b, 'is-mine', i === myColor);
      toggleClass(b, 'is-taken', taken.has(i));
    });
    setText(colorName, myColor >= 0 ? PLAYER_COLORS[myColor].name : '');

    // Settings.
    setText(settingsNote, host ? 'you are the host' : 'host only');
    toggleClass(settingsPanel, 'is-readonly', !host);
    for (const def of NUM_SETTINGS) {
      const row = numRows.get(def.key)!;
      const b = SETTINGS_BOUNDS[def.key];
      const v = effNum(def.key, s);
      setText(row.val, def.fmt(v));
      setDisabled(row.minus, !host || v <= b.min);
      setDisabled(row.plus, !host || v >= b.max);
      if (def.key === 'ruggers') {
        const max = maxRuggersFor(n);
        setText(row.hint, v > max ? `${max} active at ${n} ${plural(n, 'player')}` : '');
      }
    }
    for (const def of BOOL_SETTINGS) {
      const row = boolRows.get(def.key)!;
      const v = effBool(def.key, s);
      toggleClass(row.btn, 'is-on', v);
      row.btn.setAttribute('aria-checked', String(v));
      setDisabled(row.btn, !host);
      setText(row.txt, v ? def.on : def.off);
    }

    // Start.
    setHidden(startBtn.parentElement as HTMLElement, !host);
    setHidden(waitEl, host);
    const need = Math.max(0, MIN_PLAYERS - n);
    setDisabled(startBtn, need > 0);
    setText(startHint, need > 0 ? `need ${need} more ${plural(need, 'player')} (add bots?)` : `${n} ${plural(n, 'player')} ready`);
    toggleClass(startHint, 'is-warn', need > 0);
  }

  return {
    el,
    update,
    destroy() {
      chat.destroy();
    },
  };
}
