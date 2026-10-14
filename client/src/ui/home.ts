// Home / landing screen: logo, ticker + CA, name, QUICK PLAY / CREATE / JOIN, Phantom sign-in, modals.

import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from '../../../shared/constants';
import type { C2S } from '../../../shared/protocol';
import { fetchRoomsInfo } from '../api';
import { Net } from '../net';
import type { Screen, UiCore } from './core';
import { button, h, icon, lsGet, lsSet, shortCa } from './dom';
import { pillSvg } from './pill';

const NAME_KEY = 'amongrugs.name';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PENDING_TIMEOUT_MS = 10_000;

export function sanitizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, ROOM_CODE_LENGTH);
}

export function createHome(core: UiCore): Screen {
  const { ctx } = core;
  const cfg = ctx.config;
  let pending: 'quick' | 'create' | 'join' | null = null;
  let pendingTimer: number | null = null;
  let loginBusy = false;
  let infoTimer: number | null = null;
  const offs: Array<() => void> = [];

  // ----- Brand -----
  const mascot = h('div', { class: 'home-mascot', html: pillSvg(0, { cls: 'home-mascot-pill' }) });
  const logo = h(
    'div',
    { class: 'home-logo' },
    mascot,
    h(
      'h1',
      { class: 'logo', attrs: { 'aria-label': cfg.gameName } },
      h('span', { class: 'logo-among', text: 'AMONG' }),
      h('span', { class: 'logo-rugs', text: 'RUGS' }),
      h('span', { class: 'logo-sticker', text: '-99%' }),
    ),
  );
  const tagline = h('p', { class: 'home-tagline', text: 'One of you is about to rug. Pump the curve or find the rugger.' });

  const chips = h('div', { class: 'home-chips' }, h('span', { class: 'chip chip--ticker', text: cfg.ticker }));
  if (cfg.contractAddress) {
    const ca = cfg.contractAddress;
    const caBtn = h(
      'button',
      { class: 'chip chip--ca', type: 'button', title: 'Copy contract address', attrs: { 'aria-label': `Copy CA ${ca}` } },
      h('span', { class: 'chip-k', text: 'CA' }),
      h('span', { class: 'chip-v', text: shortCa(ca) }),
      icon('copy'),
    );
    caBtn.addEventListener('click', () => core.copy(ca, 'CA'));
    chips.append(caBtn);
  }
  const links = h('div', { class: 'home-links' });
  const addLink = (href: string | undefined, label: string, ic: 'x' | 'telegram' | 'pill') => {
    if (!href) return;
    links.append(
      h('a', { class: 'link-btn', attrs: { href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label, title: label } }, icon(ic)),
    );
  };
  addLink(cfg.links.x, 'X', 'x');
  addLink(cfg.links.telegram, 'Telegram', 'telegram');
  addLink(cfg.links.pumpfun, 'pump.fun', 'pill');
  if (links.childElementCount) chips.append(links);

  // ----- Identity: name input or signed-in chip -----
  const identity = h('div', { class: 'home-identity' });
  const nameInput = h('input', {
    class: 'field-input home-name',
    type: 'text',
    attrs: {
      maxlength: String(MAX_NAME_LENGTH),
      placeholder: 'Your degen name',
      autocomplete: 'nickname',
      spellcheck: 'false',
      'aria-label': 'Your name',
      enterkeyhint: 'go',
    },
  });
  nameInput.id = 'input-name';
  nameInput.value = lsGet(NAME_KEY) ?? '';
  nameInput.addEventListener('input', () => lsSet(NAME_KEY, nameInput.value.slice(0, MAX_NAME_LENGTH)));
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') act('quick');
  });

  const loginBtn = button('CONNECT PHANTOM', { cls: 'btn--phantom', icon: 'phantom' });
  loginBtn.id = 'btn-phantom';
  loginBtn.addEventListener('click', () => {
    if (loginBusy) return;
    loginBusy = true;
    renderIdentity();
    ctx.wallet
      .login()
      .then((s) => core.toast(`gm ${s.profile.name}. Stats are now tracked.`, 'good'))
      .catch((err: unknown) => core.toast(err instanceof Error ? err.message : "Couldn't connect Phantom.", 'bad'))
      .finally(() => {
        loginBusy = false;
        renderIdentity();
      });
  });

  function renderIdentity(): void {
    identity.textContent = '';
    const s = ctx.wallet.getSession();
    if (s) {
      const st = s.profile.stats;
      const rename = h('button', { class: 'icon-btn', type: 'button', title: 'Rename', attrs: { 'aria-label': 'Rename' } }, icon('edit'));
      rename.addEventListener('click', () => core.openRename());
      const logout = h('button', { class: 'icon-btn', type: 'button', title: 'Log out', attrs: { 'aria-label': 'Log out' } }, icon('logout'));
      logout.addEventListener('click', () => {
        ctx.wallet.logout();
        core.toast('Logged out.', 'info');
      });
      identity.append(
        h(
          'div',
          { class: 'wallet-chip' },
          h('span', { class: 'wallet-chip-ico' }, icon('phantom')),
          h(
            'span',
            { class: 'wallet-chip-who' },
            h('span', { class: 'wallet-chip-name', text: s.profile.name }),
            h('span', { class: 'wallet-chip-addr', text: `${shortCa(s.profile.address)} · ${st.wins}W / ${st.gamesPlayed}GP` }),
          ),
          rename,
          logout,
        ),
      );
    } else {
      identity.append(nameInput);
      loginBtn.disabled = loginBusy;
      const lbl = loginBtn.querySelector('.btn-label');
      if (lbl) lbl.textContent = loginBusy ? 'CHECK PHANTOM…' : 'CONNECT PHANTOM';
    }
    phantomRow.hidden = !!s;
  }

  // ----- Play buttons -----
  const quickBtn = button('QUICK PLAY', { cls: 'btn--green btn--xl', icon: 'play' });
  const createBtn = button('CREATE ROOM', { cls: 'btn--ghost' });
  const codeInput = h('input', {
    class: 'field-input home-code',
    type: 'text',
    attrs: {
      maxlength: String(ROOM_CODE_LENGTH),
      placeholder: 'CODE',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      'aria-label': 'Room code',
      enterkeyhint: 'join',
    },
  });
  const joinBtn = button('JOIN', { cls: 'btn--gold' });
  quickBtn.id = 'btn-quick';
  createBtn.id = 'btn-create';
  codeInput.id = 'input-code';
  joinBtn.id = 'btn-join';
  const joinRow = h('div', { class: 'home-join' }, codeInput, joinBtn);
  const updateJoin = () => {
    joinBtn.disabled = pending !== null || codeInput.value.length !== ROOM_CODE_LENGTH;
  };
  codeInput.addEventListener('input', () => {
    const v = sanitizeCode(codeInput.value);
    if (v !== codeInput.value) codeInput.value = v;
    updateJoin();
  });
  codeInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') act('join');
  });

  quickBtn.addEventListener('click', () => act('quick'));
  createBtn.addEventListener('click', () => act('create'));
  joinBtn.addEventListener('click', () => act('join'));

  const phantomRow = h('div', { class: 'home-phantom' }, loginBtn, h('span', { class: 'home-phantom-note', text: 'Optional. Sign a message (no transaction) to track stats.' }));

  const lbBtn = button('LEADERBOARD', { cls: 'btn--sm btn--ghost', icon: 'trophy', onClick: () => core.openLeaderboard() });
  const howBtn = button('HOW TO PLAY', { cls: 'btn--sm btn--ghost', icon: 'help', onClick: () => core.openHowTo() });

  const status = h('div', { class: 'home-status', attrs: { role: 'status' } });
  const online = h('div', { class: 'home-online' });

  const card = h(
    'div',
    { class: 'home-card panel' },
    identity,
    quickBtn,
    h('div', { class: 'home-row' }, createBtn, joinRow),
    phantomRow,
    h('div', { class: 'home-row home-row--minor' }, lbBtn, howBtn),
    status,
  );

  const el = h(
    'div',
    { class: 'screen screen--solid home' },
    h('div', { class: 'home-bg', attrs: { 'aria-hidden': 'true' } }, ...Array.from({ length: 14 }, (_, i) => candle(i))),
    h('div', { class: 'home-inner' }, logo, tagline, chips, card, online),
  );

  renderIdentity();
  offs.push(ctx.wallet.onChange(renderIdentity));

  // ?room=CODE prefills the code and focuses JOIN.
  const fromUrl = sanitizeCode(new URLSearchParams(location.search).get('room') ?? '');
  if (fromUrl.length === ROOM_CODE_LENGTH) {
    codeInput.value = fromUrl;
    joinRow.classList.add('is-invited');
    requestAnimationFrame(() => joinBtn.focus({ preventScroll: true }));
  }
  updateJoin();

  // A saved session means net.ts is rejoining in the background.
  if (Net.loadSession()) setStatus('Rejoining your last game…', true);

  function setStatus(text: string, spin = false): void {
    status.textContent = '';
    if (!text) return;
    if (spin) status.append(h('span', { class: 'spinner' }));
    status.append(h('span', { text }));
  }

  function setPending(p: typeof pending): void {
    pending = p;
    if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    pendingTimer = null;
    quickBtn.disabled = createBtn.disabled = p !== null;
    el.classList.toggle('is-pending', p !== null);
    updateJoin();
    if (p) {
      setStatus(p === 'quick' ? 'Finding a lobby…' : p === 'create' ? 'Creating your room…' : `Joining ${codeInput.value}…`, true);
      pendingTimer = window.setTimeout(() => {
        setPending(null);
        core.toast(ctx.store.connected ? "The server didn't answer. Try again." : "Can't reach the server. Retrying…", 'bad');
      }, PENDING_TIMEOUT_MS);
    } else {
      setStatus('');
    }
  }

  function act(kind: 'quick' | 'create' | 'join'): void {
    if (pending) return;
    const session = ctx.wallet.getSession();
    const name = session ? session.profile.name : nameInput.value.trim().slice(0, MAX_NAME_LENGTH);
    if (!session && name) lsSet(NAME_KEY, name);
    const auth = session?.token ? { authToken: session.token } : {};
    let msg: C2S;
    if (kind === 'join') {
      const code = sanitizeCode(codeInput.value);
      if (code.length !== ROOM_CODE_LENGTH) {
        codeInput.focus();
        joinRow.classList.remove('is-shake');
        void joinRow.offsetWidth;
        joinRow.classList.add('is-shake');
        return;
      }
      msg = { t: 'join', code, name, ...auth };
    } else if (kind === 'create') {
      msg = { t: 'create', name, ...auth };
    } else {
      msg = { t: 'quick', name, ...auth };
    }
    ctx.net.connect();
    ctx.net.send(msg);
    setPending(kind);
  }

  offs.push(
    ctx.store.onError((e) => {
      if (pending) setPending(null);
      if (e.code === 'REJOIN_FAILED') setStatus('');
    }),
  );
  offs.push(
    ctx.store.onStatus((c) => {
      if (!c && !pending) setStatus('Connecting to the trenches…', true);
      else if (c && !pending && !Net.loadSession()) setStatus('');
    }),
  );
  // Show "connecting" only if the first connection takes a moment.
  const connectHint = window.setTimeout(() => {
    if (!ctx.store.connected && !pending) setStatus('Connecting to the trenches…', true);
  }, 1500);

  function refreshInfo(): void {
    fetchRoomsInfo()
      .then((info) => {
        online.textContent = '';
        online.append(
          h('span', { class: 'live-dot' }),
          h('span', { text: `${info.playersOnline} in the trenches` }),
          h('span', { class: 'sep', text: '·' }),
          h('span', { text: `${info.publicLobbies} open ${info.publicLobbies === 1 ? 'lobby' : 'lobbies'}` }),
        );
      })
      .catch(() => {
        online.textContent = '';
      });
  }
  refreshInfo();
  infoTimer = window.setInterval(refreshInfo, 20_000);

  return {
    el,
    update() {
      /* home has no snapshot; it is replaced as soon as one arrives */
    },
    destroy() {
      for (const off of offs) off();
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
      if (infoTimer !== null) window.clearInterval(infoTimer);
      window.clearTimeout(connectHint);
    },
  };
}

/** Decorative background candle (CSS animates it). */
function candle(i: number): HTMLElement {
  const green = i % 3 !== 1;
  const c = h('span', { class: `bg-candle ${green ? 'bg-candle--up' : 'bg-candle--down'}` });
  c.style.setProperty('--i', String(i));
  c.style.setProperty('--x', `${(i * 7.3 + (i % 2) * 3) % 100}%`);
  c.style.setProperty('--h', `${30 + ((i * 37) % 70)}px`);
  c.style.setProperty('--d', `${9 + ((i * 13) % 9)}s`);
  return c;
}
