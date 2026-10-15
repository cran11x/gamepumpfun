// Burn modal (ranked ticket or cosmetic) and the recent-burns list.
//
// The UI never decides whether a burn happened: wallet.burn() builds nothing itself, checks the server's
// transaction before Phantom opens, and resolves only with the server's receipt. This module shows the
// offer, the stages, friendly errors, and a safe retry: a burn that was SENT but is not confirmed yet is
// only ever re-checked (resumePendingBurns), never burned again.

import { cosmeticById, RARITY_COLORS } from '../../../shared/cosmetics';
import type { BurnReceipt, BurnRecord } from '../../../shared/protocol';
import { fetchBurnStats } from '../api';
import type { BurnStage } from '../context';
import type { BurnModalOpts, ModalHandle, UiCore } from './core';
import { button, clear, h, icon, setText } from './dom';
import { createPillPreview } from './previews';
import { burnCopy, burnWhat, formatTokens, isPendingBurnError, purchasePrice, receiptToast, slotNoun, timeAgo } from './ranked';

const STAGES: ReadonlyArray<{ id: BurnStage; label: string }> = [
  { id: 'preparing', label: 'Preparing the burn' },
  { id: 'signing', label: 'Approve in Phantom' },
  { id: 'confirming', label: 'Confirming on-chain' },
  { id: 'done', label: 'Done' },
];

type State = 'ready' | 'busy' | 'pending' | 'error' | 'done';

/** "TEST MODE: no real tokens" badge (mock mode only). */
export function testModeBadge(): HTMLElement {
  return h('div', { class: 'test-badge', attrs: { role: 'note' } }, icon('warning'), h('span', { text: 'TEST MODE: no real tokens' }));
}

/** Only Solscan transaction links are ever opened (api.ts already filters; checked again here). */
function safeExplorer(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'solscan.io' && u.pathname.startsWith('/tx/') ? u.toString() : null;
  } catch {
    return null;
  }
}

function explorerLink(url: string, label = 'View on Solscan'): HTMLAnchorElement {
  return h(
    'a',
    { class: 'burn-explorer', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' } },
    h('span', { text: label }),
    icon('external'),
  );
}

/** A little "ADMIT ONE" ranked ticket. */
export function ticketArt(cls = ''): HTMLElement {
  return h(
    'div',
    { class: `ticket-art ${cls}`.trim(), attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'ticket-art-k', text: 'RANKED' }),
    icon('ticket', 'ticket-art-ico'),
    h('span', { class: 'ticket-art-v', text: 'ADMIT ONE' }),
  );
}

export function openBurnModal(core: UiCore, opts: BurnModalOpts): ModalHandle | null {
  const { ctx } = core;
  const cfg = ctx.config;
  const mode = core.burnMode();
  const ticker = cfg.ticker;
  const req = opts.request;
  if (mode === 'off') {
    core.toast('Burns open when the token launches.', 'info');
    return null;
  }
  const amount = purchasePrice(cfg.burn, req);
  const item = req.purpose === 'cosmetic' && req.itemId ? cosmeticById(req.itemId) : undefined;
  if (amount === null || (req.purpose === 'cosmetic' && !item)) {
    core.toast('That item is not in the shop.', 'bad');
    return null;
  }
  const what = burnWhat(req);
  let state: State = 'ready';
  let reached: BurnStage | null = null;
  let failedAt: BurnStage | null = null;
  let closed = false;
  let message = '';

  // ----- Offer -----
  let visual: HTMLElement;
  if (item) {
    const look = { [item.slot]: item.id };
    const session = ctx.wallet.getSession();
    const wide = item.slot === 'name';
    const pv = createPillPreview(wide ? 156 : 108, core.myColor(), look, {
      cls: 'burn-pv',
      h: 108,
      label: item.slot === 'name' ? (session?.profile.name ?? 'degen') : null,
      moving: item.slot === 'skin',
    });
    visual = h('div', { class: `burn-visual${wide ? ' burn-visual--wide' : ''}` }, pv.el);
    visual.style.setProperty('--rar', RARITY_COLORS[item.rarity]);
  } else {
    visual = h('div', { class: 'burn-visual burn-visual--ticket' }, ticketArt());
  }
  const getLine = h('div', { class: 'burn-get' }, h('span', { class: 'burn-get-k', text: 'YOU GET' }), h('span', { class: 'burn-get-v', text: what }));
  const ticketsLine = h('div', { class: 'burn-have' });
  const hero = h(
    'div',
    { class: 'burn-hero' },
    visual,
    h(
      'div',
      { class: 'burn-offer' },
      h('div', { class: 'burn-amount' }, icon('flame'), h('span', { class: 'burn-amount-n', text: formatTokens(amount) }), h('span', { class: 'burn-amount-t', text: ticker })),
      getLine,
      ticketsLine,
    ),
  );

  const notes = h('ul', { class: 'burn-notes' });
  if (mode === 'live') notes.append(h('li', { text: 'Phantom shows one burn transaction from your own wallet. You only pay the usual SOL network fee.' }));
  else notes.append(h('li', { text: 'Test mode: nothing touches the chain and no real tokens move.' }));
  notes.append(h('li', { text: 'Burns are final. There are no refunds and no rewards.' }));
  notes.append(
    h('li', { text: req.purpose === 'ranked' ? 'One ticket is used when a ranked game starts. Points go to the weekly leaderboard.' : 'Looks only. It gives no advantage in the game.' }),
  );

  // ----- Stages -----
  const stageEls = new Map<BurnStage, HTMLElement>();
  const stages = h('ol', { class: 'burn-stages', attrs: { 'aria-label': 'Burn progress' } });
  for (const s of STAGES) {
    const label = s.id === 'signing' && mode === 'mock' ? 'Approve in Phantom (skipped in test mode)' : s.label;
    const li = h('li', { class: 'burn-stage', dataset: { stage: s.id } }, h('span', { class: 'burn-stage-dot' }), h('span', { class: 'burn-stage-txt', text: label }));
    stageEls.set(s.id, li);
    stages.append(li);
  }
  stages.hidden = true;

  const msgEl = h('div', { class: 'burn-msg', attrs: { role: 'status' } });
  const result = h('div', { class: 'burn-result' });
  const actions = h('div', { class: 'burn-actions' });

  const body = h(
    'div',
    { class: 'burn', attrs: { id: 'burn-modal' }, dataset: { purpose: req.purpose, ...(req.itemId ? { item: req.itemId } : {}) } },
    mode === 'mock' ? testModeBadge() : null,
    opts.lead ? h('p', { class: 'burn-lead', text: opts.lead }) : null,
    hero,
    h('p', { class: 'burn-copy', text: burnCopy(amount, ticker, what) }),
    notes,
    stages,
    msgEl,
    result,
    actions,
  );

  /** Short screens scroll the modal body: bring the outcome into view above the sticky buttons. */
  function reveal(target: HTMLElement): void {
    if (closed) return;
    requestAnimationFrame(() => {
      try {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {
        /* old browser */
      }
    });
  }

  function ownsItem(): boolean {
    return !!item && !!ctx.wallet.getSession()?.profile.cosmetics.owned.includes(item.id);
  }

  function renderStages(): void {
    const idx = (st: BurnStage | null) => (st ? STAGES.findIndex((s) => s.id === st) : -1);
    const at = state === 'done' ? STAGES.length : idx(reached);
    const failIdx = idx(failedAt);
    stages.hidden = state === 'ready';
    STAGES.forEach((s, i) => {
      const li = stageEls.get(s.id)!;
      const skipped = s.id === 'signing' && mode === 'mock';
      li.className = 'burn-stage';
      if (skipped && (at > i || state === 'done')) li.classList.add('is-skipped');
      else if (failIdx === i) li.classList.add(state === 'pending' ? 'is-waiting' : 'is-failed');
      else if (i < at || (state === 'done' && i <= at)) li.classList.add('is-done');
      else if (i === at && state === 'busy') li.classList.add('is-active');
    });
  }

  function renderHave(): void {
    const s = ctx.wallet.getSession();
    if (req.purpose === 'ranked' && s) {
      const n = s.profile.rankedTickets;
      setText(ticketsLine, `You have ${n} ${n === 1 ? 'ticket' : 'tickets'}.`);
    } else if (item && ownsItem() && state !== 'done') {
      setText(ticketsLine, 'You already own this.');
    } else {
      setText(ticketsLine, '');
    }
  }

  function render(): void {
    renderHave();
    renderStages();
    body.dataset.state = state;
    msgEl.textContent = '';
    msgEl.className = 'burn-msg';
    if (message) {
      msgEl.classList.add(state === 'pending' ? 'is-wait' : state === 'error' ? 'is-bad' : 'is-info');
      msgEl.append(icon(state === 'error' ? 'warning' : 'bolt'), h('span', { text: message }));
    }
    clear(actions);
    const session = ctx.wallet.getSession();
    const close = () => handle.close();
    if (state === 'done') {
      if (opts.doneAction) {
        const go = button(opts.doneAction.label, { cls: 'btn--green', icon: 'play', onClick: () => {
          handle.close();
          opts.doneAction!.run();
        } });
        go.id = 'btn-burn-next';
        const done = button('DONE', { cls: 'btn--ghost', onClick: close });
        done.id = 'btn-burn-done';
        actions.append(done, go);
      } else {
        const done = button('DONE', { cls: 'btn--green', icon: 'check', onClick: close });
        done.id = 'btn-burn-done';
        actions.append(done);
      }
      return;
    }
    if (state === 'busy') {
      const wait = button(reached === 'signing' ? 'CHECK PHANTOM…' : 'BURNING…', { cls: 'btn--burn' });
      wait.disabled = true;
      wait.prepend(h('span', { class: 'spinner' }));
      actions.append(wait);
      return;
    }
    if (!session) {
      const connect = button('CONNECT PHANTOM', { cls: 'btn--phantom', icon: 'phantom', onClick: () => {
        connect.disabled = true;
        void core.signIn().then((ok) => {
          if (closed) return;
          if (ok && state === 'pending') void checkAgain();
          else render();
        });
      } });
      actions.append(button('CANCEL', { cls: 'btn--ghost', onClick: close }), connect);
      return;
    }
    if (state === 'pending') {
      const again = button('CHECK AGAIN', { cls: 'btn--gold', icon: 'bolt', onClick: () => void checkAgain() });
      again.id = 'btn-burn-check';
      actions.append(button('CLOSE', { cls: 'btn--ghost', onClick: close }), again);
      return;
    }
    if (item && ownsItem()) {
      actions.append(button('CLOSE', { cls: 'btn--ghost', onClick: close }));
      return;
    }
    const go = button(state === 'error' ? 'TRY AGAIN' : `BURN ${formatTokens(amount!)}`, { cls: 'btn--burn', icon: 'flame', onClick: () => void start() });
    go.id = 'btn-burn-confirm';
    go.dataset.nosfx = '1';
    actions.append(button('CANCEL', { cls: 'btn--ghost', onClick: close }), go);
  }

  function succeed(r: BurnReceipt): void {
    state = 'done';
    message = '';
    reached = 'done';
    failedAt = null;
    core.sound('taskDone');
    clear(result);
    const lines: HTMLElement[] = [h('div', { class: 'burn-result-main' }, icon('flame'), h('span', { text: `${formatTokens(r.amount)} ${ticker} burned. Gone for good.` }))];
    if (r.purpose === 'ranked') {
      const n = r.profile.rankedTickets;
      lines.push(h('div', { class: 'burn-result-sub', text: `Ranked ticket added. You have ${n} ${n === 1 ? 'ticket' : 'tickets'}.` }));
    } else if (item) {
      const on = r.profile.cosmetics.equipped[item.slot] === item.id;
      lines.push(h('div', { class: 'burn-result-sub', text: on ? `${item.name} unlocked and equipped.` : `${item.name} unlocked. Equip it in the shop.` }));
    }
    const link = safeExplorer(r.explorerUrl);
    if (link) lines.push(explorerLink(link));
    else if (mode === 'mock') lines.push(h('div', { class: 'burn-result-note', text: 'Test burn: there is no on-chain transaction.' }));
    result.append(...lines);
    render();
    reveal(result);
    try {
      opts.onDone?.(r);
    } catch (err) {
      console.error('[ui] burn onDone failed', err);
    }
    if (closed) core.toast(receiptToast(r, ticker), 'good');
  }

  function fail(msg: string): void {
    failedAt = reached ?? 'preparing';
    message = msg || 'The burn failed. Try again.';
    // Before Phantom was asked there is no transaction at all: say so.
    if (failedAt === 'preparing' && !/nothing was (burned|signed)/i.test(message)) message = `${message.replace(/[.\s]*$/, '')}. Nothing was burned.`;
    state = isPendingBurnError(message) ? 'pending' : 'error';
    core.sound('error');
    render();
    reveal(msgEl);
    if (closed) core.toast(message, state === 'pending' ? 'info' : 'bad');
  }

  async function start(): Promise<void> {
    if (state === 'busy' || state === 'done' || state === 'pending') return;
    if (!ctx.wallet.getSession()) {
      render();
      return;
    }
    state = 'busy';
    reached = 'preparing';
    failedAt = null;
    message = '';
    clear(result);
    render();
    try {
      const r = await ctx.wallet.burn(req, (st) => {
        reached = st;
        if (state === 'busy') render();
      });
      succeed(r);
    } catch (err) {
      fail(err instanceof Error ? err.message : '');
    }
  }

  /** Re-confirm burns that were sent but not confirmed yet. Never starts a new burn. */
  async function checkAgain(): Promise<void> {
    if (state !== 'pending') return;
    state = 'busy';
    reached = 'confirming';
    failedAt = null;
    message = 'Checking the chain…';
    render();
    let receipts: BurnReceipt[] = [];
    try {
      receipts = await ctx.wallet.resumePendingBurns();
    } catch {
      receipts = [];
    }
    const mine = receipts.find((r) => r.purpose === req.purpose && (req.purpose === 'ranked' || r.itemId === req.itemId));
    for (const r of receipts) if (r !== mine) core.toast(receiptToast(r, ticker), 'good');
    if (mine) {
      succeed(mine);
      return;
    }
    state = 'pending';
    failedAt = 'confirming';
    message = ctx.wallet.getSession()
      ? 'Still not confirmed. Your burn is saved and checked again next time you open the game. Try again in a minute.'
      : 'Connect Phantom again to finish confirming your burn.';
    render();
  }

  const title = req.purpose === 'ranked' ? 'RANKED TICKET' : 'BURN TO UNLOCK';
  const handle = core.openModal({
    title,
    body,
    cls: 'modal--burn',
    stack: true,
    dismissible: () => state !== 'busy',
    onClose: () => {
      closed = true;
    },
  });
  const offWallet = ctx.wallet.onChange(() => {
    if (closed) {
      offWallet();
      return;
    }
    if (state === 'ready' || state === 'error' || state === 'pending') render();
  });
  render();
  // The ticket count / owned list may be stale (a ranked game used a ticket): refresh it in the background.
  if (ctx.wallet.getSession()) void ctx.wallet.refreshProfile();
  return handle;
}

// ---------- Recent burns ----------

function recordWhat(r: BurnRecord): string {
  if (r.purpose === 'ranked') return 'ranked ticket';
  const item = r.itemId ? cosmeticById(r.itemId) : undefined;
  return item ? `${item.name} · ${slotNoun(item.slot)}` : 'cosmetic';
}

export function openRecentBurns(core: UiCore): void {
  const ticker = core.ctx.config.ticker;
  const total = h('div', { class: 'burns-total' });
  const list = h('div', { class: 'burns-list' });
  const body = h(
    'div',
    { class: 'burns' },
    core.burnMode() === 'mock' ? testModeBadge() : null,
    total,
    h('p', { class: 'burns-note', text: 'Every burn destroys tokens for good. Nobody receives them. There is no pot.' }),
    list,
  );
  list.append(h('div', { class: 'lb-state lb-state--loading' }, h('span', { class: 'spinner' }), 'Loading burns…'));
  let gone = false;
  core.openModal({ title: 'RECENT BURNS', body, cls: 'modal--burns', onClose: () => void (gone = true) });

  const load = () => {
    fetchBurnStats()
      .then((st) => {
        if (gone) return;
        clear(total);
        total.append(
          h('span', { class: 'burns-total-ico' }, icon('flame')),
          h('span', { class: 'burns-total-n', text: formatTokens(st.totalBurned) }),
          h('span', { class: 'burns-total-t', text: `${ticker} burned` }),
          h('span', { class: 'burns-total-c', text: `${st.burns} ${st.burns === 1 ? 'burn' : 'burns'}` }),
        );
        clear(list);
        if (!st.recent.length) {
          list.append(h('div', { class: 'lb-state', text: 'No burns yet.' }));
          return;
        }
        const now = Date.now();
        for (const r of st.recent) {
          const link = safeExplorer(r.explorerUrl);
          list.append(
            h(
              'div',
              { class: 'burns-row' },
              h('span', { class: 'burns-row-ico' }, icon(r.purpose === 'ranked' ? 'ticket' : 'sparkle')),
              h(
                'span',
                { class: 'burns-row-who' },
                h('span', { class: 'burns-row-name', text: r.name || r.shortAddress || 'anon' }),
                h('span', { class: 'burns-row-what', text: `${recordWhat(r)} · ${timeAgo(r.at, now)}` }),
              ),
              h('span', { class: 'burns-row-amt', text: formatTokens(r.amount) }),
              link
                ? h('a', { class: 'icon-btn burns-row-link', attrs: { href: link, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'View on Solscan', title: 'View on Solscan' } }, icon('external'))
                : h('span', { class: 'burns-row-link burns-row-link--none' }),
            ),
          );
        }
      })
      .catch((err: unknown) => {
        if (gone) return;
        clear(list);
        list.append(
          h(
            'div',
            { class: 'lb-state lb-state--error' },
            h('span', { text: err instanceof Error ? err.message : 'Could not load burns.' }),
            button('RETRY', { cls: 'btn--sm', onClick: load }),
          ),
        );
      });
  };
  load();
}
