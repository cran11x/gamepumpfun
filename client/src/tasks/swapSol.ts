// swapSol: drag the slider to the ordered SOL amount (within ±0.05) and press SWAP. Fine-tune
// with the −/+ buttons (press and hold repeats) or the arrow keys on the slider.

import {
  button,
  clamp,
  el,
  fmtInt,
  normTicker,
  onDrag,
  pick,
  rand,
  randInt,
  restartClass,
  type MinigameCtx,
  type MinigameDef,
} from './kit';

const MAX_SOL = 3;
const STEP = 0.01;
const TOLERANCE = 0.05;
const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 70;
/** A click this soon after a touch/pen swap is the same tap; ignore it. */
const CLICK_DEDUPE_MS = 600;

const round2 = (v: number): number => Math.round(v * 100) / 100;

export const swapSol: MinigameDef = {
  hint: 'Drag to the exact SOL amount (±0.05), then SWAP.',
  mount(ctx: MinigameCtx) {
    const { scope, stage, host } = ctx;
    const ticker = normTicker(host.ticker);
    const target = round2(rand(0.25, 2.75));
    const rate = randInt(1_800_000, 3_600_000);
    let value = 0;

    ctx.setHint(`Swap exactly ${target.toFixed(2)} SOL (±0.05), then hit SWAP.`);

    const wrap = el('div', 'tk-swap');
    const order = el('div', 'tk-swap-order');
    order.append(el('span', 'tk-swap-order-label', 'ORDER'), el('span', 'tk-swap-order-value', `${target.toFixed(2)} SOL`), el('span', 'tk-swap-order-tol', '±0.05'));

    const card = el('div', 'tk-swap-card');
    const payRow = el('div', 'tk-swap-row');
    const amt = el('span', 'tk-swap-amt', '0.00');
    const solChip = el('span', 'tk-chip tk-chip--sol', '◎ SOL');
    payRow.append(el('span', 'tk-swap-row-label', 'You pay'), amt, solChip);

    const sliderRow = el('div', 'tk-swap-slider-row');
    const minus = button('tk-nudge', '−');
    minus.setAttribute('aria-label', 'Minus 0.01 SOL');
    const plus = button('tk-nudge', '+');
    plus.setAttribute('aria-label', 'Plus 0.01 SOL');
    const track = el('div', 'tk-slider');
    const fill = el('span', 'tk-slider-fill');
    const thumb = el('span', 'tk-slider-thumb');
    thumb.tabIndex = 0;
    thumb.setAttribute('role', 'slider');
    thumb.setAttribute('aria-label', 'SOL amount');
    thumb.setAttribute('aria-valuemin', '0');
    thumb.setAttribute('aria-valuemax', String(MAX_SOL));
    const ticks = el('span', 'tk-slider-ticks');
    for (let i = 0; i <= MAX_SOL * 2; i++) ticks.append(el('span', i % 2 === 0 ? 'is-major' : ''));
    track.append(ticks, fill, thumb);
    sliderRow.append(minus, track, plus);

    const scale = el('div', 'tk-swap-scale');
    for (let i = 0; i <= MAX_SOL; i++) scale.append(el('span', '', String(i)));

    const getRow = el('div', 'tk-swap-row tk-swap-row--get');
    const getAmt = el('span', 'tk-swap-get', `0 ${ticker}`);
    getRow.append(el('span', 'tk-swap-row-label', 'You receive'), getAmt);
    card.append(payRow, sliderRow, scale, getRow);

    const go = button('tk-btn tk-btn--go tk-btn--big tk-swap-go', 'SWAP');
    wrap.append(order, card, go);
    stage.append(wrap);

    const inRange = (): boolean => Math.abs(value - target) <= TOLERANCE + 1e-9;

    const render = (): void => {
      const f = value / MAX_SOL;
      fill.style.transform = `scaleX(${f})`;
      thumb.style.left = `${f * 100}%`;
      amt.textContent = value.toFixed(2);
      thumb.setAttribute('aria-valuenow', value.toFixed(2));
      thumb.setAttribute('aria-valuetext', `${value.toFixed(2)} SOL`);
      getAmt.textContent = `≈ ${fmtInt(value * rate)} ${ticker}`;
      const ok = inRange();
      card.classList.toggle('is-ok', ok);
      go.classList.toggle('is-ready', ok);
    };

    const setValue = (v: number): void => {
      const next = clamp(round2(v), 0, MAX_SOL);
      if (next === value) return;
      value = next;
      render();
    };

    const fromX = (clientX: number): void => {
      const r = track.getBoundingClientRect();
      if (r.width <= 0) return;
      setValue(((clientX - r.left) / r.width) * MAX_SOL);
    };

    onDrag(scope, track, {
      start(e) {
        if (ctx.won) return false;
        track.classList.add('is-drag');
        fromX(e.clientX);
      },
      move(e) {
        fromX(e.clientX);
      },
      end() {
        track.classList.remove('is-drag');
      },
    });

    scope.on<KeyboardEvent>(thumb, 'keydown', (e) => {
      if (ctx.won) return;
      const big = e.shiftKey ? 10 : 1;
      let handled = true;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setValue(value - STEP * big);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setValue(value + STEP * big);
      else if (e.key === 'PageDown') setValue(value - 0.1);
      else if (e.key === 'PageUp') setValue(value + 0.1);
      else if (e.key === 'Home') setValue(0);
      else if (e.key === 'End') setValue(MAX_SOL);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // Press-and-hold nudges.
    for (const [b, dir] of [
      [minus, -1],
      [plus, 1],
    ] as const) {
      let delay = 0;
      let rep = 0;
      let pid: number | null = null;
      const stop = (): void => {
        pid = null;
        scope.clearTimeout(delay);
        scope.clearInterval(rep);
        delay = 0;
        rep = 0;
        b.classList.remove('is-held');
      };
      const nudge = (): void => {
        setValue(value + STEP * dir);
        ctx.click();
      };
      scope.on<PointerEvent>(b, 'pointerdown', (e) => {
        if (ctx.won || pid !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault();
        pid = e.pointerId;
        try {
          b.setPointerCapture(e.pointerId);
        } catch {
          /* pointer gone */
        }
        b.classList.add('is-held');
        nudge();
        delay = scope.timeout(() => {
          rep = scope.interval(() => setValue(value + STEP * dir), REPEAT_EVERY_MS);
        }, REPEAT_DELAY_MS);
      });
      const end = (e: PointerEvent): void => {
        if (e.pointerId === pid) stop();
      };
      scope.on<PointerEvent>(b, 'pointerup', end);
      scope.on<PointerEvent>(b, 'pointercancel', end);
      scope.on<PointerEvent>(b, 'lostpointercapture', end);
      // Keyboard activation (Enter/Space on a focused button) arrives as a click with detail 0.
      scope.on<MouseEvent>(b, 'click', (e) => {
        if (e.detail === 0 && !ctx.won) nudge();
      });
    }

    const trySwap = (): void => {
      if (ctx.won) return;
      if (inRange()) {
        ctx.win('SWAPPED');
        return;
      }
      if (value === 0) ctx.fail("You can't swap 0 SOL, ser.", card);
      else
        ctx.fail(
          pick([
            `Wrong size. Stick to the plan: ${target.toFixed(2)} SOL.`,
            value > target ? 'Too much! Save some for the dip.' : 'Too little. Size up, ser.',
          ]),
          card,
        );
      restartClass(amt, 'is-bad');
    };

    // Touch/pen taps fire on pointerup: right after a quick slider drag, Chromium can treat the
    // drag as a fling and swallow the next tap's click, and a second-finger tap (thumb still on
    // the slider) gets no click at all. Mouse and keyboard keep using click; a click right after
    // a pointer-fired swap is the same tap and is ignored.
    let goPid: number | null = null;
    let goFiredAt = -Infinity;
    scope.on<PointerEvent>(go, 'pointerdown', (e) => {
      if (e.pointerType !== 'mouse') goPid = e.pointerId;
    });
    scope.on<PointerEvent>(go, 'pointerup', (e) => {
      if (e.pointerId !== goPid) return;
      goPid = null;
      const r = go.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      goFiredAt = performance.now();
      trySwap();
    });
    scope.on<PointerEvent>(go, 'pointercancel', (e) => {
      if (e.pointerId === goPid) goPid = null;
    });
    scope.on(go, 'click', () => {
      if (performance.now() - goFiredAt < CLICK_DEDUPE_MS) return;
      trySwap();
    });

    render();
  },
};
