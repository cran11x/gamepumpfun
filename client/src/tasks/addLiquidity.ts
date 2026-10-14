// addLiquidity: hold the button (or the tank, or Space) to pour SOL into the pool. Release while
// the level sits inside the gold target band. Releasing above the band, or filling to the brim,
// overflows the pool and it drains back to zero. Releasing below the band just pauses.

import {
  button,
  canvasView,
  clamp,
  el,
  isSpaceKey,
  isTypingTarget,
  pick,
  rand,
  roundRectPath,
  type MinigameCtx,
  type MinigameDef,
} from './kit';

/** Fill speed while holding, as pool fraction per second. */
const FILL_RATE = 0.34;
const DRAIN_RATE = 0.85;
const BAND = 0.14;

const OVERFILL_LINES = ['Overfilled! Slippage ate the bag.', 'Too much! The pool overflowed.', 'Whoa, whale. Pool spilled everywhere.'];

interface Bubble {
  x: number;
  y: number;
  r: number;
  v: number;
}

export const addLiquidity: MinigameDef = {
  hint: 'Hold to pour. Release while the level is inside the gold band.',
  mount(ctx: MinigameCtx) {
    const { scope, stage } = ctx;

    const wrap = el('div', 'tk-liq');
    const tank = el('div', 'tk-liq-tank');
    const canvas = el('canvas', 'tk-canvas');
    tank.append(canvas);
    const side = el('div', 'tk-liq-side');
    const read = el('div', 'tk-liq-read');
    const readLabel = el('span', 'tk-liq-read-label', 'POOL DEPTH');
    const readValue = el('span', 'tk-liq-read-value', '0.0%');
    read.append(readLabel, readValue);
    const lo = rand(0.42, 0.74);
    const hi = lo + BAND;
    const targetEl = el('div', 'tk-liq-target');
    targetEl.append(el('span', 'tk-liq-target-label', 'TARGET'), el('span', 'tk-liq-target-value', `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`));
    const statusEl = el('div', 'tk-liq-status', 'Pool is empty. Pour some SOL in.');
    const btn = button('tk-btn tk-btn--go tk-btn--big tk-liq-btn');
    btn.append(el('span', 'tk-liq-btn-main', 'HOLD TO ADD'), el('span', 'tk-liq-btn-sub', 'SOL → POOL'));
    side.append(read, targetEl, statusEl, btn);
    wrap.append(tank, side);
    stage.append(wrap);

    const view = canvasView(scope, canvas);

    let level = 0;
    let holding = false;
    let draining = false;
    let t = 0;
    let slosh = 0;
    const bubbles: Bubble[] = [];

    const inBand = (): boolean => level >= lo && level <= hi;

    const setStatus = (text: string): void => {
      if (statusEl.textContent !== text) statusEl.textContent = text;
    };

    const overfill = (): void => {
      holding = false;
      draining = true;
      slosh = 1;
      btn.classList.remove('is-held');
      ctx.fail(pick(OVERFILL_LINES), tank);
    };

    const press = (): void => {
      if (ctx.won || draining || holding) return;
      holding = true;
      btn.classList.add('is-held');
      ctx.click();
    };

    /** `evaluate` is false when the hold ended for reasons other than the player letting go. */
    const release = (evaluate: boolean): void => {
      if (!holding) return;
      holding = false;
      btn.classList.remove('is-held');
      if (!evaluate || ctx.won || draining) return;
      if (inBand()) {
        ctx.win('LIQUIDITY ADDED');
      } else if (level > hi) {
        overfill();
      } else if (level > 0.02) {
        ctx.flash('Not deep enough yet. Keep pouring.', 'info', 1200);
      }
    };

    // Hold surfaces: the big button and the tank itself.
    for (const surface of [btn, tank]) {
      let pid: number | null = null;
      scope.on<PointerEvent>(surface, 'pointerdown', (e) => {
        if (pid !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault();
        pid = e.pointerId;
        try {
          surface.setPointerCapture(e.pointerId);
        } catch {
          /* pointer gone */
        }
        press();
      });
      const end = (e: PointerEvent, evaluate: boolean): void => {
        if (e.pointerId !== pid) return;
        pid = null;
        release(evaluate);
      };
      scope.on<PointerEvent>(surface, 'pointerup', (e) => end(e, true));
      scope.on<PointerEvent>(surface, 'pointercancel', (e) => end(e, false));
      scope.on<PointerEvent>(surface, 'lostpointercapture', (e) => end(e, false));
    }
    scope.on<KeyboardEvent>(window, 'keydown', (e) => {
      if (!isSpaceKey(e) || isTypingTarget(e.target)) return;
      e.preventDefault();
      if (!e.repeat) press();
    });
    scope.on<KeyboardEvent>(window, 'keyup', (e) => {
      if (!isSpaceKey(e)) return;
      e.preventDefault();
      release(true);
    });
    scope.on(window, 'blur', () => release(false));

    const draw = (): void => {
      const { ctx: g, w, h } = view;
      view.begin();
      const pad = Math.max(8, Math.min(w, h) * 0.06);
      const x0 = pad;
      const y0 = pad + 6;
      const tw = w - pad * 2;
      const th = h - pad * 2 - 6;
      const rad = Math.min(18, tw * 0.18);

      // Glass.
      g.save();
      roundRectPath(g, x0, y0, tw, th, rad);
      g.fillStyle = '#0b1119';
      g.fill();
      g.clip();

      // Ticks.
      g.fillStyle = 'rgba(160,190,230,0.22)';
      for (let i = 1; i < 10; i++) {
        const y = y0 + th - (th * i) / 10;
        g.fillRect(x0 + 6, y, i % 5 === 0 ? 14 : 8, 1);
      }

      // Target band.
      const bandTop = y0 + th - th * hi;
      const bandBot = y0 + th - th * lo;
      const hot = inBand() && !draining;
      g.fillStyle = hot ? `rgba(255,212,0,${0.16 + 0.08 * Math.sin(t * 10)})` : 'rgba(255,212,0,0.09)';
      g.fillRect(x0, bandTop, tw, bandBot - bandTop);

      // Liquid.
      const surf = y0 + th - th * level;
      if (level > 0.001) {
        const amp = 2 + slosh * 7 + (holding ? 2.5 : 0);
        const grad = g.createLinearGradient(0, surf, 0, y0 + th);
        if (draining) {
          grad.addColorStop(0, 'rgba(255,59,92,0.9)');
          grad.addColorStop(1, 'rgba(120,20,40,0.9)');
        } else if (hot) {
          grad.addColorStop(0, 'rgba(43,255,136,0.95)');
          grad.addColorStop(1, 'rgba(18,120,80,0.95)');
        } else {
          grad.addColorStop(0, 'rgba(34,229,255,0.92)');
          grad.addColorStop(1, 'rgba(47,140,255,0.85)');
        }
        g.beginPath();
        g.moveTo(x0, y0 + th);
        for (let x = 0; x <= tw; x += 4) {
          const y = surf + Math.sin(x * 0.055 + t * 3.2) * amp + Math.sin(x * 0.11 - t * 2.1) * amp * 0.45;
          g.lineTo(x0 + x, y);
        }
        g.lineTo(x0 + tw, y0 + th);
        g.closePath();
        g.fillStyle = grad;
        g.fill();
        // Bubbles.
        g.fillStyle = 'rgba(255,255,255,0.35)';
        for (const b of bubbles) {
          const by = y0 + th - b.y * th;
          if (by < surf + 3) continue;
          g.beginPath();
          g.arc(x0 + b.x * tw, by, b.r, 0, Math.PI * 2);
          g.fill();
        }
      }

      // Pour stream.
      if (holding) {
        const sx = x0 + tw * 0.5 + Math.sin(t * 9) * 1.5;
        const sg = g.createLinearGradient(0, y0, 0, surf);
        sg.addColorStop(0, 'rgba(153,69,255,0.95)');
        sg.addColorStop(1, 'rgba(34,229,255,0.9)');
        g.fillStyle = sg;
        g.fillRect(sx - 3, y0, 6, Math.max(0, surf - y0));
      }

      // Band edges + label.
      g.setLineDash([6, 5]);
      g.lineWidth = 2;
      g.strokeStyle = hot ? '#ffd400' : 'rgba(255,212,0,0.7)';
      g.beginPath();
      g.moveTo(x0, bandTop);
      g.lineTo(x0 + tw, bandTop);
      g.moveTo(x0, bandBot);
      g.lineTo(x0 + tw, bandBot);
      g.stroke();
      g.setLineDash([]);
      g.font = '700 10px "JetBrains Mono", monospace';
      g.textAlign = 'right';
      g.textBaseline = 'bottom';
      g.fillStyle = '#ffd400';
      g.fillText('TARGET', x0 + tw - 6, bandTop - 3);
      g.restore();

      // Rim.
      roundRectPath(g, x0, y0, tw, th, rad);
      g.lineWidth = 2;
      g.strokeStyle = hot ? 'rgba(43,255,136,0.9)' : draining ? 'rgba(255,59,92,0.85)' : 'rgba(160,190,230,0.35)';
      g.stroke();
      // Glass shine.
      const shine = g.createLinearGradient(0, y0, 0, y0 + th);
      shine.addColorStop(0, 'rgba(255,255,255,0.10)');
      shine.addColorStop(0.5, 'rgba(255,255,255,0.02)');
      shine.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = shine;
      roundRectPath(g, x0 + tw * 0.76, y0 + 12, Math.max(3, tw * 0.05), th * 0.6, 3);
      g.fill();
    };

    scope.loop((dt) => {
      t += dt;
      slosh = Math.max(0, slosh - dt * 1.4);
      if (!ctx.won) {
        if (draining) {
          level -= DRAIN_RATE * dt;
          if (level <= 0) {
            level = 0;
            draining = false;
            ctx.flash('Pool drained. Pour again, a bit gentler.', 'info');
          }
        } else if (holding) {
          level += FILL_RATE * dt;
          if (level >= 1) {
            level = 1;
            overfill();
          }
        }
      }
      level = clamp(level, 0, 1);

      if (holding && Math.random() < dt * 30) bubbles.push({ x: rand(0.15, 0.85), y: 0, r: rand(1.2, 3.2), v: rand(0.25, 0.6) });
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        b.y += b.v * dt;
        if (b.y > level) bubbles.splice(i, 1);
      }

      const pct = `${(level * 100).toFixed(1)}%`;
      if (readValue.textContent !== pct) readValue.textContent = pct;
      const hot = inBand() && !draining;
      wrap.classList.toggle('is-hot', hot);
      wrap.classList.toggle('is-draining', draining);
      if (!ctx.won) {
        if (draining) setStatus('Draining… wait for it.');
        else if (hot) setStatus(holding ? 'IN THE BAND. LET GO!' : 'In the band. Pool looks healthy.');
        else if (level > hi) setStatus('Too deep!');
        else if (holding) setStatus('Pouring…');
        else if (level > 0.02) setStatus('Keep going. Hold again.');
        else setStatus('Pool is empty. Pour some SOL in.');
      }
      draw();
    });

  },
};
