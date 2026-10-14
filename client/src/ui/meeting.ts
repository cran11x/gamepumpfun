// X SPACES meeting: header (reason, caller, stage, timer), player cards with voting, SKIP,
// meeting/ghost chat and the results stage with voter dots.

import { PLAYER_COLORS } from '../../../shared/constants';
import type { MeetingView, PlayerView, Snapshot } from '../../../shared/protocol';
import { createChat } from './chat';
import type { Screen, UiCore } from './core';
import { clear, clock, h, icon, setDisabled, setHidden, setText, toggleClass } from './dom';
import { bagSvg, pillDot, pillSvg } from './pill';

const SKIP = 'skip';

interface Card {
  el: HTMLElement;
  pill: HTMLElement;
  name: HTMLElement;
  sub: HTMLElement;
  dots: HTMLElement;
  confirm: HTMLElement;
  pillKey: string;
}

export function createMeeting(core: UiCore): Screen {
  const { ctx } = core;
  let snap: Snapshot | null = null;
  let stage: MeetingView['stage'] | null = null;
  let selected: string | null = null;
  let pendingVote: { target: string; at: number } | null = null;
  let prevVoted: Set<string> | null = null;
  let cardsSig = '';
  let timer: number | null = null;
  let headerBuilt = false;
  let chatTab: 'players' | 'chat' = 'players';
  const cards = new Map<string, Card>();

  // ----- Header -----
  const title = h('h1', { class: 'mt-title' });
  const stageChip = h('span', { class: 'mt-stage' });
  const timerEl = h('span', { class: 'mt-timer' });
  const progFill = h('span', { class: 'mt-prog-fill' });
  const head = h(
    'header',
    { class: 'mt-head' },
    h('div', { class: 'mt-brand' }, h('span', { class: 'mt-live' }, h('span', { class: 'live-dot live-dot--red' }), 'LIVE'), h('span', { class: 'mt-x' }, icon('x')), h('span', { class: 'mt-brand-txt', text: 'SPACES' })),
    title,
    h('div', { class: 'mt-stagebar' }, stageChip, timerEl),
    h('div', { class: 'mt-prog' }, progFill),
  );

  // ----- Cards + skip -----
  const grid = h('div', { class: 'mt-grid' });
  const status = h('div', { class: 'mt-status' });
  const skipDots = h('div', { class: 'mt-dots mt-dots--skip' });
  const skipBtn = h('button', { class: 'btn btn--ghost mt-skip', type: 'button' }, icon('skip'), h('span', { class: 'btn-label', text: 'SKIP VOTE' }));
  const skipConfirm = h('div', { class: 'mt-skip-confirm' });
  const skipYes = h('button', { class: 'btn btn--sm btn--gold', type: 'button' }, icon('check'), h('span', { class: 'btn-label', text: 'CONFIRM SKIP' }));
  const skipNo = h('button', { class: 'icon-btn', type: 'button', attrs: { 'aria-label': 'Cancel' } }, icon('close'));
  skipYes.dataset.nosfx = '1';
  skipConfirm.append(skipYes, skipNo);
  skipConfirm.hidden = true;
  const skipWrap = h('div', { class: 'mt-skipwrap' }, skipBtn, skipConfirm, skipDots);
  const main = h('section', { class: 'mt-main' }, grid, h('div', { class: 'mt-foot' }, skipWrap, status));

  skipBtn.addEventListener('click', () => {
    if (!canVote()) return;
    selected = SKIP;
    refresh();
  });
  skipYes.addEventListener('click', () => castVote(SKIP));
  skipNo.addEventListener('click', () => {
    selected = null;
    refresh();
  });

  // ----- Chat -----
  const chatBadge = h('span', { class: 'badge-count' });
  chatBadge.hidden = true;
  const chat = createChat(core, {
    channels: ['meeting', 'system'],
    placeholder: 'Speak up in the Space…',
    emptyText: 'Nobody has spoken yet. Who is sus?',
    cls: 'mt-chatpanel',
    since: () => core.gameStartedAt(),
    isVisible: () => !core.isNarrow() || chatTab === 'chat',
    onUnread: (n) => {
      setHidden(chatBadge, n === 0);
      setText(chatBadge, String(n));
    },
  });
  const chatHead = h('header', { class: 'panel-head' }, icon('chat'), h('h2', { class: 'mt-chat-title', text: 'SPACE CHAT' }));
  const chatPanel = h('section', { class: 'mt-chat panel' }, chatHead, chat.el);

  const tabPlayers = h('button', { class: 'mt-tab is-active', type: 'button', text: 'PLAYERS' });
  const tabChat = h('button', { class: 'mt-tab', type: 'button' }, 'CHAT', chatBadge);
  const tabs = h('div', { class: 'mt-tabs' }, tabPlayers, tabChat);
  const setTab = (t: 'players' | 'chat') => {
    chatTab = t;
    toggleClass(tabPlayers, 'is-active', t === 'players');
    toggleClass(tabChat, 'is-active', t === 'chat');
    toggleClass(body, 'show-chat', t === 'chat');
    if (t === 'chat') chat.markRead();
  };
  tabPlayers.addEventListener('click', () => setTab('players'));
  tabChat.addEventListener('click', () => setTab('chat'));

  const body = h('div', { class: 'mt-body' }, main, chatPanel);
  const splash = h('div', { class: 'mt-splash' });
  const el = h('div', { class: 'screen screen--solid meeting' }, h('div', { class: 'mt-wrap' }, head, tabs, body), splash);

  function myId(): string | null {
    return snap?.me?.id ?? core.myId();
  }

  function amAlive(): boolean {
    return !!snap?.me?.alive;
  }

  function myVote(): string | null {
    const m = snap?.meeting;
    if (m?.myVote) return m.myVote;
    if (pendingVote && Date.now() - pendingVote.at < 3000) return pendingVote.target;
    return null;
  }

  function canVote(): boolean {
    const m = snap?.meeting;
    return !!m && m.stage === 'voting' && amAlive() && myVote() === null;
  }

  function castVote(target: string): void {
    if (!canVote()) return;
    pendingVote = { target, at: Date.now() };
    selected = null;
    ctx.net.send({ t: 'vote', target });
    core.sound('vote');
    refresh();
  }

  function nameOf(id: string): string {
    return snap?.players.find((p) => p.id === id)?.name ?? core.who(id)?.name ?? 'someone';
  }

  function buildHeader(s: Snapshot): void {
    const m = s.meeting!;
    headerBuilt = true;
    const caller = nameOf(m.callerId);
    if (m.reason === 'report') {
      const color = m.bodyColor ?? 0;
      title.textContent = '';
      title.append(
        h('span', { class: 'mt-at', text: `@${caller}` }),
        ' reported a rugged bag ',
        h('span', { class: 'mt-bodycolor' }, pillDot(color), `(${PLAYER_COLORS[color]?.name ?? 'unknown'})`),
      );
      splash.append(h('div', { class: 'mt-splash-art', html: bagSvg(color) }), h('div', { class: 'mt-splash-txt', text: 'RUGGED BAG REPORTED' }));
    } else {
      title.textContent = '';
      title.append(h('span', { class: 'mt-at', text: `@${caller}` }), ' started an X Space');
      splash.append(h('div', { class: 'mt-splash-art mt-splash-art--mic' }, icon('mic')), h('div', { class: 'mt-splash-txt', text: 'X SPACES IS LIVE' }));
    }
    splash.classList.add(m.reason === 'report' ? 'mt-splash--report' : 'mt-splash--emergency');
    window.setTimeout(() => splash.classList.add('is-gone'), 1700);
  }

  function buildCards(s: Snapshot): void {
    const players = sortedPlayers(s.players);
    const sig = players.map((p) => p.id).join(',');
    if (sig === cardsSig) return;
    cardsSig = sig;
    clear(grid);
    cards.clear();
    for (const p of players) {
      const pill = h('span', { class: 'mt-card-pill' });
      const name = h('span', { class: 'mt-card-name', text: p.name });
      const sub = h('span', { class: 'mt-card-sub' });
      const dots = h('span', { class: 'mt-dots' });
      const yes = h('button', { class: 'mt-confirm-yes', type: 'button', attrs: { 'aria-label': `Vote ${p.name}` } }, icon('check'));
      const no = h('button', { class: 'mt-confirm-no', type: 'button', attrs: { 'aria-label': 'Cancel' } }, icon('close'));
      yes.dataset.nosfx = '1';
      const confirm = h('span', { class: 'mt-confirm' }, h('span', { class: 'mt-confirm-k', text: 'VOTE?' }), yes, no);
      confirm.hidden = true;
      const stamp = h('span', { class: 'mt-stamp', text: 'VOTED' });
      const cardEl = h(
        'div',
        { class: 'mt-card', dataset: { id: p.id }, attrs: { role: 'button', tabindex: '0', 'aria-label': p.name } },
        h('span', { class: 'mt-card-avatar' }, pill, h('span', { class: 'mt-card-ring' })),
        h('span', { class: 'mt-card-info' }, name, sub, dots),
        stamp,
        confirm,
      );
      cardEl.addEventListener('click', (e) => {
        const t = e.target as Element;
        if (t.closest('.mt-confirm-yes')) {
          e.stopPropagation();
          castVote(p.id);
          return;
        }
        if (t.closest('.mt-confirm-no')) {
          e.stopPropagation();
          selected = null;
          refresh();
          return;
        }
        if (!canVote() || !isAliveIn(p.id)) return;
        selected = selected === p.id ? null : p.id;
        core.sound('click');
        refresh();
      });
      cardEl.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === cardEl) {
          e.preventDefault();
          cardEl.click();
        }
      });
      grid.append(cardEl);
      cards.set(p.id, { el: cardEl, pill, name, sub, dots, confirm, pillKey: '' });
    }
  }

  function sortedPlayers(players: PlayerView[]): PlayerView[] {
    return [...players].sort((a, b) => Number(b.alive) - Number(a.alive));
  }

  function isAliveIn(id: string): boolean {
    return !!snap?.players.find((p) => p.id === id)?.alive;
  }

  function refresh(): void {
    const s = snap;
    const m = s?.meeting;
    if (!s || !m) return;
    const me = myId();
    const voting = m.stage === 'voting';
    const results = m.stage === 'results';
    const voted = new Set(m.votedIds);
    const mine = myVote();
    const can = canVote();
    if (selected && (!can || (selected !== SKIP && !isAliveIn(selected)))) selected = null;

    // Tally for results.
    const byTarget = new Map<string, string[]>();
    if (results && m.votes) {
      for (const [voter, target] of Object.entries(m.votes)) {
        const list = byTarget.get(target) ?? [];
        list.push(voter);
        byTarget.set(target, list);
      }
    }

    const viewerRugger = s.me?.role === 'rugger';
    for (const p of s.players) {
      const c = cards.get(p.id);
      if (!c) continue;
      const pillKey = `${p.color}|${p.alive}`;
      if (pillKey !== c.pillKey) {
        c.pillKey = pillKey;
        c.pill.innerHTML = pillSvg(p.color, { variant: p.alive ? 'alive' : 'dead', legs: false });
      }
      setText(c.name, p.name);
      toggleClass(c.name, 'is-rugger', !!p.isRugger && (viewerRugger || !s.me?.alive));
      const subs: string[] = [];
      if (p.id === me) subs.push('YOU');
      if (p.id === m.callerId) subs.push(m.reason === 'report' ? 'REPORTER' : 'HOST');
      if (!p.alive) subs.push('RUGGED');
      if (p.disconnected) subs.push('OFFLINE');
      setText(c.sub, subs.join(' · '));
      toggleClass(c.el, 'is-dead', !p.alive);
      toggleClass(c.el, 'is-me', p.id === me);
      toggleClass(c.el, 'is-caller', p.id === m.callerId);
      toggleClass(c.el, 'is-voted', voted.has(p.id));
      toggleClass(c.el, 'is-selected', selected === p.id);
      toggleClass(c.el, 'is-myvote', mine === p.id);
      toggleClass(c.el, 'is-votable', can && p.alive);
      toggleClass(c.el, 'is-ejected', results && m.ejectedId === p.id);
      setHidden(c.confirm, selected !== p.id);
      c.el.setAttribute('aria-disabled', String(!(can && p.alive)));
      // Voter dots.
      const voters = byTarget.get(p.id) ?? [];
      const dotKey = voters.join(',');
      if (c.dots.dataset.k !== dotKey) {
        c.dots.dataset.k = dotKey;
        clear(c.dots);
        for (const v of voters) c.dots.append(pillDot(colorOfPlayer(v)));
      }
    }

    // Skip.
    toggleClass(skipBtn, 'is-myvote', mine === SKIP);
    setDisabled(skipBtn, !can);
    setHidden(skipBtn, selected === SKIP);
    setHidden(skipConfirm, selected !== SKIP);
    const skippers = byTarget.get(SKIP) ?? [];
    const sk = skippers.join(',');
    if (skipDots.dataset.k !== sk) {
      skipDots.dataset.k = sk;
      clear(skipDots);
      if (skippers.length) skipDots.append(h('span', { class: 'mt-dots-k', text: 'SKIPPED' }));
      for (const v of skippers) skipDots.append(pillDot(colorOfPlayer(v)));
    }

    // Status line.
    let st = '';
    let tone = '';
    if (!amAlive()) {
      st = "Ghosts can't vote. Chat with the other ghosts.";
      tone = 'ghost';
    } else if (m.stage === 'discussion') {
      st = 'Discuss. Voting opens soon.';
    } else if (voting) {
      if (mine) st = mine === SKIP ? 'You voted to skip.' : `You voted for ${nameOf(mine)}.`;
      else st = selected ? 'Confirm your vote.' : 'Tap a player to vote, or skip.';
      tone = mine ? 'good' : '';
    } else if (results) {
      if (m.tie) st = 'Tie vote. No one gets blacklisted.';
      else if (m.ejectedId) st = `${nameOf(m.ejectedId)} is getting blacklisted…`;
      else st = 'Skipped. No one gets blacklisted.';
      tone = m.ejectedId ? 'bad' : '';
    }
    setText(status, st);
    status.className = `mt-status${tone ? ` mt-status--${tone}` : ''}`;
    toggleClass(el, 'is-results', results);
    toggleClass(el, 'is-voting', voting);
  }

  function colorOfPlayer(id: string): number {
    return snap?.players.find((p) => p.id === id)?.color ?? core.who(id)?.color ?? 0;
  }

  function tick(): void {
    const s = snap;
    const m = s?.meeting;
    if (!s || !m) return;
    const remain = s.phaseEndsAt !== undefined ? s.phaseEndsAt - ctx.net.serverNow() : 0;
    setText(timerEl, m.stage === 'results' ? '' : clock(remain));
    toggleClass(timerEl, 'is-low', m.stage !== 'results' && remain < 10_000);
    const total =
      m.stage === 'discussion' ? s.room.settings.discussionTime * 1000 : m.stage === 'voting' ? s.room.settings.votingTime * 1000 : 4000;
    const frac = total > 0 ? Math.max(0, Math.min(1, remain / total)) : 0;
    progFill.style.transform = `scaleX(${frac})`;
  }

  function update(next: Snapshot | null): void {
    if (!next || !next.meeting) return;
    snap = next;
    const m = next.meeting;
    if (!headerBuilt) buildHeader(next);
    buildCards(next);
    if (m.stage !== stage) {
      const prev = stage;
      stage = m.stage;
      selected = null;
      const label = m.stage === 'discussion' ? 'DISCUSSION' : m.stage === 'voting' ? 'VOTING' : 'RESULTS';
      setText(stageChip, label);
      stageChip.className = `mt-stage mt-stage--${m.stage}`;
      if (prev !== null) {
        el.classList.remove('is-stagechange');
        void el.offsetWidth;
        el.classList.add('is-stagechange');
      }
    }
    if (pendingVote && (m.myVote || Date.now() - pendingVote.at > 3000)) pendingVote = null;
    const nowVoted = new Set(m.votedIds);
    if (prevVoted && m.stage === 'voting') {
      // Someone else voted (our own vote already played its sound when we cast it).
      const me = myId();
      for (const id of nowVoted) {
        if (!prevVoted.has(id) && id !== me) {
          core.sound('vote');
          break;
        }
      }
    }
    prevVoted = nowVoted;
    const dead = !next.me?.alive;
    chat.setChannels(dead ? ['meeting', 'ghost', 'system'] : ['meeting', 'system'], dead ? 'Ghost chat (only ghosts see this)…' : 'Speak up in the Space…');
    setText(chatHead.querySelector('.mt-chat-title')!, dead ? 'SPACE + GHOST CHAT' : 'SPACE CHAT');
    toggleClass(el, 'is-ghost', dead);
    refresh();
    tick();
  }

  timer = window.setInterval(tick, 250);

  return {
    el,
    update,
    onEscape() {
      if (selected) {
        selected = null;
        refresh();
        return true;
      }
      return false;
    },
    destroy() {
      if (timer !== null) window.clearInterval(timer);
      chat.destroy();
    },
  };
}
