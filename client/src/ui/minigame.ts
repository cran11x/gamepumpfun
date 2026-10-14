// Minigame overlay host: mounts tasks/ minigames, sends taskOpen / taskDone / taskClose / fix messages,
// enforces TASK_MIN_MS client-side and closes itself when the game state makes the minigame moot.

import { SABOTAGE_STATIONS, SABOTAGE_TITLES, TASK_MIN_MS, TASK_TITLES, stationById } from '../../../shared/map';
import type { FixKind, Snapshot } from '../../../shared/protocol';
import type { MinigameHost, MinigameTarget } from '../context';
import { mountMinigame } from '../tasks/index';
import type { UiCore } from './core';
import { h, icon, roomName } from './dom';

/** Extra wait on top of TASK_MIN_MS so network jitter never makes the server reject taskDone. */
const MIN_MS_MARGIN = 180;
/** If the server never acknowledges taskOpen (activeStationId) within this window, give up. */
const ACK_TIMEOUT_MS = 3000;

const FIX_TITLES: Record<FixKind, string> = {
  fixDump: 'HOLD THE BUY WALL',
  fixFud: 'CLEAR THE FUD',
  fixRpc: 'REBOOT THE RPC',
};

type CloseMode = 'taskClose' | 'holdEnd' | 'silent';

interface Session {
  target: MinigameTarget;
  el: HTMLElement;
  body: HTMLElement;
  closeBtn: HTMLButtonElement;
  cleanup: (() => void) | null;
  openedAt: number;
  wasAlive: boolean;
  isHolderTask: boolean;
  acked: boolean;
  completing: boolean;
  closed: boolean;
  holding: boolean;
  timer: number | null;
}

export interface MinigameController {
  open(target: MinigameTarget): void;
  /** Close as if the player dismissed it (sends taskClose / holdEnd). */
  close(): void;
  isOpen(): boolean;
  /** Escape key: closes unless a completion is being confirmed. Returns true when consumed. */
  escape(): boolean;
  onSnapshot(snap: Snapshot | null): void;
  onConnection(connected: boolean): void;
  onError(): void;
}

export function createMinigameHost(core: UiCore, layer: HTMLElement): MinigameController {
  const { ctx } = core;
  let cur: Session | null = null;

  function active(s: Session): boolean {
    return cur === s && !s.closed;
  }

  function finish(s: Session, mode: CloseMode): void {
    if (s.closed) return;
    s.closed = true;
    if (s.timer !== null) window.clearTimeout(s.timer);
    s.timer = null;
    const phase = ctx.store.snap?.phase;
    if (phase === 'playing') {
      if (mode === 'taskClose' && s.target.type === 'task') ctx.net.send({ t: 'taskClose' });
      if (mode === 'holdEnd' && s.target.type === 'fix') ctx.net.send({ t: 'fix', stationId: s.target.stationId, action: 'holdEnd' });
    }
    try {
      s.cleanup?.();
    } catch (err) {
      console.error('[ui] minigame cleanup failed', err);
    }
    s.cleanup = null;
    s.el.classList.add('is-leaving');
    s.el.style.pointerEvents = 'none';
    window.setTimeout(() => s.el.remove(), 170);
    if (cur === s) cur = null;
    core.setBlocker('minigame', false);
  }

  function userClose(s: Session): void {
    if (!active(s) || s.completing) return;
    if (s.target.type === 'task') finish(s, 'taskClose');
    else finish(s, s.target.kind === 'fixDump' ? 'holdEnd' : 'silent');
  }

  function showConfirming(s: Session, ms: number): void {
    const fill = h('span', { class: 'mg-confirm-fill' });
    const box = h(
      'div',
      { class: 'mg-confirm' },
      h('div', { class: 'mg-confirm-inner' }, h('span', { class: 'spinner' }), h('span', { class: 'mg-confirm-txt', text: 'CONFIRMING ON-CHAIN…' }), h('span', { class: 'mg-confirm-bar' }, fill)),
    );
    s.body.append(box);
    s.closeBtn.disabled = true;
    fill.style.transitionDuration = `${Math.max(50, ms)}ms`;
    requestAnimationFrame(() => requestAnimationFrame(() => fill.classList.add('is-done')));
  }

  function complete(s: Session): void {
    if (!active(s) || s.completing) return;
    const t = s.target;
    if (t.type === 'fix') {
      if (t.kind === 'fixDump') {
        finish(s, 'holdEnd');
        return;
      }
      ctx.net.send({ t: 'fix', stationId: t.stationId, action: 'done' });
      finish(s, 'silent');
      return;
    }
    const me = ctx.store.snap?.me;
    if (!me || me.role !== 'holder') {
      // Rugger fake task: nothing to report, just close it like a normal exit.
      finish(s, 'taskClose');
      return;
    }
    s.completing = true;
    const send = () => {
      if (!active(s)) return;
      ctx.net.send({ t: 'taskDone', stationId: t.stationId });
      core.sound('taskDone');
      finish(s, 'silent');
    };
    const wait = TASK_MIN_MS[t.kind] + MIN_MS_MARGIN - (performance.now() - s.openedAt);
    if (wait > 0) {
      showConfirming(s, wait);
      s.timer = window.setTimeout(send, wait);
    } else {
      send();
    }
  }

  function canOpen(target: MinigameTarget, snap: Snapshot | null): boolean {
    const me = snap?.me;
    if (!snap || !me || snap.phase !== 'playing') return false;
    if (me.ventId) return false;
    if (target.type === 'task') {
      const task = me.tasks.find((x) => x.stationId === target.stationId);
      return !!task && !task.done;
    }
    if (!me.alive) {
      core.toast("Ghosts can't fix sabotage. Finish your tasks.", 'info');
      return false;
    }
    return !!snap.sabotage && snap.sabotage.stations.some((st) => st.id === target.stationId && !st.fixed);
  }

  function open(target: MinigameTarget): void {
    const snap = ctx.store.snap;
    if (cur && cur.target.stationId === target.stationId && cur.target.type === target.type && !cur.closed) return;
    if (!canOpen(target, snap)) return;
    if (cur) userClose(cur);
    if (cur) finish(cur, 'silent');
    const me = snap!.me!;

    let title: string;
    let where: string;
    if (target.type === 'task') {
      title = TASK_TITLES[target.kind] ?? 'TASK';
      where = roomName(stationById(target.stationId)?.room ?? '');
    } else {
      title = FIX_TITLES[target.kind];
      const st = SABOTAGE_STATIONS.find((x) => x.id === target.stationId);
      where = `${SABOTAGE_TITLES[st?.sabotage ?? 'fud']} · ${roomName(st?.room ?? '')}`;
    }
    const closeBtn = h('button', { class: 'mg-x', type: 'button', title: 'Close (Esc)', attrs: { 'aria-label': 'Close' } }, icon('close'));
    const body = h('div', { class: 'mg-body' });
    const frame = h(
      'div',
      { class: `mg-frame mg-frame--${target.type}`, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } },
      h(
        'div',
        { class: 'mg-head' },
        h('span', { class: 'mg-kind' }, icon(target.type === 'task' ? 'task' : 'wrench')),
        h('span', { class: 'mg-titles' }, h('span', { class: 'mg-title', text: title.toUpperCase() }), h('span', { class: 'mg-where', text: where })),
        h('kbd', { class: 'kbd mg-esc', text: 'ESC' }),
        closeBtn,
      ),
      body,
    );
    const el = h('div', { class: 'mg-overlay' }, frame);

    const s: Session = {
      target,
      el,
      body,
      closeBtn,
      cleanup: null,
      openedAt: performance.now(),
      wasAlive: me.alive,
      isHolderTask: target.type === 'task' && me.role === 'holder',
      acked: target.type === 'task' && me.activeStationId === target.stationId,
      completing: false,
      closed: false,
      holding: false,
      timer: null,
    };
    cur = s;
    closeBtn.addEventListener('click', () => userClose(s));
    // Dragging out of the panel must not close it; only a press that starts on the backdrop does.
    el.addEventListener('pointerdown', (e) => {
      if (e.target === el) userClose(s);
    });
    layer.append(el);
    core.setBlocker('minigame', true);
    try {
      ctx.game.setJoystick(0, 0);
    } catch {
      /* game not ready */
    }

    if (target.type === 'task') ctx.net.send({ t: 'taskOpen', stationId: target.stationId });

    const host: MinigameHost = {
      complete: () => complete(s),
      close: () => userClose(s),
      holdStart: () => {
        if (!active(s) || s.target.type !== 'fix' || s.target.kind !== 'fixDump') return;
        s.holding = true;
        ctx.net.send({ t: 'fix', stationId: s.target.stationId, action: 'holdStart' });
      },
      holdEnd: () => {
        if (!active(s) || s.target.type !== 'fix' || s.target.kind !== 'fixDump') return;
        s.holding = false;
        ctx.net.send({ t: 'fix', stationId: s.target.stationId, action: 'holdEnd' });
      },
      getSnapshot: () => ctx.store.snap,
      sound: (name) => core.sound(name),
      ticker: snap!.room.ticker || ctx.config.ticker,
      contractAddress: ctx.config.contractAddress,
    };

    try {
      const cleanup = mountMinigame(body, target, host);
      if (active(s)) s.cleanup = typeof cleanup === 'function' ? cleanup : null;
      else if (typeof cleanup === 'function') cleanup();
    } catch (err) {
      console.error('[ui] mountMinigame failed', err);
      core.toast("That console glitched. Try again.", 'bad');
      finish(s, target.type === 'task' ? 'taskClose' : 'silent');
    }
  }

  function onSnapshot(snap: Snapshot | null): void {
    const s = cur;
    if (!s || s.closed) return;
    const me = snap?.me;
    if (!snap || !me || snap.phase !== 'playing') return finish(s, 'silent');
    if (s.wasAlive && !me.alive) return finish(s, 'silent');
    if (me.ventId) return finish(s, 'silent');
    const t = s.target;
    if (t.type === 'task') {
      const task = me.tasks.find((x) => x.stationId === t.stationId);
      if (!task || task.done) return finish(s, 'silent');
      if (me.activeStationId === t.stationId) {
        s.acked = true;
      } else if (s.isHolderTask && !s.completing) {
        // The server closed it (e.g. it moved us) or never opened it.
        if (s.acked) return finish(s, 'silent');
        if (ctx.store.connected && performance.now() - s.openedAt > ACK_TIMEOUT_MS) {
          core.toast("Couldn't start that task. Get closer and try again.", 'bad');
          return finish(s, 'silent');
        }
      }
    } else {
      const sab = snap.sabotage;
      if (!sab || !sab.stations.some((st) => st.id === t.stationId && !st.fixed)) return finish(s, 'silent');
    }
  }

  return {
    open,
    close() {
      if (cur) {
        if (cur.completing) finish(cur, 'silent');
        else userClose(cur);
      }
    },
    isOpen: () => cur !== null && !cur.closed,
    escape() {
      if (!cur) return false;
      if (!cur.completing) userClose(cur);
      return true;
    },
    onSnapshot,
    onConnection(connected) {
      if (!connected && cur) {
        // Holds and open tasks don't survive a dropped socket reliably; start clean after reconnecting.
        finish(cur, 'silent');
      }
    },
    onError() {
      // A rejected taskOpen (too far, in a bridge…) arrives right after opening: close instead of
      // letting the player finish a task the server will refuse.
      const s = cur;
      if (s && s.isHolderTask && !s.acked && !s.completing && performance.now() - s.openedAt < 2000) finish(s, 'silent');
    },
  };
}
