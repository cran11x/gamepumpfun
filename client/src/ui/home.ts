// Home / landing screen: logo, ticker + CA, name, QUICK PLAY / CREATE / JOIN, RANKED + SHOP, the live burn
// counter, Phantom sign-in, modals.

import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from '../../../shared/constants';
import type { C2S } from '../../../shared/protocol';
import { fetchBurnStats, fetchRoomsInfo } from '../api';
import { Net, type Refusal } from '../net';
import type { Screen, UiCore } from './core';
import { button, h, icon, lsGet, lsSet, shortCa } from './dom';
import { pillSvg } from './pill';
import { testModeBadge } from './burn';
import { formatTokens } from './ranked';

const NAME_KEY = 'amongrugs.name';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PENDING_TIMEOUT_MS = 10_000;
const BURN_STATS_MS = 30_000;

type Act = 'quick' | 'create' | 'join';

export function sanitizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, ROOM_CODE_LENGTH);
}

/** Home status while the server refuses this network: the reason plus a countdown to the next retry. */
export function refusalText(r: Refusal, now: number): string {
  const why = r.message.replace(/[.\s]+$/, '') || 'Too many connections from your network';
  const secs = Math.ceil((r.retryAt - now) / 1000);
  return r.retryAt > 0 && secs > 0 ? `${why}. Retrying in ${secs}s…` : `${why}. Retrying…`;
}

export function createHome(core: UiCore): Screen {
  const { ctx } = core;
  const cfg = ctx.config;
  let pending: Act | null = null;
  let pendingRanked = false;
  const burnMode = core.burnMode();
  const burnsOn = burnMode !== 'off';
  let burnTimer: number | null = null;
  let pendingTimer: number | null = null;
  let loginBusy = false;
  let infoTimer: number | null = null;
  let refusalTimer: number | null = null;
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

  // ----- Live burn counter (/api/burns/stats) -----
  const burnCount = h('span', { class: 'home-burns-n' });
  const burnBar = h(
    'button',
    { class: 'home-burns', type: 'button', title: 'Recent burns', attrs: { id: 'burn-counter', 'aria-label': 'Tokens burned. Show recent burns' } },
    h('span', { class: 'home-burns-ico' }, icon('flame')),
    burnCount,
    h('span', { class: 'home-burns-t', text: `${cfg.ticker} burned` }),
    h('span', { class: 'home-burns-more', text: 'recent' }, icon('arrowRight')),
  );
  burnBar.hidden = true;
  burnBar.addEventListener('click', () => core.openRecentBurns());
  const burnRow = h('div', { class: 'home-burnrow' }, burnBar, burnMode === 'mock' ? testModeBadge() : null);
  burnRow.hidden = !burnsOn;

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
    renderTickets();
  }

  function renderTickets(): void {
    const s = ctx.wallet.getSession();
    ticketChip.textContent = '';
    if (s) {
      const n = s.profile.rankedTickets;
      ticketChip.append(icon('ticket'), h('span', { text: String(n) }));
      ticketChip.classList.toggle('is-empty', n < 1);
      ticketChip.title = `${n} ranked ${n === 1 ? 'ticket' : 'tickets'}`;
      ticketChip.hidden = false;
    } else {
      ticketChip.append(icon('phantom'));
      ticketChip.classList.remove('is-empty');
      ticketChip.title = 'Needs Phantom';
      ticketChip.hidden = false;
    }
  }

  /** Ranked needs a wallet and a ticket; with 0 tickets it opens the burn modal first. */
  function ranked(kind: 'quick' | 'create'): void {
    if (pending || !burnsOn) return;
    if (!ctx.wallet.getSession()) {
      void core.signIn().then((ok) => {
        if (ok && el.isConnected) ranked(kind);
      });
      return;
    }
    const s = ctx.wallet.getSession();
    if (s && s.profile.rankedTickets < 1) {
      buyTicket(kind);
      return;
    }
    act(kind, true);
  }

  function buyTicket(then: 'quick' | 'create' | null): void {
    if (!ctx.wallet.getSession()) {
      void core.signIn().then((ok) => {
        if (ok && el.isConnected) buyTicket(then);
      });
      return;
    }
    core.openBurn({
      request: { purpose: 'ranked' },
      lead: then ? 'Ranked games need a ticket. One ticket is used per game.' : undefined,
      doneAction: { label: then === 'create' ? 'CREATE RANKED ROOM' : 'FIND RANKED GAME', run: () => {
        if (el.isConnected) act(then ?? 'quick', true);
      } },
    });
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

  // ----- Ranked + shop -----
  const ticketChip = h('span', { class: 'btn-chip', attrs: { 'aria-label': 'Ranked tickets' } });
  const rankedBtn = button('RANKED', { cls: 'btn--ranked', icon: 'trophy', title: 'Ranked: 1 burned ticket per game, weekly leaderboard' });
  rankedBtn.append(ticketChip);
  rankedBtn.id = 'btn-ranked';
  rankedBtn.addEventListener('click', () => ranked('quick'));
  const shopBtn = button('SHOP', { cls: 'btn--ghost btn--shop', icon: 'bag', title: 'Looks for your pill', onClick: () => core.openShop() });
  shopBtn.id = 'btn-shop';
  const ticketLink = h('button', { class: 'home-link', type: 'button' }, icon('ticket'), h('span', { text: 'GET TICKET' }));
  ticketLink.id = 'btn-get-ticket';
  ticketLink.addEventListener('click', () => buyTicket(null));
  const privLink = h('button', { class: 'home-link', type: 'button', title: 'Create a private ranked room for friends' }, icon('lock'), h('span', { text: 'PRIVATE ROOM' }));
  privLink.id = 'btn-create-ranked';
  privLink.addEventListener('click', () => ranked('create'));
  const weekLink = h('button', { class: 'home-link', type: 'button' }, icon('trophy'), h('span', { text: 'THIS WEEK' }));
  weekLink.id = 'btn-ranked-week';
  weekLink.addEventListener('click', () => core.openLeaderboardAt('rankedCurrent'));
  const rankedRow = h('div', { class: `home-row home-ranked${burnsOn ? '' : ' home-row--single'}` }, burnsOn ? rankedBtn : null, shopBtn);
  const rankedLinks = h('div', { class: 'home-links-row' }, ticketLink, privLink, weekLink);
  rankedLinks.hidden = !burnsOn;

  const phantomRow = h(
    'div',
    { class: 'home-phantom' },
    loginBtn,
    h('span', {
      class: 'home-phantom-note',
      text: burnsOn ? 'Optional. Sign a message (no transaction) to track stats, play ranked and use the shop.' : 'Optional. Sign a message (no transaction) to track stats.',
    }),
  );

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
    rankedRow,
    rankedLinks,
    phantomRow,
    h('div', { class: 'home-row home-row--minor' }, lbBtn, howBtn),
    status,
  );

  const el = h(
    'div',
    { class: 'screen screen--solid home' },
    h('div', { class: 'home-bg', attrs: { 'aria-hidden': 'true' } }, ...Array.from({ length: 14 }, (_, i) => candle(i))),
    h('div', { class: 'home-inner' }, logo, tagline, chips, burnRow, card, online),
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
    if (refusalTimer !== null) window.clearInterval(refusalTimer);
    refusalTimer = null;
    status.classList.remove('is-bad');
    status.textContent = '';
    if (!text) return;
    if (spin) status.append(h('span', { class: 'spinner' }));
    status.append(h('span', { text }));
  }

  function setPending(p: typeof pending): void {
    pending = p;
    if (pendingTimer !== null) window.clearTimeout(pendingTimer);
    pendingTimer = null;
    quickBtn.disabled = createBtn.disabled = rankedBtn.disabled = privLink.disabled = p !== null;
    el.classList.toggle('is-pending', p !== null);
    updateJoin();
    if (p) {
      const r = pendingRanked ? 'ranked ' : '';
      setStatus(p === 'quick' ? `Finding a ${r}lobby…` : p === 'create' ? `Creating your ${r}room…` : `Joining ${codeInput.value}…`, true);
      pendingTimer = window.setTimeout(() => {
        setPending(null);
        core.toast(ctx.store.connected ? "The server didn't answer. Try again." : "Can't reach the server. Retrying…", 'bad');
      }, PENDING_TIMEOUT_MS);
    } else {
      setStatus('');
    }
  }

  function act(kind: Act, rankedRoom = false): void {
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
      msg = rankedRoom ? { t: 'create', name, ...auth, ranked: true } : { t: 'create', name, ...auth };
    } else {
      msg = rankedRoom ? { t: 'quick', name, ...auth, ranked: true } : { t: 'quick', name, ...auth };
    }
    ctx.net.connect();
    ctx.net.send(msg);
    pendingRanked = rankedRoom && kind !== 'join';
    // A ranked room may answer NEED_TICKET: the burn modal then offers to send this again.
    core.rankedRetry = () => {
      if (el.isConnected) act(kind, rankedRoom);
    };
    setPending(kind);
  }

  /** Disconnected: say why when the server is refusing this network, and count down to the next retry. */
  function showOffline(): void {
    const r = ctx.net.refusal;
    if (!r) {
      setStatus('Connecting to the trenches…', true);
      return;
    }
    const render = () => {
      const cur = ctx.net.refusal;
      const line = status.querySelector('.home-status-text');
      if (cur && line) line.textContent = refusalText(cur, Date.now());
    };
    setStatus(refusalText(r, Date.now()));
    status.classList.add('is-bad');
    status.lastElementChild?.classList.add('home-status-text');
    refusalTimer = window.setInterval(render, 1000);
  }

  offs.push(
    ctx.store.onError((e) => {
      if (pending) setPending(null);
      if (e.code === 'REJOIN_FAILED') setStatus('');
    }),
  );
  offs.push(
    ctx.store.onStatus((c) => {
      if (pending) return;
      if (!c) showOffline();
      else if (Net.loadSession()) setStatus('Rejoining your last game…', true);
      else setStatus('');
    }),
  );
  // Show "connecting" only if the first connection takes a moment.
  const connectHint = window.setTimeout(() => {
    if (!ctx.store.connected && !pending) showOffline();
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

  function refreshBurns(): void {
    if (!burnsOn) return;
    fetchBurnStats()
      .then((st) => {
        burnCount.textContent = formatTokens(st.totalBurned);
        burnBar.hidden = false;
      })
      .catch(() => {
        /* keep the last number; hidden until the first answer */
      });
  }
  if (burnsOn) {
    refreshBurns();
    burnTimer = window.setInterval(refreshBurns, BURN_STATS_MS);
    // Fresh ticket count (a ranked game may have used one).
    if (ctx.wallet.getSession()) void ctx.wallet.refreshProfile();
  }

  return {
    el,
    update() {
      /* home has no snapshot; it is replaced as soon as one arrives */
    },
    destroy() {
      for (const off of offs) off();
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
      if (infoTimer !== null) window.clearInterval(infoTimer);
      if (refusalTimer !== null) window.clearInterval(refusalTimer);
      if (burnTimer !== null) window.clearInterval(burnTimer);
      window.clearTimeout(connectHint);
      core.rankedRetry = null;
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
