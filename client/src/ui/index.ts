// UI entry: createUi(root, ctx) builds the DOM layers, routes between screens from store.snap.phase,
// hosts minigames, toasts, modals, the full map and every event-driven sound.

import { SABOTAGE_TITLES } from '../../../shared/map';
import type { ErrorCode, GameEvent, Phase, SabotageKind, Snapshot } from '../../../shared/protocol';
import type { AppContext, MinigameTarget, SoundName, UiApi } from '../context';
import type { ModalOpts, RosterEntry, Screen, Tone, UiCore } from './core';
import { createMeeting } from './meeting';
import { createEjection } from './ejection';
import { createGameOver } from './gameOver';
import { createHome } from './home';
import { createHud, type Hud } from './hud';
import { createLobby } from './lobby';
import { createRoleReveal } from './roleReveal';
import { copyText, detectTouch, h, icon, isTextInput } from './dom';
import { dismissRuggedCutscene, showRuggedCutscene } from './cutscene';
import { createFullMap } from './fullMap';
import { createMinigameHost } from './minigame';
import { createModalLayer, openHowTo, openLeaderboard, openManualCopy, openRename } from './modals';
import { createToasts } from './toasts';

type ViewKey = 'home' | Phase;

const NARROW_PX = 720;

const ERROR_TEXT: Record<ErrorCode, string> = {
  ROOM_NOT_FOUND: 'No room with that code. Check it and try again.',
  ROOM_FULL: 'That room is full.',
  GAME_IN_PROGRESS: 'That game already started. Try another room.',
  NOT_HOST: 'Only the host can do that.',
  NOT_ENOUGH_PLAYERS: 'Need at least 4 players to start. Add bots?',
  BAD_REQUEST: 'Something went wrong. Try again.',
  RATE_LIMITED: 'Slow down a sec.',
  REJOIN_FAILED: "Couldn't restore your last game.",
  INVALID_ACTION: "Can't do that right now.",
};

const SAB_START_HOLDER: Record<SabotageKind, string> = {
  devDump: 'DEV DUMP! Hold both BUY WALLs before the timer ends.',
  fud: 'FUD is spreading. Fix it in TELEGRAM HQ.',
  rpcDown: 'RPC DOWN. Reboot it at the RPC NODE.',
};
const SAB_FIXED: Record<SabotageKind, string> = {
  devDump: 'DEV DUMP stopped. The buy walls held.',
  fud: 'FUD cleared. Vision is back.',
  rpcDown: 'RPC is back online.',
};

export function friendlyError(code: ErrorCode, message: string): string {
  // Server messages for game actions are already short and human; prefer them there.
  if ((code === 'INVALID_ACTION' || code === 'ROOM_FULL') && message && message.length <= 80) return message.endsWith('.') ? message : `${message}.`;
  return ERROR_TEXT[code] ?? (message || 'Something went wrong.');
}

export function createUi(root: HTMLElement, ctx: AppContext): UiApi {
  const { store } = ctx;
  root.classList.add('ui-root');
  root.textContent = '';

  // ----- Layers (bottom to top) -----
  const screenLayer = h('div', { class: 'ui-layer ui-screens' });
  const cornerLayer = h('div', { class: 'ui-corner' });
  const statusChip = h('div', { class: 'ui-status', attrs: { role: 'status' } }, h('span', { class: 'spinner' }), h('span', { text: 'RECONNECTING…' }));
  statusChip.hidden = true;
  const overlayLayer = h('div', { class: 'ui-layer ui-overlays' });
  const cutLayer = h('div', { class: 'ui-layer ui-cut' });
  const modalLayer = h('div', { class: 'ui-layer ui-modals' });
  const toastLayer = h('div', { class: 'ui-toasts', attrs: { 'aria-live': 'polite' } });
  root.append(screenLayer, cornerLayer, statusChip, overlayLayer, cutLayer, modalLayer, toastLayer);

  const toasts = createToasts(toastLayer);

  // ----- Input blocking (reference counted) -----
  const blockers = new Set<string>();
  function setBlocker(key: string, on: boolean): void {
    const before = blockers.size > 0;
    if (on) blockers.add(key);
    else blockers.delete(key);
    const after = blockers.size > 0;
    if (before !== after) {
      try {
        ctx.game.setInputBlocked(after);
      } catch (err) {
        console.error('[ui] setInputBlocked failed', err);
      }
    }
  }
  const syncTextBlock = () => {
    const a = document.activeElement;
    setBlocker('text', !!a && root.contains(a) && isTextInput(a));
  };
  root.addEventListener('focusin', syncTextBlock);
  root.addEventListener('focusout', () => window.setTimeout(syncTextBlock, 0));

  // ----- Touch / layout detection -----
  let touch = detectTouch();
  root.classList.toggle('is-touch', touch);
  window.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.pointerType === 'touch' || e.pointerType === 'pen' ? true : e.pointerType === 'mouse' ? false : touch;
      if (t !== touch) {
        touch = t;
        root.classList.toggle('is-touch', touch);
      }
    },
    { capture: true, passive: true },
  );

  // ----- Roster: names/colors of everyone seen in this room -----
  const roster = new Map<string, RosterEntry>();
  let rosterCode: string | null = null;
  function updateRoster(snap: Snapshot): void {
    if (snap.room.code !== rosterCode) {
      roster.clear();
      rosterCode = snap.room.code;
    }
    for (const p of snap.players) roster.set(p.id, { name: p.name, color: p.color, isBot: p.isBot });
  }

  // ----- Sound -----
  function sound(name: SoundName): void {
    try {
      ctx.audio.play(name);
    } catch {
      /* audio not ready / locked */
    }
  }

  // ----- Core shared with screens -----
  let modals: ReturnType<typeof createModalLayer>;
  let leftRoom: { code: string; at: number } | null = null;
  let lastAlarm = 0;
  let gameStartedAt = 0;

  const core: UiCore = {
    ctx,
    root,
    toast: (text: string, tone: Tone = 'info') => toasts.show(text, tone),
    sound,
    setBlocker,
    myId: () => store.snap?.me?.id ?? store.playerId,
    who: (id) => roster.get(id) ?? null,
    isTouch: () => touch,
    isNarrow: () => window.innerWidth < NARROW_PX,
    gameStartedAt: () => gameStartedAt,
    leaveRoom,
    openModal: (opts: ModalOpts) => modals.open(opts),
    openLeaderboard: () => openLeaderboard(core),
    openHowTo: () => openHowTo(core),
    openRename: () => openRename(core),
    toggleMap: (force?: boolean) => fullMap.toggle(force),
    isMapOpen: () => fullMap.isOpen(),
    copy(text, what) {
      void copyText(text).then((ok) => {
        if (ok) toasts.show(`${what[0].toUpperCase()}${what.slice(1)} copied`, 'good');
        else openManualCopy(core, text, what);
      });
    },
  };

  modals = createModalLayer(modalLayer, (on) => setBlocker('modal', on));
  const minigame = createMinigameHost(core, overlayLayer);
  const fullMap = createFullMap(core, overlayLayer);

  // ----- Corner buttons: map (in game) + mute -----
  const mapBtn = h('button', { class: 'corner-btn', type: 'button', title: 'Map (M)', attrs: { 'aria-label': 'Map' } }, icon('map'), h('kbd', { class: 'kbd', text: 'M' }));
  mapBtn.addEventListener('click', () => fullMap.toggle());
  const muteBtn = h('button', { class: 'corner-btn', type: 'button', attrs: { 'aria-label': 'Mute' } });
  const renderMute = () => {
    let muted = false;
    try {
      muted = ctx.audio.isMuted();
    } catch {
      muted = false;
    }
    muteBtn.textContent = '';
    muteBtn.append(icon(muted ? 'soundOff' : 'soundOn'));
    muteBtn.title = muted ? 'Unmute' : 'Mute';
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.classList.toggle('is-off', muted);
  };
  muteBtn.addEventListener('click', () => {
    try {
      const next = !ctx.audio.isMuted();
      ctx.audio.setMuted(next); // audio.ts persists the preference
      if (!next) sound('click');
    } catch {
      /* audio unavailable */
    }
    renderMute();
  });
  muteBtn.dataset.nosfx = '1';
  renderMute();
  mapBtn.hidden = true;
  cornerLayer.append(mapBtn, muteBtn);

  // ----- Router -----
  let view: ViewKey | null = null;
  let screen: Screen | null = null;

  function makeScreen(key: ViewKey): Screen {
    switch (key) {
      case 'home':
        return createHome(core);
      case 'lobby':
        return createLobby(core);
      case 'roleReveal':
        return createRoleReveal(core);
      case 'playing':
        return createHud(core);
      case 'meeting':
        return createMeeting(core);
      case 'ejection':
        return createEjection(core);
      case 'gameOver':
        return createGameOver(core);
    }
  }

  function route(): void {
    const snap = store.snap;
    const key: ViewKey = snap ? snap.phase : 'home';
    if (key !== view) {
      if (screen) {
        try {
          screen.destroy();
        } catch (err) {
          console.error('[ui] screen destroy failed', err);
        }
        screen.el.remove();
      }
      view = key;
      root.dataset.view = key;
      try {
        screen = makeScreen(key);
      } catch (err) {
        console.error(`[ui] failed to build ${key}`, err);
        screen = { el: h('div', { class: 'screen' }), update() {}, destroy() {} };
      }
      screenLayer.append(screen.el);
      mapBtn.hidden = key !== 'playing';
      if (key !== 'playing') fullMap.close();
      if (key !== 'lobby' && key !== 'home') modals.closeTop();
      // A focused input may have been removed with the old screen.
      syncTextBlock();
    }
    try {
      screen?.update(snap);
    } catch (err) {
      console.error(`[ui] ${key} update failed`, err);
    }
  }

  function leaveRoom(): void {
    const code = store.snap?.room.code ?? store.roomCode;
    ctx.net.leave();
    if (code) leftRoom = { code, at: Date.now() };
    store.reset();
    minigame.onSnapshot(null);
    route();
  }

  // ----- Store subscriptions -----
  ctx.net.on((m) => {
    if (m.t === 'welcome') leftRoom = null;
  });

  store.onSnapshot((snap) => {
    // Snapshots already in flight when we left must not pull us back into the room.
    if (leftRoom && snap.room.code === leftRoom.code && Date.now() - leftRoom.at < 5000) {
      store.reset();
      route();
      return;
    }
    leftRoom = null;
    updateRoster(snap);
    if (location.search.includes('room=')) {
      try {
        history.replaceState(null, '', location.pathname + location.hash);
      } catch {
        /* sandboxed */
      }
    }
    route();
    minigame.onSnapshot(snap);
  });

  store.onPhase(({ from, to }) => {
    const snap = store.snap;
    if (to === 'roleReveal' && snap) gameStartedAt = snap.now - 1000;
    else if (to === 'lobby' || from === null) gameStartedAt = 0;
    if (from !== null && snap) {
      if (to === 'roleReveal') sound('reveal');
      else if (to === 'ejection') sound('eject');
      else if (to === 'gameOver' && snap.gameOver) {
        const role = (snap.me && snap.gameOver.roles[snap.me.id]) || snap.me?.role;
        const won = role ? (snap.gameOver.winner === 'holders' ? role === 'holder' : role === 'rugger') : false;
        sound(won ? 'win' : 'lose');
      }
    }
    // The victim's cutscene belongs to the round; never let it cover a meeting or the game-over screen.
    if (to !== 'playing') dismissRuggedCutscene(cutLayer);
    if (!snap) minigame.onSnapshot(null);
    route();
  });

  store.onEvent((ev: GameEvent) => onEvent(ev));

  function nameOf(id: string): string {
    return store.snap?.players.find((p) => p.id === id)?.name ?? roster.get(id)?.name ?? 'Someone';
  }

  function onEvent(ev: GameEvent): void {
    const me = core.myId();
    const snap = store.snap;
    const rugger = snap?.me?.role === 'rugger';
    switch (ev.kind) {
      case 'rugged': {
        if (ev.victimId === me) {
          const k = roster.get(ev.killerId) ?? null;
          const killerView = snap?.players.find((p) => p.id === ev.killerId);
          const killer = killerView ? { name: killerView.name, color: killerView.color } : k ? { name: k.name, color: k.color } : null;
          const victimColor = snap?.players.find((p) => p.id === me)?.color ?? roster.get(ev.victimId)?.color ?? 0;
          minigame.onSnapshot(snap);
          if (minigame.isOpen()) minigame.close();
          // A game-ending (or meeting-interrupted) kill: the round is already over, so skip "finish your tasks".
          if (snap?.phase === 'playing') showRuggedCutscene(cutLayer, killer, victimColor);
          sound('kill');
        } else if (ev.killerId === me) {
          sound('kill');
          toasts.show(`You rugged ${nameOf(ev.victimId)}.`, 'good');
        } else {
          toasts.show(`${nameOf(ev.killerId)} rugged ${nameOf(ev.victimId)}.`, 'info');
        }
        break;
      }
      case 'bodyReported':
      case 'emergencyCalled':
        sound('meeting');
        break;
      case 'sabotageStarted':
        sound('sabotage');
        if (rugger) toasts.show(`${SABOTAGE_TITLES[ev.sabotage]} is live.`, 'good');
        else toasts.show(SAB_START_HOLDER[ev.sabotage], 'bad');
        lastAlarm = 0;
        break;
      case 'sabotageFixed':
        sound('taskDone');
        toasts.show(SAB_FIXED[ev.sabotage], rugger ? 'info' : 'good');
        break;
      case 'taskCompleted':
        if (view === 'playing' && screen) (screen as Hud).flashTask?.(ev.stationId);
        break;
      case 'votingOpened':
        sound('click');
        break;
      case 'playerLeft':
        if (snap && snap.phase !== 'lobby') toasts.show(`${ev.name} left the game.`, 'info');
        break;
      case 'kicked':
        toasts.show('The host kicked you from the room.', 'bad');
        minigame.onSnapshot(null);
        route();
        break;
      case 'playerJoined':
      case 'gameStarted':
        break;
    }
  }

  store.onError((e) => {
    minigame.onError();
    if (e.code === 'REJOIN_FAILED') {
      toasts.show(e.message === 'Your seat was opened somewhere else' ? 'You opened this game in another tab.' : ERROR_TEXT.REJOIN_FAILED, 'info');
      route();
      return;
    }
    toasts.show(friendlyError(e.code, e.message), 'bad');
    sound('error');
  });

  let wasDisconnected = false;
  store.onStatus((connected) => {
    minigame.onConnection(connected);
    const inRoom = store.inRoom;
    statusChip.hidden = connected || !inRoom;
    if (!connected && inRoom) wasDisconnected = true;
    if (connected && wasDisconnected) {
      wasDisconnected = false;
      toasts.show('Back online.', 'good');
    }
  });

  // ----- DEV DUMP alarm loop -----
  window.setInterval(() => {
    const s = store.snap;
    if (!s || s.phase !== 'playing' || s.sabotage?.kind !== 'devDump') return;
    const remain = (s.sabotage.endsAt ?? 0) - ctx.net.serverNow();
    const every = remain < 10_000 ? 650 : 1300;
    const now = Date.now();
    if (now - lastAlarm >= every) {
      lastAlarm = now;
      sound('alarm');
    }
  }, 150);

  // ----- Keyboard -----
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (modals.closeTop() || minigame.escape()) {
        e.preventDefault();
        return;
      }
      if (fullMap.isOpen()) {
        fullMap.close();
        e.preventDefault();
        return;
      }
      if (screen?.onEscape?.()) e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (isTextInput(e.target) || modals.isOpen() || minigame.isOpen()) return;
    if (view === 'playing' && (e.key === 'm' || e.key === 'M')) {
      fullMap.toggle();
      e.preventDefault();
      return;
    }
    try {
      if (screen?.onKey?.(e)) e.preventDefault();
    } catch (err) {
      console.error('[ui] key handler failed', err);
    }
  });

  // ----- Click sound for every button -----
  root.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.('button, a.link-btn') as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled || b.dataset.nosfx) return;
    sound('click');
  });

  // Prevent page pinch/double-tap zoom gestures from leaking out of the UI on iOS.
  root.addEventListener('gesturestart', (e) => e.preventDefault());

  route();

  return {
    openMinigame(target: MinigameTarget) {
      try {
        minigame.open(target);
      } catch (err) {
        console.error('[ui] openMinigame failed', err);
      }
    },
    closeMinigame() {
      minigame.close();
    },
    isMinigameOpen() {
      return minigame.isOpen();
    },
    toast(text: string, tone: Tone = 'info') {
      toasts.show(text, tone);
    },
  };
}
