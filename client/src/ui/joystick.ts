// Floating virtual joystick for touch devices (bottom-left). Calls ctx.game.setJoystick(x, y).

import type { UiCore } from './core';
import { h } from './dom';

const DEAD_ZONE = 0.14;

export interface Joystick {
  el: HTMLElement;
  reset(): void;
  destroy(): void;
}

export function createJoystick(core: UiCore): Joystick {
  const knob = h('div', { class: 'joy-knob' });
  const base = h('div', { class: 'joy-base' }, knob);
  const zone = h('div', { class: 'joy-zone', attrs: { 'aria-hidden': 'true' } }, base);
  let active: number | null = null;
  let ox = 0;
  let oy = 0;
  let lastX = 0;
  let lastY = 0;

  const radius = () => Math.max(36, base.offsetWidth * 0.42);

  function send(x: number, y: number): void {
    if (x === lastX && y === lastY) return;
    lastX = x;
    lastY = y;
    try {
      core.ctx.game.setJoystick(x, y);
    } catch (err) {
      console.error('[ui] setJoystick failed', err);
    }
  }

  function move(cx: number, cy: number): void {
    const r = radius();
    let dx = cx - ox;
    let dy = cy - oy;
    const d = Math.hypot(dx, dy);
    if (d > r) {
      dx = (dx / d) * r;
      dy = (dy / d) * r;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    let nx = dx / r;
    let ny = dy / r;
    const mag = Math.hypot(nx, ny);
    if (mag < DEAD_ZONE) {
      nx = 0;
      ny = 0;
    } else {
      // Re-scale so movement starts smoothly just outside the dead zone.
      const k = Math.min(1, (mag - DEAD_ZONE) / (1 - DEAD_ZONE)) / mag;
      nx *= k;
      ny *= k;
    }
    send(Math.round(nx * 100) / 100, Math.round(ny * 100) / 100);
  }

  function reset(): void {
    active = null;
    knob.style.transform = '';
    base.style.left = '';
    base.style.top = '';
    zone.classList.remove('is-active');
    send(0, 0);
  }

  zone.addEventListener('pointerdown', (e) => {
    if (active !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    active = e.pointerId;
    try {
      zone.setPointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const rect = zone.getBoundingClientRect();
    ox = e.clientX;
    oy = e.clientY;
    base.style.left = `${e.clientX - rect.left}px`;
    base.style.top = `${e.clientY - rect.top}px`;
    zone.classList.add('is-active');
    move(e.clientX, e.clientY);
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active) return;
    e.preventDefault();
    move(e.clientX, e.clientY);
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== active) return;
    reset();
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
  zone.addEventListener('lostpointercapture', end);
  const onBlur = () => {
    if (active !== null) reset();
  };
  window.addEventListener('blur', onBlur);

  return {
    el: zone,
    reset,
    destroy() {
      window.removeEventListener('blur', onBlur);
      lastX = Number.NaN; // force a final (0, 0) so the player never keeps walking
      reset();
    },
  };
}
