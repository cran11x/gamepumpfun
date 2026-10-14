// Full-station map overlay (M): drawn from GRID with room labels, your position, your undone tasks,
// the SPACES button, bridges for ruggers and, during sabotage, the fix stations.

import { TILE } from '../../../shared/constants';
import {
  CELL_FLOOR,
  CELL_OBSTACLE,
  CELL_WALL,
  EMERGENCY_BUTTON,
  GRID,
  MAP_H,
  MAP_W,
  ROOMS,
  SABOTAGE_STATIONS,
  SABOTAGE_TITLES,
  stationById,
  VENTS,
  WORLD_H,
  WORLD_W,
} from '../../../shared/map';
import type { UiCore } from './core';
import { h, icon } from './dom';
import { colorOf } from './pill';

const PX = 14; // offscreen pixels per tile

export interface FullMap {
  toggle(force?: boolean): void;
  isOpen(): boolean;
  close(): void;
}

let baseCanvas: HTMLCanvasElement | null = null;

function buildBase(): HTMLCanvasElement {
  if (baseCanvas) return baseCanvas;
  const c = document.createElement('canvas');
  c.width = MAP_W * PX;
  c.height = MAP_H * PX;
  const g = c.getContext('2d');
  if (!g) return c;
  for (const room of ROOMS) {
    g.fillStyle = hexA(room.accent, 0.1);
    g.fillRect(room.rect.x * PX, room.rect.y * PX, room.rect.w * PX, room.rect.h * PX);
  }
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const v = GRID[y * MAP_W + x];
      if (v === CELL_FLOOR) {
        g.fillStyle = 'rgba(30,42,58,0.55)';
        g.fillRect(x * PX, y * PX, PX, PX);
      } else if (v === CELL_WALL) {
        g.fillStyle = '#2a3a50';
        g.fillRect(x * PX, y * PX, PX, PX);
      } else if (v === CELL_OBSTACLE) {
        g.fillStyle = '#1a2533';
        g.fillRect(x * PX + 1, y * PX + 1, PX - 2, PX - 2);
      }
    }
  }
  // Neon room outlines.
  for (const room of ROOMS) {
    g.strokeStyle = hexA(room.accent, 0.55);
    g.lineWidth = 2;
    g.strokeRect(room.rect.x * PX + 1, room.rect.y * PX + 1, room.rect.w * PX - 2, room.rect.h * PX - 2);
  }
  baseCanvas = c;
  return c;
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function createFullMap(core: UiCore, layer: HTMLElement): FullMap {
  const { ctx } = core;
  let open = false;
  let raf = 0;
  const canvas = h('canvas', { class: 'fmap-canvas' });
  const legend = h('div', { class: 'fmap-legend' });
  const closeBtn = h('button', { class: 'modal-x', type: 'button', attrs: { 'aria-label': 'Close map' } }, icon('close'));
  const panel = h(
    'div',
    { class: 'fmap-panel' },
    h('div', { class: 'fmap-head' }, h('h2', { class: 'fmap-title', text: 'THE TRENCHES HQ' }), h('kbd', { class: 'kbd fmap-kbd', text: 'M' }), closeBtn),
    h('div', { class: 'fmap-stage' }, canvas),
    legend,
  );
  const el = h('div', { class: 'fmap' }, panel);
  el.addEventListener('pointerdown', (e) => {
    if (e.target === el) close();
  });
  closeBtn.addEventListener('click', () => close());

  function legendItem(cls: string, label: string): HTMLElement {
    return h('span', { class: 'fmap-li' }, h('span', { class: `fmap-dot ${cls}` }), label);
  }

  function renderLegend(): void {
    const me = ctx.store.snap?.me;
    legend.textContent = '';
    legend.append(legendItem('fmap-dot--you', 'You'), legendItem('fmap-dot--task', me?.role === 'rugger' ? 'Fake tasks' : 'Your tasks'), legendItem('fmap-dot--spaces', 'SPACES'));
    if (me?.role === 'rugger') legend.append(legendItem('fmap-dot--vent', 'Bridges'));
    if (ctx.store.snap?.sabotage) legend.append(legendItem('fmap-dot--fix', 'Fix here'));
  }

  function draw(t: number): void {
    raf = 0;
    if (!open) return;
    raf = requestAnimationFrame(draw);
    const snap = ctx.store.snap;
    const stage = canvas.parentElement as HTMLElement;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.min(cw / WORLD_W, ch / WORLD_H);
    const w = Math.round(WORLD_W * scale);
    const hgt = Math.round(WORLD_H * scale);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hgt}px`;
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    g.imageSmoothingEnabled = true;
    g.drawImage(buildBase(), 0, 0, w, hgt);
    const sx = (x: number) => x * scale;
    const pulse = 0.5 + 0.5 * Math.sin(t / 220);

    // Room labels.
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const fs = Math.max(8, Math.min(15, w / 70));
    g.font = `${fs}px Bungee, sans-serif`;
    for (const room of ROOMS) {
      const cx = (room.rect.x + room.rect.w / 2) * TILE * scale;
      const cy = (room.rect.y + room.rect.h / 2) * TILE * scale;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillText(room.name, cx + 1, cy + 1);
      g.fillStyle = hexA(room.accent, 0.9);
      g.fillText(room.name, cx, cy);
    }

    const me = snap?.me;
    const rad = Math.max(3, w / 160);

    // SPACES button.
    g.fillStyle = '#ff3b5c';
    g.beginPath();
    g.arc(sx(EMERGENCY_BUTTON.x), sx(EMERGENCY_BUTTON.y), rad * 1.1, 0, Math.PI * 2);
    g.fill();

    if (me) {
      // Bridges for ruggers.
      if (me.role === 'rugger') {
        for (const v of VENTS) {
          const inThis = me.ventId === v.id;
          g.strokeStyle = inThis ? '#ffffff' : '#9945ff';
          g.fillStyle = 'rgba(153,69,255,0.35)';
          g.lineWidth = inThis ? 2.5 : 1.5;
          g.beginPath();
          g.arc(sx(v.x), sx(v.y), rad * 1.2, 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }
      }
      // Undone tasks (hidden for holders during RPC DOWN).
      const hidden = snap.taskProgress === -1 && me.role === 'holder';
      if (!hidden) {
        for (const task of me.tasks) {
          if (task.done) continue;
          const st = stationById(task.stationId);
          if (!st) continue;
          const x = sx(st.x);
          const y = sx(st.y);
          const r = rad * (1.1 + 0.25 * pulse);
          g.fillStyle = '#ffd400';
          g.shadowColor = '#ffd400';
          g.shadowBlur = 8;
          g.beginPath();
          g.moveTo(x, y - r);
          g.lineTo(x + r, y);
          g.lineTo(x, y + r);
          g.lineTo(x - r, y);
          g.closePath();
          g.fill();
          g.shadowBlur = 0;
        }
      }
      // Sabotage fix stations.
      const sab = snap.sabotage;
      if (sab) {
        for (const sv of sab.stations) {
          const st = SABOTAGE_STATIONS.find((s) => s.id === sv.id);
          if (!st || sv.fixed) continue;
          const x = sx(st.x);
          const y = sx(st.y);
          g.strokeStyle = `rgba(255,59,92,${0.4 + 0.6 * pulse})`;
          g.lineWidth = 2.5;
          g.beginPath();
          g.arc(x, y, rad * (1.6 + pulse * 1.4), 0, Math.PI * 2);
          g.stroke();
          g.fillStyle = '#ff3b5c';
          g.beginPath();
          g.arc(x, y, rad * 1.2, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#fff';
          g.font = `${Math.max(8, fs * 0.8)}px Bungee, sans-serif`;
          g.fillText(sab.kind === 'devDump' ? `BUY WALL${sv.holders !== undefined ? ` ${sv.holders}` : ''}` : SABOTAGE_TITLES[sab.kind], x, y - rad * 3.4);
          g.font = `${fs}px Bungee, sans-serif`;
        }
      }
      // You.
      const pos = safePos();
      if (pos) {
        const mine = snap.players.find((p) => p.id === me.id);
        const col = colorOf(mine?.color ?? core.who(me.id)?.color ?? 0);
        const x = sx(pos.x);
        const y = sx(pos.y);
        g.fillStyle = hexA(col.body, 0.25 + 0.25 * pulse);
        g.beginPath();
        g.arc(x, y, rad * (2.2 + pulse), 0, Math.PI * 2);
        g.fill();
        g.fillStyle = col.body;
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, rad * 1.3, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
  }

  function safePos(): { x: number; y: number } | null {
    try {
      const p = ctx.game.getSelfPosition();
      if (p) return p;
    } catch {
      /* game not ready */
    }
    const me = ctx.store.snap?.me;
    return me ? { x: me.x, y: me.y } : null;
  }

  function show(): void {
    if (open) return;
    open = true;
    renderLegend();
    layer.append(el);
    el.classList.remove('is-leaving');
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function close(): void {
    if (!open) return;
    open = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    el.remove();
  }

  // Keep the legend in sync with sabotage changes while open.
  ctx.store.onEvent((ev) => {
    if (open && (ev.kind === 'sabotageStarted' || ev.kind === 'sabotageFixed')) renderLegend();
  });

  return {
    toggle(force) {
      const want = force ?? !open;
      if (want) show();
      else close();
    },
    isOpen: () => open,
    close,
  };
}
