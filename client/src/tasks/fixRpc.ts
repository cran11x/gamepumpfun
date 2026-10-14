// fixRpc: turn the frequency dial until your signal (red → green as it gets closer) lines up with
// the gold reference waveform, then hold it there for a moment to lock. The dial turns by
// dragging around it; dragging sideways on the scope, the mouse wheel and arrow keys fine-tune.

import { canvasView, clamp, el, lerp, onDrag, rand, svgEl, type MinigameCtx, type MinigameDef } from './kit';

const F_MIN = 1;
const F_MAX = 6;
/** Frequency change per radian of dial rotation (one full turn = 2.5). */
const PER_RAD = 2.5 / (Math.PI * 2);
const TOLERANCE = 0.08;
const LOCK_SECONDS = 0.7;

export const fixRpc: MinigameDef = {
  hint: 'Turn the dial until your signal lines up with the gold one.',
  mount(ctx: MinigameCtx) {
    const { scope, stage } = ctx;

    const target = rand(1.8, 5.2);
    let freq = target;
    for (let i = 0; i < 20 && Math.abs(freq - target) < 1.1; i++) freq = clamp(target + (Math.random() < 0.5 ? -1 : 1) * rand(1.2, 2.2), F_MIN, F_MAX);
    if (Math.abs(freq - target) < 1.1) freq = target > (F_MIN + F_MAX) / 2 ? F_MIN : F_MAX;

    const wrap = el('div', 'tk-rpc');
    const scopeBox = el('div', 'tk-rpc-scope');
    const canvas = el('canvas', 'tk-canvas');
    const scopeTag = el('span', 'tk-rpc-scope-tag', 'RPC SIGNAL');
    scopeBox.append(canvas, scopeTag);

    const controls = el('div', 'tk-rpc-controls');
    const dial = el('div', 'tk-dial');
    dial.tabIndex = 0;
    dial.setAttribute('role', 'slider');
    dial.setAttribute('aria-label', 'Frequency dial');
    dial.setAttribute('aria-valuemin', String(F_MIN));
    dial.setAttribute('aria-valuemax', String(F_MAX));
    const dialFace = el('span', 'tk-dial-face');
    const ticks = svgEl('svg', { class: 'tk-dial-ticks', viewBox: '0 0 100 100', 'aria-hidden': 'true' });
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r1 = i % 6 === 0 ? 40 : 43;
      ticks.append(svgEl('line', { x1: 50 + Math.cos(a) * r1, y1: 50 + Math.sin(a) * r1, x2: 50 + Math.cos(a) * 47, y2: 50 + Math.sin(a) * 47 }));
    }
    const knob = el('span', 'tk-dial-knob');
    knob.append(el('span', 'tk-dial-notch'));
    dialFace.append(ticks, knob);
    dial.append(dialFace);

    const readouts = el('div', 'tk-rpc-read');
    const freqEl = el('div', 'tk-rpc-freq');
    const freqVal = el('span', 'tk-rpc-freq-val');
    freqEl.append(el('span', 'tk-rpc-freq-label', 'FREQ'), freqVal);
    const sig = el('div', 'tk-rpc-sig');
    const sigBars = Array.from({ length: 5 }, (_, i) => {
      const b = el('span', 'tk-rpc-sig-bar');
      b.style.setProperty('--h', `${30 + i * 17}%`);
      return b;
    });
    sig.append(el('span', 'tk-rpc-sig-label', 'SIGNAL'), ...sigBars);
    const lock = el('div', 'tk-rpc-lock');
    const lockFill = el('span', 'tk-rpc-lock-fill');
    const lockText = el('span', 'tk-rpc-lock-text', 'NO LOCK');
    lock.append(lockFill, lockText);
    readouts.append(freqEl, sig, lock);
    controls.append(dial, readouts);

    wrap.append(scopeBox, controls);
    stage.append(wrap);

    const view = canvasView(scope, canvas);

    let lockP = 0;
    let wasAligned = false;
    let t = 0;

    const setFreq = (f: number): void => {
      freq = clamp(f, F_MIN, F_MAX);
    };

    // Dial: rotate by dragging around its center.
    let lastA = 0;
    const angleOf = (e: PointerEvent): { a: number; d: number } => {
      const r = dial.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      return { a: Math.atan2(dy, dx), d: Math.hypot(dx, dy) };
    };
    onDrag(scope, dial, {
      start(e) {
        if (ctx.won) return false;
        lastA = angleOf(e).a;
        dial.classList.add('is-drag');
      },
      move(e) {
        const { a, d } = angleOf(e);
        let delta = a - lastA;
        if (delta > Math.PI) delta -= Math.PI * 2;
        else if (delta < -Math.PI) delta += Math.PI * 2;
        lastA = a;
        // Near the center the angle is noise.
        if (d < 10) return;
        setFreq(freq + delta * PER_RAD);
      },
      end() {
        dial.classList.remove('is-drag');
      },
    });

    // Scope: sideways drag fine-tunes.
    let lastX = 0;
    onDrag(scope, scopeBox, {
      start(e) {
        if (ctx.won) return false;
        lastX = e.clientX;
      },
      move(e) {
        const w = Math.max(120, scopeBox.clientWidth);
        setFreq(freq + ((e.clientX - lastX) / w) * 2.5);
        lastX = e.clientX;
      },
    });

    scope.on<WheelEvent>(
      dial,
      'wheel',
      (e) => {
        if (ctx.won) return;
        e.preventDefault();
        setFreq(freq - Math.sign(e.deltaY) * 0.03);
      },
      { passive: false },
    );
    scope.on<KeyboardEvent>(dial, 'keydown', (e) => {
      if (ctx.won) return;
      const step = e.shiftKey ? 0.2 : 0.02;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setFreq(freq + step);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setFreq(freq - step);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });

    const waveY = (x: number, w: number, f: number, phase: number, amp: number, mid: number): number =>
      mid + Math.sin((x / w) * Math.PI * 2 * f + phase) * amp;

    const draw = (closeness: number, aligned: boolean): void => {
      const { ctx: g, w, h } = view;
      view.begin();
      // Grid.
      g.strokeStyle = 'rgba(43,255,136,0.07)';
      g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= w; x += 24) {
        g.moveTo(x + 0.5, 0);
        g.lineTo(x + 0.5, h);
      }
      for (let y = 0; y <= h; y += 24) {
        g.moveTo(0, y + 0.5);
        g.lineTo(w, y + 0.5);
      }
      g.stroke();
      g.strokeStyle = 'rgba(160,190,230,0.18)';
      g.beginPath();
      g.moveTo(0, h / 2 + 0.5);
      g.lineTo(w, h / 2 + 0.5);
      g.stroke();

      const mid = h / 2;
      const amp = h * 0.3;
      const phase = t * 2.2;

      // Reference.
      g.setLineDash([7, 5]);
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(255,212,0,0.75)';
      g.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const y = waveY(x, w, target, phase, amp, mid);
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);

      // Player signal: static noise shrinks as it gets closer.
      const noise = (1 - closeness) * h * 0.09;
      const r = Math.round(lerp(255, 43, closeness));
      const gg = Math.round(lerp(59, 255, closeness));
      const b = Math.round(lerp(92, 136, closeness));
      const color = `rgb(${r},${gg},${b})`;
      g.lineWidth = aligned ? 3 : 2.4;
      g.strokeStyle = color;
      g.shadowColor = color;
      g.shadowBlur = aligned ? 12 : 6;
      g.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const y = waveY(x, w, freq, phase, amp, mid) + (Math.random() - 0.5) * noise;
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.shadowBlur = 0;
    };

    const render = (dt: number): boolean | void => {
      t += dt;
      const diff = Math.abs(freq - target);
      const closeness = clamp(1 - diff / 1.6, 0, 1);
      const aligned = diff <= TOLERANCE;
      if (!ctx.won) {
        lockP = clamp(lockP + (aligned ? dt / LOCK_SECONDS : -dt * 1.5), 0, 1);
        if (aligned && !wasAligned) ctx.click();
        wasAligned = aligned;
      }
      // Knob rotation follows the frequency, so the notch shows where you are.
      knob.style.transform = `rotate(${((freq - F_MIN) / PER_RAD) * (180 / Math.PI)}deg)`;
      dial.setAttribute('aria-valuenow', freq.toFixed(2));
      freqVal.textContent = `${(400 + freq * 25).toFixed(1)} MHz`;
      const bars = Math.ceil(closeness * 5 - 0.001);
      sigBars.forEach((bar, i) => bar.classList.toggle('is-on', i < bars));
      wrap.classList.toggle('is-aligned', aligned);
      lockFill.style.transform = `scaleX(${lockP})`;
      lockText.textContent = lockP > 0.01 ? `LOCKING ${Math.round(lockP * 100)}%` : aligned ? 'LOCKING…' : 'NO LOCK';
      draw(closeness, aligned);
      if (!ctx.won && lockP >= 1) {
        lockText.textContent = 'LOCKED';
        ctx.win('RPC ONLINE');
      }
    };
    scope.loop(render);
  },
};
