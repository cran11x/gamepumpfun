// Reusable chat panel (lobby, X SPACES meeting, ghost chat, post-game). Messages render via textContent only.

import { CHAT_RATE_LIMIT_MS, MAX_CHAT_LENGTH } from '../../../shared/constants';
import type { ChatChannel, ChatMessage } from '../../../shared/protocol';
import type { UiCore } from './core';
import { h, icon } from './dom';
import { colorOf, pillDot } from './pill';

const MAX_ROWS = 120;

export interface ChatOpts {
  channels: ChatChannel[];
  placeholder: string;
  /** Text shown while there are no messages. */
  emptyText?: string;
  /** When provided, messages arriving while this returns false count as unread. */
  isVisible?: () => boolean;
  onUnread?: (count: number) => void;
  cls?: string;
  /** Hide messages older than this server time (e.g. lobby chatter inside the game's chats). */
  since?: () => number;
}

export interface ChatPanel {
  el: HTMLElement;
  setChannels(channels: ChatChannel[], placeholder?: string): void;
  setEnabled(enabled: boolean, placeholder?: string): void;
  markRead(): void;
  focus(): void;
  destroy(): void;
}

/** Player colors that are too dark to read as text on the dark panels get a lighter stand-in. */
export function readableColor(index: number): string {
  const hex = colorOf(index).body.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 0.3 ? '#aab4c4' : `#${hex}`;
}

export function createChat(core: UiCore, opts: ChatOpts): ChatPanel {
  const { ctx } = core;
  let channels = new Set<ChatChannel>(opts.channels);
  let unread = 0;
  let lastSentAt = 0;
  let pending: number | null = null;

  const list = h('div', { class: 'chat-list', attrs: { 'aria-live': 'polite' } });
  const empty = h('div', { class: 'chat-empty', text: opts.emptyText ?? 'No messages yet. Say gm.' });
  const input = h('input', {
    class: 'chat-input',
    type: 'text',
    attrs: { maxlength: String(MAX_CHAT_LENGTH), placeholder: opts.placeholder, autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'Chat message' },
  });
  const sendBtn = h('button', { class: 'chat-send', type: 'submit', attrs: { 'aria-label': 'Send' } }, icon('send'));
  const form = h('form', { class: 'chat-form' }, input, sendBtn);
  const el = h('div', { class: `chat ${opts.cls ?? ''}`.trim() }, list, form);
  list.append(empty);

  // Keep keystrokes inside the chat from reaching the game's hotkeys.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') input.blur();
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const wait = CHAT_RATE_LIMIT_MS + 40 - (Date.now() - lastSentAt);
    const send = () => {
      pending = null;
      lastSentAt = Date.now();
      ctx.net.send({ t: 'chat', text: text.slice(0, MAX_CHAT_LENGTH) });
    };
    if (wait > 0) {
      if (pending !== null) {
        // Only one message waits for the rate limit; give the rest back to the player.
        input.value = text;
        form.classList.remove('is-wait');
        void form.offsetWidth;
        form.classList.add('is-wait');
        return;
      }
      pending = window.setTimeout(send, wait);
    } else {
      send();
    }
  });

  function row(m: ChatMessage): HTMLElement {
    if (m.channel === 'system') {
      return h('div', { class: 'chat-msg chat-msg--system' }, icon('bolt'), h('span', { class: 'chat-text', text: m.text }));
    }
    const mine = m.fromId !== null && m.fromId === core.myId();
    const name = h('span', { class: 'chat-name', text: m.fromName });
    name.style.color = readableColor(m.color);
    const r = h(
      'div',
      { class: `chat-msg${m.channel === 'ghost' ? ' chat-msg--ghost' : ''}${mine ? ' chat-msg--me' : ''}` },
      pillDot(m.color),
      h('span', { class: 'chat-body' }, m.channel === 'ghost' ? icon('ghost', 'chat-ghost') : null, name, h('span', { class: 'chat-text', text: m.text })),
    );
    return r;
  }

  const fresh = (m: ChatMessage) => !opts.since || m.ts >= opts.since();

  function add(m: ChatMessage, scroll: boolean): void {
    if (!channels.has(m.channel) || !fresh(m)) return;
    if (empty.isConnected) empty.remove();
    const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 48;
    list.append(row(m));
    while (list.childElementCount > MAX_ROWS) list.firstElementChild?.remove();
    if (scroll || nearBottom) list.scrollTop = list.scrollHeight;
  }

  function fill(): void {
    list.textContent = '';
    const msgs = ctx.store.chat.filter((m) => channels.has(m.channel) && fresh(m));
    if (!msgs.length) list.append(empty);
    for (const m of msgs.slice(-MAX_ROWS)) add(m, true);
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  }

  const off = ctx.store.onChat((m) => {
    if (!channels.has(m.channel) || !fresh(m)) return;
    add(m, m.fromId !== null && m.fromId === core.myId());
    if (opts.isVisible && !opts.isVisible() && m.channel !== 'system') {
      unread++;
      opts.onUnread?.(unread);
    }
  });

  fill();

  // Stay on the newest message when the list shrinks (an on-screen keyboard opening, a tab switch).
  // Scrolls caused by the resize itself (scroll anchoring) don't count as the player scrolling away.
  let pinned = true;
  let seenHeight = -1;
  list.addEventListener(
    'scroll',
    () => {
      if (list.clientHeight === seenHeight) pinned = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
    },
    { passive: true },
  );
  const resizeObs =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          seenHeight = list.clientHeight;
          if (pinned) list.scrollTop = list.scrollHeight;
        })
      : null;
  resizeObs?.observe(list);

  return {
    el,
    setChannels(next, placeholder) {
      const same = next.length === channels.size && next.every((c) => channels.has(c));
      if (placeholder) input.placeholder = placeholder;
      if (same) return;
      channels = new Set(next);
      fill();
    },
    setEnabled(enabled, placeholder) {
      input.disabled = !enabled;
      sendBtn.disabled = !enabled;
      if (placeholder) input.placeholder = placeholder;
      if (!enabled && document.activeElement === input) input.blur();
    },
    markRead() {
      unread = 0;
      opts.onUnread?.(0);
      list.scrollTop = list.scrollHeight;
      pinned = true;
    },
    focus() {
      if (!input.disabled) input.focus();
    },
    destroy() {
      off();
      resizeObs?.disconnect();
      if (pending !== null) window.clearTimeout(pending);
      if (document.activeElement === input) input.blur();
    },
  };
}
