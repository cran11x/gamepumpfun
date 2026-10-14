// In-game HUD (phase 'playing'): bonding curve, task list, sabotage banner, action buttons with
// cooldown rings, sabotage menu, bridge links, ghost chat and the touch joystick.
// Built once; snapshots and a ~10 Hz loop update text/classes in place.

import { DEV_DUMP_DURATION_MS } from '../../../shared/constants';
import { roomAt, SABOTAGE_STATIONS, SABOTAGE_TITLES, stationById, TASK_TITLES, ventById } from '../../../shared/map';
import type { MeView, SabotageKind, Snapshot } from '../../../shared/protocol';
import type { UseTarget } from '../context';
import { createChat, type ChatPanel } from './chat';
import type { Screen, UiCore } from './core';
import { clear, clock, h, icon, roomName, setDisabled, setHidden, setText, toggleClass } from './dom';
import type { IconName } from './icons';
import { createJoystick } from './joystick';

const SAB_KINDS: SabotageKind[] = ['devDump', 'fud', 'rpcDown'];
const SAB_SUB: Record<SabotageKind, string> = {
  devDump: `Critical. ${Math.round(DEV_DUMP_DURATION_MS / 1000)}s to hold both BUY WALLs`,
  fud: "Holders' vision drops",
  rpcDown: 'Hide their tasks and the curve',
};
const SAB_ICON: Record<SabotageKind, IconName> = { devDump: 'rug', fud: 'ghost', rpcDown: 'globe' };
const RING_C = 2 * Math.PI * 46;
const LOOP_MS = 90;

interface ActBtn {
  el: HTMLButtonElement;
  ico: HTMLElement;
  label: HTMLElement;
  cd: HTMLElement;
  badge: HTMLElement;
  ring: SVGCircleElement | null;
}

function ringSvg(): { svg: SVGSVGElement; fg: SVGCircleElement } {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'act-ring');
  svg.setAttribute('aria-hidden', 'true');
  const bg = document.createElementNS(ns, 'circle');
  bg.setAttribute('cx', '50');
  bg.setAttribute('cy', '50');
  bg.setAttribute('r', '46');
  bg.setAttribute('class', 'act-ring-bg');
  const fg = document.createElementNS(ns, 'circle');
  fg.setAttribute('cx', '50');
  fg.setAttribute('cy', '50');
  fg.setAttribute('r', '46');
  fg.setAttribute('class', 'act-ring-fg');
  fg.style.strokeDasharray = String(RING_C);
  fg.style.strokeDashoffset = String(RING_C);
  svg.append(bg, fg);
  return { svg, fg };
}

export interface Hud extends Screen {
  flashTask(stationId: string): void;
}

/** The player's last choice for the task list, kept across HUD instances (meetings rebuild the HUD). */
let tasksCollapsedPref: boolean | null = null;

/** Landscape phones: an open task list would sit on the joystick, so it starts collapsed there. */
const SHORT_TOUCH_PX = 520;

export function createHud(core: UiCore): Hud {
  const { ctx } = core;
  let snap: Snapshot | null = null;
  let me: MeView | null = null;
  let raf = 0;
  let lastLoop = 0;
  let destroyed = false;
  let sabMenuOpen = false;
  let tasksSig = '';
  let bannerKey = '';
  let ventKey = '';
  let lastUseKey = '';
  const shortTouch = () => core.isTouch() && window.innerHeight <= SHORT_TOUCH_PX;
  let tasksCollapsed = tasksCollapsedPref ?? (core.isNarrow() || shortTouch());
  let flash: { stationId: string; at: number } | null = null;
  let gchatOpen = false;
  let gchat: ChatPanel | null = null;
  const track = { kill: { readyAt: -1, total: 1 }, sab: { readyAt: -1, total: 1 } };

  // ----- Top: bonding curve -----
  const curveLabel = h('span', { class: 'curve-label', text: 'BONDING CURVE' });
  const curvePct = h('span', { class: 'curve-pct', text: '0%' });
  const curveFill = h('span', { class: 'curve-fill' });
  const curveTrack = h(
    'div',
    { class: 'curve-track' },
    curveFill,
    h('span', { class: 'curve-tick', style: 'left:25%' }),
    h('span', { class: 'curve-tick', style: 'left:50%' }),
    h('span', { class: 'curve-tick', style: 'left:75%' }),
  );
  const curve = h(
    'div',
    { class: 'curve', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Bonding curve' } },
    h('div', { class: 'curve-head' }, curveLabel, curvePct),
    curveTrack,
    h('span', { class: 'curve-flag', text: 'GRAD' }),
  );
  const roomChip = h('div', { class: 'hud-room' });
  const banner = h('div', { class: 'hud-banner', attrs: { role: 'alert' } });
  banner.hidden = true;
  const top = h('div', { class: 'hud-top' }, curve, roomChip, banner);

  // ----- Left: tasks -----
  const roleChip = h('span', { class: 'role-chip' });
  const taskCount = h('span', { class: 'hud-tasks-count' });
  const tasksHead = h(
    'button',
    { class: 'hud-tasks-head', type: 'button', attrs: { 'aria-expanded': 'true' } },
    roleChip,
    h('span', { class: 'hud-tasks-title', text: 'TASKS' }),
    taskCount,
    h('span', { class: 'hud-tasks-caret' }, icon('arrowRight')),
  );
  tasksHead.dataset.nosfx = '1';
  const tasksNote = h('div', { class: 'hud-tasks-note' });
  const taskList = h('ol', { class: 'hud-task-list' });
  const tasksPanel = h('div', { class: 'hud-tasks panel panel--glass' }, tasksHead, tasksNote, taskList);
  tasksHead.addEventListener('click', () => {
    tasksCollapsed = !tasksCollapsed;
    tasksCollapsedPref = tasksCollapsed;
    applyCollapsed();
  });
  function applyCollapsed(): void {
    toggleClass(tasksPanel, 'is-collapsed', tasksCollapsed);
    tasksHead.setAttribute('aria-expanded', String(!tasksCollapsed));
  }
  applyCollapsed();

  // ----- Ghost chat -----
  const gchatBadge = h('span', { class: 'badge-count' });
  gchatBadge.hidden = true;
  const gchatBtn = h('button', { class: 'btn btn--sm btn--ghostchat hud-gchat-btn', type: 'button' }, icon('ghost'), h('span', { class: 'btn-label', text: 'GHOST CHAT' }), gchatBadge);
  const gchatPanel = h('div', { class: 'hud-gchat panel panel--glass' });
  gchatPanel.hidden = true;
  gchatBtn.hidden = true;
  gchatBtn.addEventListener('click', () => setGchat(!gchatOpen));
  const gchatWrap = h('div', { class: 'hud-gchat-wrap' }, gchatBtn, gchatPanel);

  function setGchat(open: boolean): void {
    gchatOpen = open && !!gchat;
    // No room for both on a landscape phone: fold the task list (without changing the saved preference).
    if (gchatOpen && shortTouch() && !tasksCollapsed) {
      tasksCollapsed = true;
      applyCollapsed();
    }
    setHidden(gchatPanel, !gchatOpen);
    toggleClass(gchatBtn, 'is-on', gchatOpen);
    toggleClass(el, 'is-gchat', gchatOpen);
    if (gchatOpen && gchat) {
      gchat.markRead();
      if (!core.isTouch()) gchat.focus();
    }
  }

  // ----- Bridge links -----
  const ventBar = h('div', { class: 'hud-vent' });
  ventBar.hidden = true;

  // ----- Actions -----
  function actBtn(kind: string, label: string, ic: IconName, key: string, withRing: boolean, onPress: () => void): ActBtn {
    const el = h('button', { class: `act act--${kind}`, type: 'button', attrs: { 'aria-label': label } });
    el.dataset.nosfx = '1';
    let ring: SVGCircleElement | null = null;
    if (withRing) {
      const r = ringSvg();
      ring = r.fg;
      el.append(r.svg);
    }
    const ico = h('span', { class: 'act-ico' }, icon(ic));
    const lab = h('span', { class: 'act-label', text: label });
    const cd = h('span', { class: 'act-cd' });
    const badge = h('span', { class: 'act-badge' });
    badge.hidden = true;
    el.append(ico, lab, cd, badge, h('kbd', { class: 'kbd act-key', text: key }));
    // pointerdown so a second finger works while the joystick is held; click covers keyboard activation.
    let firedAt = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (el.disabled) return;
      e.preventDefault();
      firedAt = performance.now();
      el.classList.remove('is-press');
      void el.offsetWidth;
      el.classList.add('is-press');
      safe(onPress);
    });
    el.addEventListener('click', () => {
      if (el.disabled || performance.now() - firedAt < 600) return;
      safe(onPress);
    });
    return { el, ico, label: lab, cd, badge, ring };
  }

  const useBtn = actBtn('use', 'USE', 'hand', 'E', false, () => ctx.game.use());
  const reportBtn = actBtn('report', 'REPORT', 'megaphone', 'R', false, () => ctx.game.report());
  const rugBtn = actBtn('rug', 'RUG', 'rug', 'Q', true, () => ctx.game.kill());
  const sabBtn = actBtn('sab', 'SABOTAGE', 'bolt', 'F', true, () => toggleSabMenu());
  const ventBtn = actBtn('vent', 'BRIDGE', 'bridge', 'V', false, () => ctx.game.ventToggle());

  const sabOpts = new Map<SabotageKind, HTMLButtonElement>();
  const sabMenu = h('div', { class: 'sab-menu panel', attrs: { role: 'menu' } }, h('div', { class: 'sab-menu-title', text: 'SABOTAGE' }));
  SAB_KINDS.forEach((k, i) => {
    const b = h(
      'button',
      { class: `sab-opt sab-opt--${k}`, type: 'button', attrs: { role: 'menuitem' } },
      h('span', { class: 'sab-opt-ico' }, icon(SAB_ICON[k])),
      h('span', { class: 'sab-opt-txt' }, h('span', { class: 'sab-opt-name', text: SABOTAGE_TITLES[k] }), h('span', { class: 'sab-opt-sub', text: SAB_SUB[k] })),
      h('kbd', { class: 'kbd', text: String(i + 1) }),
    );
    b.addEventListener('click', () => chooseSab(k));
    sabOpts.set(k, b);
    sabMenu.append(b);
  });
  sabMenu.hidden = true;

  const actions = h(
    'div',
    { class: 'hud-actions' },
    sabMenu,
    h('div', { class: 'hud-actions-row hud-actions-row--top' }, sabBtn.el, ventBtn.el),
    h('div', { class: 'hud-actions-row' }, rugBtn.el, reportBtn.el, useBtn.el),
  );

  const joystick = createJoystick(core);

  // Joystick first so the action buttons stack above its touch zone.
  const el = h(
    'div',
    { class: 'screen hud' },
    joystick.el,
    h('div', { class: 'hud-head' }, h('div', { class: 'hud-left' }, tasksPanel, gchatWrap), top),
    ventBar,
    actions,
  );

  const onDocDown = (e: PointerEvent) => {
    if (!sabMenuOpen) return;
    const t = e.target as Node;
    if (sabMenu.contains(t) || sabBtn.el.contains(t)) return;
    setSabMenu(false);
  };
  document.addEventListener('pointerdown', onDocDown, true);

  function safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('[ui] game action failed', err);
    }
  }

  function setSabMenu(open: boolean): void {
    sabMenuOpen = open;
    setHidden(sabMenu, !open);
    toggleClass(sabBtn.el, 'is-on', open);
    if (open) loop(performance.now(), true);
  }

  function sabReady(): boolean {
    if (!snap || !me || me.role !== 'rugger' || snap.sabotage) return false;
    return (me.sabotageReadyAt ?? 0) <= ctx.net.serverNow();
  }

  function toggleSabMenu(): void {
    if (!me || me.role !== 'rugger') return;
    if (sabMenuOpen) {
      setSabMenu(false);
      return;
    }
    if (!sabReady()) {
      core.toast(snap?.sabotage ? 'A sabotage is already running.' : 'Sabotage is on cooldown.', 'info');
      return;
    }
    setSabMenu(true);
  }

  function chooseSab(kind: SabotageKind): void {
    if (!sabReady()) {
      setSabMenu(false);
      return;
    }
    safe(() => ctx.game.sabotage(kind));
    setSabMenu(false);
  }

  // ----- Snapshot-driven parts -----

  function renderCurve(): void {
    if (!snap) return;
    const p = snap.taskProgress;
    const rpc = p < 0;
    toggleClass(curve, 'is-rpc', rpc);
    if (rpc) {
      setText(curveLabel, 'RPC DOWN');
      setText(curvePct, '??%');
      curveFill.style.width = '100%';
      curve.setAttribute('aria-valuetext', 'RPC DOWN');
    } else {
      const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
      setText(curveLabel, 'BONDING CURVE');
      setText(curvePct, `${pct}%`);
      curveFill.style.width = `${pct}%`;
      curve.setAttribute('aria-valuenow', String(pct));
      curve.removeAttribute('aria-valuetext');
      toggleClass(curve, 'is-hot', pct >= 80);
    }
  }

  function renderTasks(): void {
    if (!snap || !me) return;
    const hidden = snap.taskProgress === -1 && me.role === 'holder';
    const sig = [me.role, me.alive, hidden, ...me.tasks.map((t) => `${t.stationId}:${t.done ? 1 : 0}`)].join('|');
    if (sig === tasksSig) return;
    tasksSig = sig;
    const rugger = me.role === 'rugger';
    roleChip.className = `role-chip role-chip--${!me.alive ? 'ghost' : rugger ? 'rugger' : 'holder'}`;
    roleChip.textContent = !me.alive ? (rugger ? 'RUGGER · GHOST' : 'GHOST') : rugger ? 'RUGGER' : 'HOLDER';
    const done = me.tasks.filter((t) => t.done).length;
    setText(taskCount, rugger ? 'FAKE' : hidden ? '--' : `${done}/${me.tasks.length}`);
    let note = '';
    if (rugger) note = me.alive ? 'Fake tasks: blend in' : "You're out, but you can still sabotage.";
    else if (hidden) note = 'RPC DOWN: task list offline. Reboot it at RPC NODE.';
    else if (!me.alive) note = 'You got rugged. Finish your tasks as a ghost.';
    setText(tasksNote, note);
    setHidden(tasksNote, !note);
    toggleClass(tasksNote, 'is-bad', hidden);
    toggleClass(tasksPanel, 'is-rugger', rugger);
    clear(taskList);
    setHidden(taskList, hidden);
    if (hidden) return;
    for (const t of me.tasks) {
      const st = stationById(t.stationId);
      const flashing = !!flash && flash.stationId === t.stationId && performance.now() - flash.at < 900;
      const li = h(
        'li',
        { class: `hud-task${t.done ? ' is-done' : ''}${flashing ? ' is-flash' : ''}`, dataset: { station: t.stationId } },
        h('span', { class: 'ht-room', text: st ? roomName(st.room) : '?' }),
        h('span', { class: 'ht-name', text: TASK_TITLES[t.kind] ?? t.kind }),
      );
      taskList.append(li);
    }
  }

  function renderBannerStructure(): void {
    const s = snap?.sabotage ?? null;
    const rugger = me?.role === 'rugger';
    const key = s ? `${s.kind}|${rugger}` : '';
    if (key === bannerKey) return;
    bannerKey = key;
    clear(banner);
    banner.className = 'hud-banner';
    if (!s) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.classList.add(`hud-banner--${s.kind}`);
    const where = (id: string) => roomName(SABOTAGE_STATIONS.find((x) => x.id === id)?.room ?? '');
    if (s.kind === 'devDump') {
      const chips = h('div', { class: 'hb-stations' });
      for (const st of s.stations) {
        chips.append(h('span', { class: 'hb-st', dataset: { station: st.id } }, h('span', { class: 'hb-st-name', text: where(st.id) }), h('span', { class: 'hb-st-n', text: '0' })));
      }
      banner.append(
        h('div', { class: 'hb-row' }, icon('warning'), h('span', { class: 'hb-title', text: 'DEV DUMP' }), h('span', { class: 'hb-timer', text: '0:40' })),
        h('div', { class: 'hb-detail', text: rugger ? 'Keep them off both BUY WALLs:' : 'Hold both BUY WALLs at the same time:' }),
        chips,
      );
    } else {
      const station = s.stations[0]?.id ?? '';
      const text =
        s.kind === 'fud'
          ? rugger
            ? 'FUD is live. Holders are half-blind.'
            : `Vision down. Flip the switches in ${where(station)}.`
          : rugger
            ? "RPC DOWN is live. Holders can't see tasks."
            : `Tasks and curve offline. Reboot at ${where(station)}.`;
      banner.append(h('div', { class: 'hb-row' }, icon(s.kind === 'fud' ? 'ghost' : 'globe'), h('span', { class: 'hb-title', text: SABOTAGE_TITLES[s.kind] }), h('span', { class: 'hb-text', text })));
    }
  }

  function renderBannerLive(): void {
    const s = snap?.sabotage;
    if (!s || s.kind !== 'devDump') return;
    const timer = banner.querySelector('.hb-timer');
    if (timer && s.endsAt !== undefined) {
      const remain = s.endsAt - ctx.net.serverNow();
      setText(timer, clock(remain));
      toggleClass(banner, 'is-critical', remain < 10_000);
    }
    for (const st of s.stations) {
      const chip = banner.querySelector<HTMLElement>(`.hb-st[data-station="${st.id}"]`);
      if (!chip) continue;
      const n = st.holders ?? 0;
      setText(chip.querySelector('.hb-st-n')!, String(n));
      toggleClass(chip, 'is-held', n > 0);
    }
  }

  function renderVent(): void {
    const vid = me?.ventId ?? null;
    const key = vid ?? '';
    if (key === ventKey) return;
    ventKey = key;
    clear(ventBar);
    const vent = vid ? ventById(vid) : undefined;
    setHidden(ventBar, !vent);
    toggleClass(el, 'is-vented', !!vent);
    if (!vent) return;
    ventBar.append(h('div', { class: 'hud-vent-k' }, icon('bridge'), h('span', { text: `IN BRIDGE · ${roomName(vent.room)}` })));
    const row = h('div', { class: 'hud-vent-links' });
    for (const id of vent.links) {
      const to = ventById(id);
      if (!to) continue;
      const b = h('button', { class: 'btn btn--sm btn--purple vent-link', type: 'button' }, h('span', { class: 'btn-label', text: roomName(to.room) }), icon('arrowRight'));
      b.addEventListener('click', () => safe(() => ctx.game.ventMove(id)));
      row.append(b);
    }
    ventBar.append(row);
  }

  function renderRoles(): void {
    if (!me) return;
    const rugger = me.role === 'rugger';
    setHidden(reportBtn.el, !me.alive);
    setHidden(rugBtn.el, !(rugger && me.alive));
    setHidden(ventBtn.el, !(rugger && me.alive));
    setHidden(sabBtn.el, !rugger);
    toggleClass(el, 'is-rugger', rugger);
    toggleClass(el, 'is-ghost', !me.alive);
    if (!rugger && sabMenuOpen) setSabMenu(false);

    const dead = !me.alive;
    setHidden(gchatBtn, !dead);
    if (!dead && gchatOpen) setGchat(false);
    if (dead && !gchat) {
      gchat = createChat(core, {
        channels: ['ghost'],
        placeholder: 'Ghost chat (only ghosts see this)…',
        emptyText: 'Only ghosts can read this. Spill the tea.',
        isVisible: () => gchatOpen,
        since: () => core.gameStartedAt(),
        onUnread: (n) => {
          setHidden(gchatBadge, n === 0);
          setText(gchatBadge, String(n));
        },
      });
      gchatPanel.append(gchat.el);
    }
  }

  // ----- Loop: interactions, cooldowns, timers -----

  function cooldown(readyAt: number | undefined, t: { readyAt: number; total: number }, now: number): { remain: number; frac: number } {
    if (readyAt === undefined) return { remain: 0, frac: 0 };
    if (readyAt !== t.readyAt) {
      t.readyAt = readyAt;
      t.total = Math.max(1000, readyAt - now);
    }
    const remain = Math.max(0, readyAt - now);
    return { remain, frac: remain > 0 ? Math.min(1, remain / t.total) : 0 };
  }

  function setRing(b: ActBtn, remain: number, frac: number): void {
    if (b.ring) b.ring.style.strokeDashoffset = String(RING_C * (1 - frac));
    setText(b.cd, remain > 0 ? String(Math.ceil(remain / 1000)) : '');
    toggleClass(b.el, 'is-cooling', remain > 0);
  }

  function useInfo(u: UseTarget | null): { key: string; label: string; ic: IconName; title: string } {
    if (!u) return { key: 'none', label: 'USE', ic: 'hand', title: 'Nothing to use here' };
    switch (u.type) {
      case 'task':
        return { key: `task:${u.kind}`, label: 'TASK', ic: 'task', title: TASK_TITLES[u.kind] ?? 'Task' };
      case 'fix':
        return { key: 'fix', label: 'FIX', ic: 'wrench', title: 'Fix the sabotage' };
      case 'emergency':
        return { key: 'emergency', label: 'SPACES', ic: 'mic', title: 'Start an X Space (emergency meeting)' };
      case 'vent':
        return { key: 'vent', label: 'BRIDGE', ic: 'bridge', title: 'Enter the bridge' };
    }
  }

  function loop(t: number, force = false): void {
    if (destroyed) return;
    if (!force) raf = requestAnimationFrame(loop);
    if (!force && t - lastLoop < LOOP_MS) return;
    lastLoop = t;
    if (!snap || !me) return;
    let it: ReturnType<typeof ctx.game.getInteractions> | null = null;
    try {
      it = ctx.game.getInteractions();
    } catch {
      it = null;
    }
    const now = ctx.net.serverNow();
    const vented = !!me.ventId;

    // USE
    const u = useInfo(it?.use ?? null);
    if (u.key !== lastUseKey) {
      lastUseKey = u.key;
      clear(useBtn.ico);
      useBtn.ico.append(icon(u.ic));
      setText(useBtn.label, u.label);
      useBtn.el.dataset.target = u.key.split(':')[0];
    }
    useBtn.el.title = u.title;
    const useOn = !!it?.use;
    setDisabled(useBtn.el, !useOn);
    toggleClass(useBtn.el, 'is-ready', useOn);
    const showLeft = it?.use?.type === 'emergency';
    setHidden(useBtn.badge, !showLeft);
    if (showLeft) setText(useBtn.badge, String(me.emergencyLeft));

    // REPORT
    const repOn = me.alive && !!it?.reportBodyId;
    setDisabled(reportBtn.el, !repOn);
    toggleClass(reportBtn.el, 'is-ready', repOn);

    if (me.role === 'rugger') {
      // RUG
      const k = cooldown(me.killReadyAt, track.kill, now);
      setRing(rugBtn, k.remain, k.frac);
      const rugOn = me.alive && !vented && k.remain <= 0 && !!it?.killTargetId;
      setDisabled(rugBtn.el, !rugOn);
      toggleClass(rugBtn.el, 'is-ready', rugOn);
      // SABOTAGE
      const sc = cooldown(me.sabotageReadyAt, track.sab, now);
      const active = !!snap.sabotage;
      setRing(sabBtn, active ? 0 : sc.remain, active ? 0 : sc.frac);
      const sabOn = !active && sc.remain <= 0;
      setDisabled(sabBtn.el, !sabOn);
      toggleClass(sabBtn.el, 'is-ready', sabOn);
      setText(sabBtn.label, active ? 'ACTIVE' : 'SABOTAGE');
      if (sabMenuOpen && !sabOn) setSabMenu(false);
      for (const b of sabOpts.values()) setDisabled(b, !sabOn);
      // BRIDGE
      const ventOn = me.alive && !!it?.ventId;
      setDisabled(ventBtn.el, !ventOn);
      toggleClass(ventBtn.el, 'is-ready', ventOn);
      setText(ventBtn.label, vented ? 'EXIT' : 'BRIDGE');
    }

    renderBannerLive();

    // Current room.
    let pos: { x: number; y: number } | null = null;
    try {
      pos = ctx.game.getSelfPosition();
    } catch {
      pos = null;
    }
    const room = pos ? roomAt(pos.x, pos.y) : null;
    setText(roomChip, room ? room.name : '');
    setHidden(roomChip, !room);
    if (room) roomChip.style.setProperty('--accent', room.accent);
  }

  function update(next: Snapshot | null): void {
    if (!next || !next.me) return;
    snap = next;
    me = next.me;
    renderRoles();
    renderCurve();
    renderTasks();
    renderBannerStructure();
    renderVent();
  }

  raf = requestAnimationFrame(loop);

  return {
    el,
    update,
    flashTask(stationId) {
      // The snapshot marking it done usually lands right after this event and rebuilds the list.
      flash = { stationId, at: performance.now() };
      const li = taskList.querySelector<HTMLElement>(`.hud-task[data-station="${stationId}"]`);
      if (li) {
        li.classList.remove('is-flash');
        void li.offsetWidth;
        li.classList.add('is-flash');
      }
      curve.classList.remove('is-pump');
      void curve.offsetWidth;
      curve.classList.add('is-pump');
    },
    onKey(e) {
      const k = e.key.toLowerCase();
      if (k === 'f' && me?.role === 'rugger') {
        toggleSabMenu();
        return true;
      }
      if (sabMenuOpen && (k === '1' || k === '2' || k === '3')) {
        chooseSab(SAB_KINDS[Number(k) - 1]);
        return true;
      }
      if (k === 'enter' && gchat && !me?.alive) {
        setGchat(true);
        gchat.focus();
        return true;
      }
      return false;
    },
    onEscape() {
      if (sabMenuOpen) {
        setSabMenu(false);
        return true;
      }
      if (gchatOpen) {
        setGchat(false);
        return true;
      }
      return false;
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onDocDown, true);
      joystick.destroy();
      gchat?.destroy();
    },
  };
}
