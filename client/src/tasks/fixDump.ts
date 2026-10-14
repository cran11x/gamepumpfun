// fixDump: the BUY WALL hold pad for the DEV DUMP critical sabotage. Pressing the pad sends
// holdStart, letting go (pointerup / cancel / leave, blur, tab hidden, cleanup) sends holdEnd.
// Every 100 ms it reads the snapshot to show both walls' status, the dump countdown and FIXED
// once the sabotage is gone. It never calls complete(): the UI closes it when the dump is fixed.

import { ROOMS, SABOTAGE_STATIONS } from '../../../shared/map';
import type { Snapshot } from '../../../shared/protocol';
import { button, buzz, el, isSpaceKey, isTypingTarget, restartClass, type MinigameCtx, type MinigameDef } from './kit';

const POLL_MS = 100;
const URGENT_MS = 10_000;

type Mode = 'live' | 'fixed' | 'standby';

interface WallCard {
  id: string;
  root: HTMLElement;
  state: HTMLElement;
}

function roomLabel(stationId: string): string {
  const st = SABOTAGE_STATIONS.find((s) => s.id === stationId);
  const room = st ? ROOMS.find((r) => r.id === st.room) : undefined;
  return room?.name ?? stationId.toUpperCase();
}

function fmtCountdown(ms: number): string {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const d = Math.floor((t % 1000) / 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
}

export const fixDump: MinigameDef = {
  hint: 'Hold the BUY WALL. Both walls must be held at the same time.',
  mount(ctx: MinigameCtx) {
    const { scope, stage, host, target } = ctx;
    const mine = target.stationId;
    const ids = SABOTAGE_STATIONS.filter((s) => s.sabotage === 'devDump').map((s) => s.id);
    if (!ids.includes(mine)) ids.unshift(mine);
    const otherId = ids.find((id) => id !== mine) ?? null;
    const otherName = otherId ? roomLabel(otherId) : 'the other wall';

    const wrap = el('div', 'tk-dump');

    const timer = el('div', 'tk-dump-timer');
    const timerLabel = el('span', 'tk-dump-timer-label', 'DEV DUMPING IN');
    const timerValue = el('span', 'tk-dump-timer-value', '--:--.-');
    timer.append(timerLabel, timerValue);

    const walls = el('div', 'tk-dump-walls');
    const cards: WallCard[] = ids.map((id) => {
      const card = el('div', `tk-dump-wall${id === mine ? ' is-mine' : ''}`);
      const top = el('div', 'tk-dump-wall-top');
      top.append(el('span', 'tk-dump-led'), el('span', 'tk-dump-wall-name', roomLabel(id)));
      if (id === mine) top.append(el('span', 'tk-dump-you', 'YOU'));
      const state = el('div', 'tk-dump-wall-state', 'OPEN');
      card.append(top, state);
      walls.append(card);
      return { id, root: card, state };
    });

    const pad = button('tk-dump-pad');
    pad.setAttribute('aria-label', 'Hold the buy wall');
    const bars = el('span', 'tk-dump-bars');
    for (let i = 0; i < 9; i++) {
      const b = el('span', 'tk-dump-bar');
      b.style.setProperty('--i', String(i));
      bars.append(b);
    }
    const padText = el('span', 'tk-dump-pad-text');
    const padMain = el('span', 'tk-dump-pad-main', 'HOLD');
    const padSub = el('span', 'tk-dump-pad-sub', 'BUY WALL');
    padText.append(padMain, padSub);
    pad.append(el('span', 'tk-dump-ring'), bars, padText);

    const status = el('div', 'tk-dump-status', 'Press and hold the pad.');
    const fixedEl = el('div', 'tk-dump-fixed');
    fixedEl.append(el('span', 'tk-dump-fixed-main', 'FIXED'), el('span', 'tk-dump-fixed-sub', 'The wall held. Chart saved.'));

    wrap.append(timer, walls, pad, status, fixedEl);
    stage.append(wrap);

    let mode: Mode = 'live';
    let holding = false;
    let keyHeld = false;
    const pointers = new Set<number>();

    // Server clock estimate: snapshot time plus local time since we first saw that snapshot.
    let seenNow = -1;
    let seenAt = 0;
    const serverNow = (snap: Snapshot): number => {
      if (snap.now !== seenNow) {
        seenNow = snap.now;
        seenAt = Date.now();
      }
      return seenNow + (Date.now() - seenAt);
    };

    const readSnap = (): Snapshot | null => {
      try {
        return host.getSnapshot();
      } catch {
        return null;
      }
    };

    const sync = (): void => {
      const want = mode === 'live' && (pointers.size > 0 || keyHeld);
      if (want === holding) return;
      holding = want;
      pad.classList.toggle('is-held', holding);
      wrap.classList.toggle('is-holding', holding);
      if (holding) {
        host.holdStart();
        ctx.click();
        buzz(15);
        restartClass(pad, 'is-press');
      } else {
        host.holdEnd();
      }
      refresh();
    };

    const releaseAll = (): void => {
      pointers.clear();
      keyHeld = false;
      sync();
    };

    function refresh(): void {
      const snap = readSnap();
      const sab = snap?.sabotage ?? null;
      const dump = sab && sab.kind === 'devDump' ? sab : null;
      let next: Mode;
      if (!snap) next = 'standby';
      else if (!dump || dump.stations.every((s) => s.fixed)) next = snap.phase === 'gameOver' ? 'standby' : 'fixed';
      else next = snap.phase === 'playing' ? 'live' : 'standby';

      if (next !== mode) {
        mode = next;
        wrap.dataset.mode = mode;
        pad.disabled = mode !== 'live';
        if (mode !== 'live') releaseAll();
        wrap.classList.toggle('is-fixed', mode === 'fixed');
        ctx.setHint(mode === 'fixed' ? 'DEV DUMP stopped. Nice wall, ser.' : fixDump.hint);
      }

      // Countdown.
      if (dump?.endsAt !== undefined && snap) {
        const left = dump.endsAt - serverNow(snap);
        timerValue.textContent = fmtCountdown(left);
        timer.classList.toggle('is-urgent', mode === 'live' && left < URGENT_MS);
      } else if (mode === 'fixed') {
        timerValue.textContent = 'FIXED';
        timer.classList.remove('is-urgent');
      }

      // Walls.
      let heldCount = 0;
      let otherHeld = false;
      for (const card of cards) {
        const st = dump?.stations.find((s) => s.id === card.id);
        const fixed = mode === 'fixed' || !!st?.fixed;
        const isMine = card.id === mine;
        const held = fixed || (st?.holders ?? 0) > 0 || (isMine && holding);
        if (held) heldCount++;
        if (!isMine && held) otherHeld = true;
        card.root.classList.toggle('is-held', held);
        card.root.classList.toggle('is-fixed', fixed);
        const text = fixed ? 'FIXED' : held ? (isMine && holding ? 'HOLDING' : 'HELD') : 'OPEN';
        if (card.state.textContent !== text) card.state.textContent = text;
      }

      let msg: string;
      let tone = '';
      if (mode === 'fixed') {
        msg = 'Both walls held. Dump absorbed.';
        tone = 'good';
      } else if (mode === 'standby') {
        msg = snap?.phase === 'gameOver' ? 'Game over.' : 'Standby…';
      } else if (heldCount >= cards.length) {
        msg = 'BOTH WALLS UP! Keep holding…';
        tone = 'good';
      } else if (holding) {
        msg = `Holding! Waiting for ${otherName}…`;
        tone = 'info';
      } else if (otherHeld) {
        msg = `${otherName} is holding. HOLD YOURS NOW!`;
        tone = 'warn';
      } else {
        msg = 'Press and hold the pad.';
      }
      if (status.textContent !== msg) status.textContent = msg;
      status.dataset.tone = tone;
      padMain.textContent = mode === 'fixed' ? 'FIXED' : holding ? 'HOLDING' : 'HOLD';
    }

    // Pointer input on the pad.
    scope.on<PointerEvent>(pad, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (mode !== 'live') return;
      pointers.add(e.pointerId);
      sync();
    });
    const lift = (e: PointerEvent): void => {
      if (!pointers.delete(e.pointerId)) return;
      sync();
    };
    scope.on<PointerEvent>(pad, 'pointerup', lift);
    scope.on<PointerEvent>(pad, 'pointercancel', lift);
    scope.on<PointerEvent>(pad, 'pointerleave', lift);
    scope.on<PointerEvent>(pad, 'lostpointercapture', lift);
    // A pointerup outside the pad (mouse dragged off then released) is covered by pointerleave;
    // this catches anything that still slips through.
    scope.on<PointerEvent>(window, 'pointerup', lift);

    // Keyboard: hold Space.
    scope.on<KeyboardEvent>(window, 'keydown', (e) => {
      if (!isSpaceKey(e) || isTypingTarget(e.target)) return;
      e.preventDefault();
      if (e.repeat || mode !== 'live') return;
      keyHeld = true;
      sync();
    });
    scope.on<KeyboardEvent>(window, 'keyup', (e) => {
      if (!isSpaceKey(e)) return;
      e.preventDefault();
      keyHeld = false;
      sync();
    });

    // Losing focus means we will never see the release: let go now.
    scope.on(window, 'blur', releaseAll);
    scope.on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') releaseAll();
    });

    scope.add(() => {
      if (holding) {
        holding = false;
        host.holdEnd();
      }
    });

    wrap.dataset.mode = mode;
    refresh();
    scope.interval(refresh, POLL_MS);
  },
};
