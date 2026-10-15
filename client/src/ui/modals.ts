// Modal layer (stackable) plus the leaderboard (all-time + weekly ranked), how-to-play, rename and manual-copy dialogs.

import { MAX_NAME_LENGTH, MIN_PLAYERS, MAX_PLAYERS, RANKED_POINTS } from '../../../shared/constants';
import type { LeaderboardEntry, PlayerStats, RankedLeaderboard } from '../../../shared/protocol';
import { fetchLeaderboard, fetchRankedLeaderboard, LEADERBOARD_SORTS, type LeaderboardSort } from '../api';
import type { ModalHandle, ModalOpts, UiCore } from './core';
import { button, h, icon, toggleClass } from './dom';
import { pillSvg } from './pill';
import { formatTokens, nextWeekStartUtc, resetCountdown } from './ranked';

export interface ModalLayer {
  open(opts: ModalOpts): ModalHandle;
  /** Close the top modal. Returns false when none was open. */
  closeTop(): boolean;
  /** Close every open modal. */
  closeAll(): void;
  isOpen(): boolean;
}

export function createModalLayer(layer: HTMLElement, setBlocked: (on: boolean) => void): ModalLayer {
  // Usually one modal; `stack: true` opens another on top (the burn modal over the shop).
  const stack: Array<{ handle: ModalHandle; opts: ModalOpts; backdrop: HTMLElement }> = [];

  function open(opts: ModalOpts): ModalHandle {
    if (!opts.stack) while (stack.length) stack[stack.length - 1].handle.close();
    const closeBtn = h('button', { class: 'modal-x', type: 'button', attrs: { 'aria-label': 'Close' } }, icon('close'));
    const modal = h(
      'div',
      { class: `modal ${opts.cls ?? ''}`.trim(), attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title } },
      h('div', { class: 'modal-head' }, h('h2', { class: 'modal-title', text: opts.title }), closeBtn),
      h('div', { class: 'modal-body' }, opts.body),
    );
    const backdrop = h('div', { class: `modal-backdrop${stack.length ? ' modal-backdrop--stacked' : ''}` }, modal);
    let closed = false;
    const handle: ModalHandle = {
      el: modal,
      close() {
        if (closed) return;
        closed = true;
        const i = stack.findIndex((m) => m.handle === handle);
        if (i >= 0) stack.splice(i, 1);
        backdrop.classList.add('is-leaving');
        window.setTimeout(() => backdrop.remove(), 180);
        if (!stack.length) setBlocked(false);
        try {
          opts.onClose?.();
        } catch (err) {
          console.error('[ui] modal onClose failed', err);
        }
      },
    };
    closeBtn.addEventListener('click', () => handle.close());
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target !== backdrop) return;
      let ok = true;
      try {
        ok = opts.dismissible ? opts.dismissible() : true;
      } catch {
        ok = true;
      }
      if (ok) handle.close();
    });
    layer.append(backdrop);
    stack.push({ handle, opts, backdrop });
    setBlocked(true);
    return handle;
  }

  return {
    open,
    closeTop() {
      const top = stack[stack.length - 1];
      if (!top) return false;
      top.handle.close();
      return true;
    },
    closeAll() {
      while (stack.length) stack[stack.length - 1].handle.close();
    },
    isOpen: () => stack.length > 0,
  };
}

// ---------- Leaderboard ----------

export type LbTab = LeaderboardSort | 'rankedCurrent' | 'rankedPrevious';

const TAB_LABELS: Record<LbTab, string> = {
  rankedCurrent: 'RANKED · THIS WEEK',
  rankedPrevious: 'RANKED · LAST WEEK',
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

type LbData = { kind: 'all'; rows: LeaderboardEntry[] } | { kind: 'ranked'; board: RankedLeaderboard };

const cache = new Map<LbTab, { at: number; data: LbData }>();
const CACHE_MS = 30_000;

const P = RANKED_POINTS;
const RANKED_RULES = `Ranked: one burned ticket per game. Win +${P.holderWin} as a holder, +${P.ruggerWin} as a rugger. +${P.perRug} per rug, +${P.perTask} per task, +${P.perCorrectVote} per good vote, +${P.survived} for surviving a holder win. Leaving early: ${P.leftEarly}.`;

function isRankedTab(t: LbTab): t is 'rankedCurrent' | 'rankedPrevious' {
  return t === 'rankedCurrent' || t === 'rankedPrevious';
}

function loadTab(t: LbTab): Promise<LbData> {
  if (isRankedTab(t)) return fetchRankedLeaderboard(t === 'rankedCurrent' ? 'current' : 'previous').then((board) => ({ kind: 'ranked', board }));
  return fetchLeaderboard(t).then((rows) => ({ kind: 'all', rows }));
}

export function openLeaderboard(core: UiCore, initial: LbTab = 'wins'): void {
  const ranked = core.burnMode() !== 'off';
  const order: LbTab[] = [...(ranked ? (['rankedCurrent', 'rankedPrevious'] as const) : []), ...LEADERBOARD_SORTS];
  let tab: LbTab = order.includes(initial) ? initial : 'wins';
  let seq = 0;
  let countdownTimer: number | null = null;
  const tabs = h('div', { class: 'lb-tabs', attrs: { role: 'tablist' } });
  const week = h('div', { class: 'lb-week' });
  const list = h('div', { class: 'lb-list' });
  const foot = h('p', { class: 'lb-foot' });
  const tabBtns = new Map<LbTab, HTMLButtonElement>();
  for (const t of order) {
    const b = h('button', {
      class: `lb-tab${isRankedTab(t) ? ' lb-tab--ranked' : ''}`,
      type: 'button',
      text: TAB_LABELS[t],
      attrs: { role: 'tab' },
      dataset: { tab: t },
    });
    b.addEventListener('click', () => select(t));
    tabBtns.set(t, b);
    tabs.append(b);
  }
  const me = core.ctx.wallet.getSession()?.profile.address ?? null;
  const body = h('div', { class: 'lb' }, tabs, week, list, foot);

  function stopCountdown(): void {
    if (countdownTimer !== null) window.clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function renderWeek(board: RankedLeaderboard | null): void {
    stopCountdown();
    week.textContent = '';
    week.hidden = !isRankedTab(tab);
    if (!isRankedTab(tab)) return;
    const id = board?.weekId ? board.weekId.replace('-W', ' · WEEK ') : '';
    if (tab === 'rankedCurrent') {
      const end = board && board.weekEnd > Date.now() ? board.weekEnd : nextWeekStartUtc(Date.now());
      const left = h('span', { class: 'lb-week-left' });
      const tickCd = () => {
        left.textContent = resetCountdown(end - Date.now());
        if (end - Date.now() <= 0) stopCountdown();
      };
      tickCd();
      countdownTimer = window.setInterval(tickCd, 1000);
      week.append(h('span', { class: 'lb-week-id', text: id || 'THIS WEEK' }), h('span', { class: 'lb-week-reset' }, 'Resets in ', left), h('span', { class: 'lb-week-note', text: 'Mondays 00:00 UTC' }));
    } else {
      week.append(h('span', { class: 'lb-week-id', text: id || 'LAST WEEK' }), h('span', { class: 'lb-week-reset', text: 'Final standings' }));
    }
  }

  function render(data: LbData): void {
    list.textContent = '';
    if (data.kind === 'ranked') {
      renderWeek(data.board);
      const rows = data.board.entries;
      if (!rows.length) {
        list.append(
          h('div', { class: 'lb-state', text: tab === 'rankedCurrent' ? 'No ranked games this week yet. Grab a ticket and take #1.' : 'No ranked games last week.' }),
        );
        return;
      }
      rows.forEach((r, i) => {
        const rank = i + 1;
        list.append(
          h(
            'div',
            { class: `lb-row lb-row--ranked${rank <= 3 ? ` lb-row--top${rank}` : ''}${me && r.address === me ? ' lb-row--me' : ''}` },
            h('span', { class: 'lb-rank', text: `#${rank}` }),
            h('span', { class: 'lb-who' }, h('span', { class: 'lb-name', text: r.name }), h('span', { class: 'lb-addr', text: r.shortAddress })),
            h('span', { class: 'lb-sub', text: `${r.games} GP · ${r.wins}W` }),
            h('span', { class: `lb-val${r.points < 0 ? ' is-neg' : ''}` }, String(r.points), h('small', { text: 'PTS' })),
          ),
        );
      });
      return;
    }
    renderWeek(null);
    const rows = data.rows;
    if (!rows.length) {
      list.append(h('div', { class: 'lb-state', text: 'No one on the board yet. Go make history.' }));
      return;
    }
    const stat = SORT_STAT[tab as LeaderboardSort];
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

  function select(t: LbTab): void {
    tab = t;
    for (const [k, b] of tabBtns) {
      b.classList.toggle('is-active', k === t);
      b.setAttribute('aria-selected', String(k === t));
    }
    tabBtns.get(t)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    foot.textContent = isRankedTab(t)
      ? RANKED_RULES
      : me
        ? 'Your stats count while you are signed in with Phantom.'
        : 'Connect Phantom to get on the board.';
    toggleClass(foot, 'lb-foot--rules', isRankedTab(t));
    const hit = cache.get(t);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      render(hit.data);
      return;
    }
    const my = ++seq;
    renderWeek(null);
    list.textContent = '';
    list.append(h('div', { class: 'lb-state lb-state--loading' }, h('span', { class: 'spinner' }), 'Loading the board…'));
    loadTab(t)
      .then((data) => {
        cache.set(t, { at: Date.now(), data });
        if (my === seq) render(data);
      })
      .catch((err: unknown) => {
        if (my !== seq) return;
        list.textContent = '';
        const retry = button('RETRY', { cls: 'btn--sm', onClick: () => select(t) });
        list.append(
          h('div', { class: 'lb-state lb-state--error' }, h('span', { text: err instanceof Error ? err.message : 'Could not load the leaderboard.' }), retry),
        );
      });
  }

  core.openModal({
    title: 'LEADERBOARD',
    body,
    cls: 'modal--lb',
    onClose: () => {
      ++seq;
      stopCountdown();
    },
  });
  select(tab);
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
    core.burnMode() !== 'off'
      ? section('RANKED + SHOP', 'howto--ranked', pillSvg(8), [
          `RANKED: burn ${formatTokens(core.ctx.config.burn.rankedEntryPrice)} ${ticker} for a ticket. One ticket per game, humans only, standard settings.`,
          'Ranked points go to a weekly leaderboard that resets Monday 00:00 UTC.',
          `SHOP: burn ${ticker} for pill skins, rug patterns and name effects. Looks only, no advantage.`,
          'Burned tokens are destroyed forever. Nobody receives them. Playing is always free.',
        ])
      : null,
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
