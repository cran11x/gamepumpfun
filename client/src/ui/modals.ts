// Modal layer plus the leaderboard, how-to-play, rename and manual-copy dialogs.

import { MAX_NAME_LENGTH, MIN_PLAYERS, MAX_PLAYERS } from '../../../shared/constants';
import type { LeaderboardEntry, PlayerStats } from '../../../shared/protocol';
import { fetchLeaderboard, LEADERBOARD_SORTS, type LeaderboardSort } from '../api';
import type { ModalHandle, ModalOpts, UiCore } from './core';
import { button, h, icon } from './dom';
import { pillSvg } from './pill';

export interface ModalLayer {
  open(opts: ModalOpts): ModalHandle;
  /** Close the top modal. Returns false when none was open. */
  closeTop(): boolean;
  isOpen(): boolean;
}

export function createModalLayer(layer: HTMLElement, setBlocked: (on: boolean) => void): ModalLayer {
  let current: { handle: ModalHandle; opts: ModalOpts; backdrop: HTMLElement } | null = null;

  function open(opts: ModalOpts): ModalHandle {
    if (current) current.handle.close();
    const closeBtn = h('button', { class: 'modal-x', type: 'button', attrs: { 'aria-label': 'Close' } }, icon('close'));
    const modal = h(
      'div',
      { class: `modal ${opts.cls ?? ''}`.trim(), attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title } },
      h('div', { class: 'modal-head' }, h('h2', { class: 'modal-title', text: opts.title }), closeBtn),
      h('div', { class: 'modal-body' }, opts.body),
    );
    const backdrop = h('div', { class: 'modal-backdrop' }, modal);
    let closed = false;
    const handle: ModalHandle = {
      el: modal,
      close() {
        if (closed) return;
        closed = true;
        if (current?.handle === handle) current = null;
        backdrop.classList.add('is-leaving');
        window.setTimeout(() => backdrop.remove(), 180);
        if (!current) setBlocked(false);
        try {
          opts.onClose?.();
        } catch (err) {
          console.error('[ui] modal onClose failed', err);
        }
      },
    };
    closeBtn.addEventListener('click', () => handle.close());
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) handle.close();
    });
    layer.append(backdrop);
    current = { handle, opts, backdrop };
    setBlocked(true);
    return handle;
  }

  return {
    open,
    closeTop() {
      if (!current) return false;
      current.handle.close();
      return true;
    },
    isOpen: () => current !== null,
  };
}

// ---------- Leaderboard ----------

const SORT_LABELS: Record<LeaderboardSort, string> = {
  wins: 'WINS',
  ruggerWins: 'RUGGER WINS',
  holderWins: 'HOLDER WINS',
  rugs: 'RUGS',
  correctVotes: 'GOOD VOTES',
};

const SORT_STAT: Record<LeaderboardSort, keyof PlayerStats> = {
  wins: 'wins',
  ruggerWins: 'ruggerWins',
  holderWins: 'holderWins',
  rugs: 'rugs',
  correctVotes: 'correctVotes',
};

const cache = new Map<LeaderboardSort, { at: number; rows: LeaderboardEntry[] }>();
const CACHE_MS = 30_000;

export function openLeaderboard(core: UiCore): void {
  let sort: LeaderboardSort = 'wins';
  let seq = 0;
  const tabs = h('div', { class: 'lb-tabs', attrs: { role: 'tablist' } });
  const list = h('div', { class: 'lb-list' });
  const tabBtns = new Map<LeaderboardSort, HTMLButtonElement>();
  for (const s of LEADERBOARD_SORTS) {
    const b = h('button', { class: 'lb-tab', type: 'button', text: SORT_LABELS[s], attrs: { role: 'tab' } });
    b.addEventListener('click', () => select(s));
    tabBtns.set(s, b);
    tabs.append(b);
  }
  const me = core.ctx.wallet.getSession()?.profile.address ?? null;
  const body = h(
    'div',
    { class: 'lb' },
    tabs,
    list,
    h('p', { class: 'lb-foot', text: me ? 'Your stats count while you are signed in with Phantom.' : 'Connect Phantom to get on the board.' }),
  );

  function render(rows: LeaderboardEntry[]): void {
    list.textContent = '';
    if (!rows.length) {
      list.append(h('div', { class: 'lb-state', text: 'No one on the board yet. Go make history.' }));
      return;
    }
    const stat = SORT_STAT[sort];
    rows.forEach((r, i) => {
      const rank = i + 1;
      list.append(
        h(
          'div',
          { class: `lb-row${rank <= 3 ? ` lb-row--top${rank}` : ''}${me && r.address === me ? ' lb-row--me' : ''}` },
          h('span', { class: 'lb-rank', text: `#${rank}` }),
          h('span', { class: 'lb-who' }, h('span', { class: 'lb-name', text: r.name }), h('span', { class: 'lb-addr', text: r.shortAddress })),
          h('span', { class: 'lb-sub', text: `${r.stats.gamesPlayed} GP` }),
          h('span', { class: 'lb-val', text: String(r.stats[stat]) }),
        ),
      );
    });
  }

  function select(s: LeaderboardSort): void {
    sort = s;
    for (const [k, b] of tabBtns) {
      b.classList.toggle('is-active', k === s);
      b.setAttribute('aria-selected', String(k === s));
    }
    const hit = cache.get(s);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      render(hit.rows);
      return;
    }
    const my = ++seq;
    list.textContent = '';
    list.append(h('div', { class: 'lb-state lb-state--loading' }, h('span', { class: 'spinner' }), 'Loading the board…'));
    fetchLeaderboard(s)
      .then((rows) => {
        cache.set(s, { at: Date.now(), rows });
        if (my === seq) render(rows);
      })
      .catch((err: unknown) => {
        if (my !== seq) return;
        list.textContent = '';
        const retry = button('RETRY', { cls: 'btn--sm', onClick: () => select(s) });
        list.append(
          h('div', { class: 'lb-state lb-state--error' }, h('span', { text: err instanceof Error ? err.message : 'Could not load the leaderboard.' }), retry),
        );
      });
  }

  core.openModal({ title: 'LEADERBOARD', body, cls: 'modal--lb', onClose: () => void ++seq });
  select('wins');
}

// ---------- How to play ----------

export function openHowTo(core: UiCore): void {
  const section = (title: string, cls: string, art: string, lines: string[]) =>
    h(
      'section',
      { class: `howto-sec ${cls}` },
      h('div', { class: 'howto-art', html: art }),
      h('div', { class: 'howto-copy' }, h('h3', { text: title }), h('ul', null, ...lines.map((l) => h('li', { text: l })))),
    );
  const ticker = core.ctx.config.ticker;
  const body = h(
    'div',
    { class: 'howto' },
    h('p', { class: 'howto-lead', text: `${MIN_PLAYERS}–${MAX_PLAYERS} degens. One station. A few of them are about to rug ${ticker}.` }),
    section('HOLDERS', 'howto--holder', pillSvg(0), [
      'Do your tasks to pump the bonding curve to 100%. At 100% the coin GRADUATES and Holders win.',
      'Find a rugged bag? REPORT it. Something sus? Hit the SPACES button on the Launchpad.',
      'Got rugged? Keep doing tasks as a ghost.',
    ]),
    section('RUGGERS', 'howto--rugger', pillSvg(1), [
      'RUG Holders when nobody is watching. Travel through BRIDGES to escape.',
      'SABOTAGE: DEV DUMP (hold both BUY WALLs before the timer ends), FUD (holders go half-blind), RPC DOWN (tasks and curve go dark).',
      'Win when Ruggers match the Holders, or when a DEV DUMP is not stopped.',
    ]),
    section('X SPACES', 'howto--spaces', pillSvg(3), [
      'Discuss, then vote. Most votes gets BLACKLISTED. Ties and SKIP blacklist no one.',
      'Vote out every Rugger and the Holders win.',
    ]),
    h(
      'section',
      { class: 'howto-keys' },
      h('h3', { text: 'CONTROLS' }),
      h(
        'div',
        { class: 'howto-keygrid' },
        ...(
          [
            ['WASD / ←↑→↓', 'Move'],
            ['E / SPACE', 'Use, task, fix'],
            ['R', 'Report'],
            ['Q', 'Rug'],
            ['V', 'Bridge'],
            ['F', 'Sabotage menu'],
            ['M', 'Map'],
            ['ESC', 'Close'],
          ] as const
        ).map(([k, v]) => h('div', { class: 'howto-key' }, h('kbd', { class: 'kbd', text: k }), h('span', { text: v }))),
      ),
      h('p', { class: 'howto-touch', text: 'On phones: joystick bottom-left, big buttons bottom-right.' }),
    ),
  );
  core.openModal({ title: 'HOW TO PLAY', body, cls: 'modal--howto' });
}

// ---------- Rename (signed-in profile) ----------

export function openRename(core: UiCore): void {
  const session = core.ctx.wallet.getSession();
  if (!session) {
    core.toast('Connect Phantom first.', 'bad');
    return;
  }
  const input = h('input', {
    class: 'field-input',
    type: 'text',
    attrs: { maxlength: String(MAX_NAME_LENGTH), value: session.profile.name, autocomplete: 'off', 'aria-label': 'Display name', spellcheck: 'false' },
  });
  input.value = session.profile.name;
  const save = button('SAVE', { cls: 'btn--green', icon: 'check' });
  const form = h(
    'form',
    { class: 'rename' },
    h('label', { class: 'field-label', text: 'Display name on the leaderboard and in games' }),
    input,
    h('div', { class: 'rename-actions' }, save),
  );
  save.type = 'submit';
  let busy = false;
  const modal = core.openModal({ title: 'RENAME', body: form, cls: 'modal--sm' });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    busy = true;
    save.disabled = true;
    core.ctx.wallet
      .setName(name)
      .then((p) => {
        core.toast(`You are now ${p.name}`, 'good');
        modal.close();
      })
      .catch((err: unknown) => core.toast(err instanceof Error ? err.message : "Couldn't save your name.", 'bad'))
      .finally(() => {
        busy = false;
        save.disabled = false;
      });
  });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

// ---------- Manual copy fallback ----------

export function openManualCopy(core: UiCore, text: string, what: string): void {
  const input = h('input', { class: 'field-input field-input--mono', type: 'text', attrs: { readonly: '', value: text, 'aria-label': what } });
  input.value = text;
  const body = h('div', { class: 'manual-copy' }, h('p', { text: `Copy the ${what} manually:` }), input);
  core.openModal({ title: 'COPY', body, cls: 'modal--sm' });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
    input.setSelectionRange(0, text.length);
  });
}
