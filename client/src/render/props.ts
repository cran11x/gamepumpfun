// Procedural props. Each prop with height is pre-rendered once into its own sprite canvas
// (so it can be Y-sorted with players), plus an optional cheap per-frame animation overlay
// (monitor candles, rack LEDs, furnace flames, ...). The pool is flat: its basin lives in the
// static layer and its water is animated here.

import { TILE } from '../../../shared/constants';
import { PROPS, roomAt, type PropDef, type PropKind } from '../../../shared/map';
import { COLORS, FONT_MONO, FONT_TITLE, mixHex, rgba } from './palette';
import { clamp, createCanvas, fillRR, get2d, hash01, mulberry32, rrect, strokeRR, TAU } from './util';

type G = CanvasRenderingContext2D;

export interface PropAnimState {
  /** The local player can press the SPACES button right now. */
  emergencyHot: boolean;
}

export interface PropSprite {
  def: PropDef;
  kind: PropKind;
  canvas: HTMLCanvasElement;
  /** World-space rectangle covered by the sprite image. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Footprint bottom edge: the Y-sort key. */
  sortY: number;
  /** Optional per-frame overlay, drawn in world space right after the sprite. */
  anim: ((g: G, t: number, st: PropAnimState) => void) | null;
}

const PAD = 14;

const OVERHANG: Record<PropKind, number> = {
  spacesTable: 18,
  tradingDesk: 26,
  serverRack: 30,
  pool: 0,
  vaultSafe: 50,
  memeBoard: 46,
  couch: 18,
  ringLight: 48,
  furnace: 88,
  plant: 32,
};

const TICKER_TEXT = 'GM  ▲  WAGMI  ▲  100X  ▲  LFG  ▲  DEV IS SUS  ▲  HODL  ▲  SEND IT  ▲  GRADUATING SOON  ▲  ';

function drawShadow(g: G, x: number, y: number, w: number, h: number, r: number, alpha: number): void {
  g.save();
  g.shadowColor = `rgba(0,0,0,${alpha})`;
  g.shadowBlur = 14;
  g.shadowOffsetY = 6;
  fillRR(g, x, y, w, h, r, `rgba(0,0,0,${alpha * 0.7})`);
  g.restore();
}

// ---------- trading desk ----------

interface MonitorAnchor {
  x: number;
  sy: number;
  sh: number;
  v: number;
  seed: number;
}

function drawTradingDesk(g: G, fw: number, fh: number, accent: string, rnd: () => number, mons: MonitorAnchor[]): void {
  drawShadow(g, 2, 4, fw - 4, fh - 2, 6, 0.5);
  const topY = -6;
  const topH = 32;
  const face = g.createLinearGradient(0, topY + topH - 6, 0, fh);
  face.addColorStop(0, '#171e2a');
  face.addColorStop(1, '#0b0f16');
  fillRR(g, 0, topY + topH - 6, fw, fh - (topY + topH - 6), 4, face);
  const n = Math.max(1, Math.round(fw / TILE));
  const slot = fw / n;
  // Drawer seams on the front face.
  g.fillStyle = 'rgba(0,0,0,0.4)';
  for (let i = 1; i < n; i++) g.fillRect(i * slot - 0.5, topY + topH, 1, fh - topY - topH - 2);
  g.fillStyle = rgba(accent, 0.18);
  g.fillRect(6, fh - 6, fw - 12, 1);

  const top = g.createLinearGradient(0, topY, 0, topY + topH);
  top.addColorStop(0, '#2a3446');
  top.addColorStop(1, '#1b2331');
  fillRR(g, 0, topY, fw, topH, 5, top);
  strokeRR(g, 0.5, topY + 0.5, fw - 1, topH - 1, 5, 'rgba(255,255,255,0.08)', 1);
  g.fillStyle = rgba(accent, 0.6);
  g.fillRect(4, topY + topH - 2, fw - 8, 1.5);

  for (let i = 0; i < n; i++) {
    const cx = slot * (i + 0.5);
    // Stand.
    g.fillStyle = '#0a0d13';
    g.fillRect(cx - 2, -3, 4, 8);
    g.beginPath();
    g.ellipse(cx, 5, 7, 2.4, 0, 0, TAU);
    g.fill();
    // Bezel + screen.
    fillRR(g, cx - 16, -24, 32, 22, 3, '#090c12');
    strokeRR(g, cx - 16, -24, 32, 22, 3, '#2c384a', 1);
    const sx = cx - 14;
    const sy = -22;
    const sw = 28;
    const sh = 18;
    fillRR(g, sx, sy, sw, sh, 1.5, '#03080d');
    g.fillStyle = rgba(accent, 0.07);
    g.fillRect(sx, sy, sw, sh);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(sx, sy + sh / 3, sw, 0.6);
    g.fillRect(sx, sy + (2 * sh) / 3, sw, 0.6);
    // Candle chart (the last candle is live, see the anim).
    let v = 0.3 + rnd() * 0.3;
    const yOf = (val: number) => sy + sh - 2 - val * (sh - 4);
    for (let k = 0; k < 5; k++) {
      const x = sx + 3 + k * 4;
      const open = v;
      v = clamp(v + (rnd() - 0.4) * 0.3, 0.05, 0.95);
      const up = v >= open;
      const y0 = yOf(open);
      const y1 = yOf(v);
      g.fillStyle = up ? COLORS.pump : COLORS.rug;
      g.fillRect(x - 0.3, Math.min(y0, y1) - 1.5, 0.6, Math.abs(y1 - y0) + 3);
      g.fillRect(x - 1.2, Math.min(y0, y1), 2.4, Math.max(1, Math.abs(y1 - y0)));
    }
    mons.push({ x: sx + 23, sy, sh, v, seed: rnd() });
    // Glare.
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(sx + 12, sy);
    g.lineTo(sx, sy + 10);
    g.closePath();
    g.fill();
    // Keyboard.
    fillRR(g, cx - 11, 9, 22, 7, 1.5, '#0d1219');
    g.fillStyle = 'rgba(255,255,255,0.13)';
    for (let r = 0; r < 2; r++) for (let k = 0; k < 7; k++) g.fillRect(cx - 9.5 + k * 2.8, 10.5 + r * 2.4, 1.6, 1.2);
    // Mug or phone.
    if (rnd() < 0.5) {
      g.beginPath();
      g.arc(cx + 14.5, 13, 3.4, 0, TAU);
      g.fillStyle = '#e8eef5';
      g.fill();
      g.beginPath();
      g.arc(cx + 14.5, 13, 2.3, 0, TAU);
      g.fillStyle = '#3a2414';
      g.fill();
    } else {
      fillRR(g, cx + 11.5, 8.5, 5.5, 9.5, 1.2, '#0b0f15');
      g.fillStyle = rgba(accent, 0.5);
      g.fillRect(cx + 12.3, 9.6, 3.9, 7);
    }
  }
}

function animTradingDesk(g: G, t: number, mons: MonitorAnchor[]): void {
  for (const m of mons) {
    const ph = t * 0.9 + m.seed * 10;
    const v = clamp(m.v + Math.sin(ph) * 0.22 + Math.sin(ph * 2.7) * 0.08, 0.05, 0.95);
    const up = v >= m.v;
    const y0 = m.sy + m.sh - 2 - m.v * (m.sh - 4);
    const y1 = m.sy + m.sh - 2 - v * (m.sh - 4);
    const top = Math.min(y0, y1);
    const hgt = Math.max(1, Math.abs(y1 - y0));
    g.fillStyle = up ? COLORS.pump : COLORS.rug;
    g.fillRect(m.x - 0.3, top - 1.5, 0.6, hgt + 3);
    g.fillRect(m.x - 1.2, top, 2.4, hgt);
    if (Math.sin(t * 5 + m.seed * 9) > 0) {
      g.fillStyle = up ? COLORS.pump : COLORS.rug;
      g.fillRect(m.x + 2.2, y1 - 0.5, 1.4, 1);
    }
  }
}

// ---------- server rack ----------

interface Led {
  x: number;
  y: number;
  i: number;
}

function drawServerRack(g: G, fw: number, fh: number, accent: string, leds: Led[]): { barY: number } {
  const H = 28;
  drawShadow(g, 0, 4, fw, fh, 4, 0.55);
  const front = g.createLinearGradient(0, fh - H, 0, fh);
  front.addColorStop(0, '#182030');
  front.addColorStop(1, '#0a0e14');
  g.fillStyle = front;
  g.fillRect(0, fh - H, fw, H);
  g.fillStyle = 'rgba(0,0,0,0.55)';
  for (let k = 0; k < 3; k++) g.fillRect(6, fh - H + 5 + k * 5, fw - 12, 2);
  fillRR(g, 5, fh - 8, fw - 10, 3, 1.5, '#04060a');

  const top = g.createLinearGradient(0, -H, fw, -H);
  top.addColorStop(0, '#263043');
  top.addColorStop(1, '#1a2130');
  g.fillStyle = top;
  g.fillRect(0, -H, fw, fh);
  g.strokeStyle = 'rgba(255,255,255,0.09)';
  g.lineWidth = 1;
  g.strokeRect(0.5, -H + 0.5, fw - 1, fh - 1);
  let i = 0;
  for (let y = -H + 5; y + 6 < fh - H - 2; y += 9) {
    fillRR(g, 4, y, fw - 8, 6, 1.5, '#0e131c');
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(5, y, fw - 10, 0.8);
    g.fillStyle = 'rgba(0,0,0,0.6)';
    for (let gx = 7; gx < fw - 16; gx += 3) g.fillRect(gx, y + 2.5, 1.2, 1.2);
    leds.push({ x: fw - 12, y: y + 2, i: i++ });
    leds.push({ x: fw - 8, y: y + 2, i: i++ });
  }
  g.fillStyle = rgba(accent, 0.45);
  g.fillRect(0, -H, 1.5, fh);
  return { barY: fh - 8 };
}

const LED_COLORS = ['#2bff88', '#2bff88', '#2bff88', '#22e5ff', '#22e5ff', '#ffd400', '#ff3b5c'];

function animServerRack(g: G, t: number, leds: Led[], fw: number, barY: number, seed: number): void {
  for (const l of leds) {
    const k = seed * 31 + l.i;
    const rate = 1.2 + hash01(k * 3) * 5;
    const on = hash01(Math.floor(t * rate) * 131 + k * 17) > 0.32;
    const col = LED_COLORS[Math.floor(hash01(k * 7 + 3) * LED_COLORS.length)];
    if (on) {
      g.fillStyle = rgba(col, 0.25);
      g.fillRect(l.x - 1.5, l.y - 1.5, 5.5, 5);
      g.fillStyle = col;
      g.fillRect(l.x, l.y, 2.5, 2);
    } else {
      g.fillStyle = rgba(col, 0.14);
      g.fillRect(l.x, l.y, 2.5, 2);
    }
  }
  // Activity bar on the front face.
  const span = fw - 14;
  const p = (t * 40 + seed * 13) % (span + 10);
  g.fillStyle = rgba('#2f8cff', 0.85);
  g.fillRect(6 + Math.max(0, p - 10), barY + 0.5, Math.min(10, p, span + 10 - p), 2);
}

// ---------- vault safe ----------

function drawVault(g: G, fw: number, fh: number): { dialX: number; dialY: number; faceY: number; faceH: number; ledX: number; ledY: number } {
  const H = 48;
  drawShadow(g, -2, 6, fw + 4, fh, 8, 0.6);
  const front = g.createLinearGradient(0, 0, fw, 0);
  front.addColorStop(0, '#7a5c00');
  front.addColorStop(0.35, '#ffd400');
  front.addColorStop(0.62, '#e0b400');
  front.addColorStop(1, '#6e5200');
  fillRR(g, 0, fh - H, fw, H, 4, front);
  const shade = g.createLinearGradient(0, fh - H, 0, fh);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.38)');
  fillRR(g, 0, fh - H, fw, H, 4, shade);

  const top = g.createLinearGradient(0, -H, 0, fh - H);
  top.addColorStop(0, '#fff07a');
  top.addColorStop(1, '#e3b300');
  fillRR(g, 0, -H, fw, fh, 5, top);
  strokeRR(g, 0.5, -H + 0.5, fw - 1, fh - 1, 5, 'rgba(255,255,255,0.45)', 1);
  strokeRR(g, 6, -H + 6, fw - 12, fh - 12, 4, 'rgba(120,88,0,0.55)', 1.5);
  // Gold bars stacked on top.
  const bar = (x: number, y: number) => {
    g.beginPath();
    g.moveTo(x + 3, y);
    g.lineTo(x + 19, y);
    g.lineTo(x + 22, y + 9);
    g.lineTo(x, y + 9);
    g.closePath();
    g.fillStyle = '#ffcf1a';
    g.fill();
    g.strokeStyle = '#a07a00';
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(x + 4, y + 1.5, 14, 1.2);
  };
  bar(fw - 62, -H + 16);
  bar(fw - 38, -H + 16);
  bar(fw - 50, -H + 7);
  // "$" emblem.
  g.beginPath();
  g.arc(28, -H + fh / 2, 15, 0, TAU);
  g.fillStyle = 'rgba(150,110,0,0.35)';
  g.fill();
  g.strokeStyle = 'rgba(120,88,0,0.7)';
  g.lineWidth = 1.5;
  g.stroke();
  g.font = `16px ${FONT_TITLE}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(110,80,0,0.85)';
  g.fillText('$', 28, -H + fh / 2 + 1);

  // Door on the front face.
  strokeRR(g, 6, fh - H + 5, fw - 12, H - 10, 4, 'rgba(90,64,0,0.85)', 2);
  g.fillStyle = '#5a4300';
  g.fillRect(8, fh - H + 12, 4, 8);
  g.fillRect(8, fh - 20, 4, 8);
  // Rivets.
  g.fillStyle = 'rgba(255,240,170,0.8)';
  for (const [rx, ry] of [
    [12, fh - H + 9],
    [fw - 12, fh - H + 9],
    [12, fh - 9],
    [fw - 12, fh - 9],
  ]) {
    g.beginPath();
    g.arc(rx, ry, 1.6, 0, TAU);
    g.fill();
  }
  // Combination dial.
  const dx = fw / 2 - 14;
  const dy = fh - H / 2;
  const dial = g.createRadialGradient(dx - 4, dy - 4, 1, dx, dy, 14);
  dial.addColorStop(0, '#fff3b0');
  dial.addColorStop(0.6, '#c99a00');
  dial.addColorStop(1, '#6b5000');
  g.beginPath();
  g.arc(dx, dy, 14, 0, TAU);
  g.fillStyle = dial;
  g.fill();
  g.strokeStyle = '#4d3900';
  g.lineWidth = 1.5;
  g.stroke();
  g.strokeStyle = 'rgba(60,44,0,0.8)';
  g.lineWidth = 1;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * TAU;
    const r0 = k % 6 === 0 ? 8.5 : 10.5;
    g.beginPath();
    g.moveTo(dx + Math.cos(a) * r0, dy + Math.sin(a) * r0);
    g.lineTo(dx + Math.cos(a) * 12.5, dy + Math.sin(a) * 12.5);
    g.stroke();
  }
  g.beginPath();
  g.arc(dx, dy, 4.5, 0, TAU);
  g.fillStyle = '#3d2d00';
  g.fill();
  // Handle spokes.
  const hx = fw / 2 + 24;
  g.strokeStyle = '#5a4300';
  g.lineWidth = 3;
  g.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU - Math.PI / 2;
    g.beginPath();
    g.moveTo(hx, dy);
    g.lineTo(hx + Math.cos(a) * 11, dy + Math.sin(a) * 11);
    g.stroke();
  }
  g.beginPath();
  g.arc(hx, dy, 4, 0, TAU);
  g.fillStyle = '#ffe14d';
  g.fill();
  g.strokeStyle = '#5a4300';
  g.lineWidth = 1.2;
  g.stroke();
  // Name plate.
  fillRR(g, fw - 34, fh - 15, 24, 7, 1.5, '#2b2000');
  g.font = `700 5px ${FONT_MONO}`;
  g.fillStyle = '#ffd400';
  g.fillText('DEV', fw - 22, fh - 11.3);
  return { dialX: dx, dialY: dy, faceY: fh - H, faceH: H, ledX: fw - 16, ledY: fh - H + 9 };
}

function animVault(g: G, t: number, fw: number, a: { faceY: number; faceH: number; ledX: number; ledY: number }): void {
  // Locked LED.
  const on = Math.sin(t * 3.2) > -0.2;
  g.fillStyle = on ? COLORS.rug : '#5a1020';
  g.beginPath();
  g.arc(a.ledX, a.ledY, 2, 0, TAU);
  g.fill();
  if (on) {
    g.fillStyle = rgba(COLORS.rug, 0.25);
    g.beginPath();
    g.arc(a.ledX, a.ledY, 4.5, 0, TAU);
    g.fill();
  }
  // Shine sweep across the gold front.
  const cycle = 4.5;
  const p = (t % cycle) / 1.4;
  if (p < 1) {
    g.save();
    g.beginPath();
    rrect(g, 0, a.faceY, fw, a.faceH, 4);
    g.clip();
    const x = -40 + p * (fw + 80);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.beginPath();
    g.moveTo(x, a.faceY);
    g.lineTo(x + 14, a.faceY);
    g.lineTo(x - 6, a.faceY + a.faceH);
    g.lineTo(x - 20, a.faceY + a.faceH);
    g.closePath();
    g.fill();
    g.restore();
  }
}

// ---------- meme board ----------

function drawMemeCard(g: G, i: number, w: number, h: number): void {
  const x = -w / 2;
  const y = -h / 2;
  switch (i % 5) {
    case 0: {
      fillRR(g, x, y, w, h, 2, '#0d1a14');
      g.strokeStyle = COLORS.pump;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(x + 3, y + h - 5);
      g.lineTo(x + 10, y + h - 10);
      g.lineTo(x + 15, y + h - 8);
      g.lineTo(x + 24, y + 9);
      g.stroke();
      // Rocket.
      g.save();
      g.translate(x + 28, y + 7);
      g.rotate(0.6);
      g.fillStyle = '#e8eef5';
      g.beginPath();
      g.moveTo(0, -5);
      g.quadraticCurveTo(3, -1, 2, 4);
      g.lineTo(-2, 4);
      g.quadraticCurveTo(-3, -1, 0, -5);
      g.fill();
      g.fillStyle = COLORS.rug;
      g.fillRect(-1, 4, 2, 2.5);
      g.restore();
      break;
    }
    case 1: {
      fillRR(g, x, y, w, h, 2, '#ffd400');
      g.font = `13px ${FONT_TITLE}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#1a1400';
      g.fillText('GM', 0, 1);
      break;
    }
    case 2: {
      fillRR(g, x, y, w, h, 2, '#ff4fd8');
      // Pill face with shades.
      g.save();
      g.beginPath();
      rrect(g, -7, -11, 14, 22, 7);
      g.clip();
      g.fillStyle = '#f2f4f7';
      g.fillRect(-7, -11, 14, 22);
      g.fillStyle = '#2bff88';
      g.fillRect(-7, -11, 14, 11);
      g.restore();
      g.fillStyle = '#05070a';
      fillRR(g, -6.5, -6, 5.5, 3, 1, '#05070a');
      fillRR(g, 1, -6, 5.5, 3, 1, '#05070a');
      g.fillRect(-1, -5.3, 2, 1);
      break;
    }
    case 3: {
      fillRR(g, x, y, w, h, 2, '#2bff88');
      g.font = `11px ${FONT_TITLE}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#052814';
      g.fillText('100x', 0, 1);
      break;
    }
    default: {
      fillRR(g, x, y, w, h, 2, '#141b3a');
      g.beginPath();
      g.arc(-6, -2, 7, 0, TAU);
      g.fillStyle = '#f5f0c8';
      g.fill();
      g.beginPath();
      g.arc(-3.5, -4, 6, 0, TAU);
      g.fillStyle = '#141b3a';
      g.fill();
      g.font = `700 6px ${FONT_MONO}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#ffd400';
      g.fillText('WAGMI', 4, 9);
      break;
    }
  }
}

function drawMemeBoard(g: G, fw: number, accent: string, rnd: () => number): { sx: number; sy: number; sw: number; sh: number } {
  drawShadow(g, 4, 8, fw - 8, 28, 6, 0.5);
  fillRR(g, 0, 16, fw, 22, 4, '#0d1219');
  fillRR(g, 0, 6, fw, 14, 4, '#1f2836');
  g.fillStyle = rgba(accent, 0.55);
  g.fillRect(4, 19, fw - 8, 1.2);
  const bx = 8;
  const by = -44;
  const bw = fw - 16;
  const bh = 52;
  g.fillStyle = '#2a3343';
  g.fillRect(bx + 16, by + bh - 4, 5, 12);
  g.fillRect(bx + bw - 21, by + bh - 4, 5, 12);
  g.save();
  g.shadowColor = accent;
  g.shadowBlur = 10;
  fillRR(g, bx, by, bw, bh, 5, '#0a0f15');
  g.restore();
  strokeRR(g, bx, by, bw, bh, 5, accent, 2);
  g.font = `7px ${FONT_TITLE}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = rgba(accent, 0.85);
  g.fillText('MEME BOARD', bx + 6, by + 6.5);
  g.textAlign = 'right';
  g.fillStyle = rgba(COLORS.rug, 0.9);
  g.font = `700 6px ${FONT_MONO}`;
  g.fillText('● TRENDING', bx + bw - 6, by + 6.5);
  const cards = 5;
  const cw = 36;
  const ch = 26;
  const gap = (bw - 12 - cards * cw) / (cards - 1);
  for (let i = 0; i < cards; i++) {
    const x = bx + 6 + i * (cw + gap);
    const y = by + 12 + (rnd() - 0.5) * 3;
    g.save();
    g.translate(x + cw / 2, y + ch / 2);
    g.rotate((rnd() - 0.5) * 0.14);
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = 3;
    g.shadowOffsetY = 1;
    drawMemeCard(g, i, cw, ch);
    g.shadowBlur = 0;
    g.beginPath();
    g.arc(0, -ch / 2 + 2, 1.8, 0, TAU);
    g.fillStyle = i % 2 ? COLORS.rug : '#22e5ff';
    g.fill();
    g.restore();
  }
  const strip = { sx: bx + 6, sy: by + bh - 9, sw: bw - 12, sh: 6.5 };
  fillRR(g, strip.sx, strip.sy, strip.sw, strip.sh, 2, '#030605');
  return strip;
}

let tickerWidth = 0;
let tickerFont = '';

function animMemeBoard(g: G, t: number, accent: string, s: { sx: number; sy: number; sw: number; sh: number }): void {
  g.save();
  g.beginPath();
  g.rect(s.sx, s.sy, s.sw, s.sh);
  g.clip();
  const font = `700 5px ${FONT_MONO}`;
  g.font = font;
  if (tickerFont !== font || tickerWidth === 0) {
    tickerWidth = g.measureText(TICKER_TEXT).width;
    tickerFont = font;
  }
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = accent;
  const off = (t * 16) % tickerWidth;
  const y = s.sy + s.sh / 2 + 0.3;
  for (let x = s.sx - off; x < s.sx + s.sw; x += tickerWidth) g.fillText(TICKER_TEXT, x, y);
  g.restore();
}

// ---------- couch ----------

function drawCouch(g: G, fw: number, fh: number, color: string, accent: string, rnd: () => number): void {
  const dark = mixHex(color, '#000000', 0.5);
  const mid = mixHex(color, '#000000', 0.28);
  drawShadow(g, 0, 8, fw, fh - 6, 10, 0.55);
  fillRR(g, 0, -18, fw, 26, 9, dark);
  fillRR(g, 3, -16, fw - 6, 5, 3, rgba('#ffffff', 0.08));
  fillRR(g, 4, 0, fw - 8, 26, 7, color);
  const k = Math.max(2, Math.round(fw / 40));
  for (let i = 0; i < k; i++) {
    const cx0 = 4 + ((fw - 8) * i) / k;
    fillRR(g, cx0 + 1.5, 2, (fw - 8) / k - 3, 8, 4, rgba('#ffffff', 0.09));
    if (i > 0) {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(cx0 - 0.6, 3, 1.2, 21);
    }
  }
  fillRR(g, 3, 24, fw - 6, 14, 5, mid);
  fillRR(g, 3, 24, fw - 6, 3, 2, rgba('#000000', 0.25));
  // Armrests.
  for (const ax of [-3, fw - 8]) {
    fillRR(g, ax, -10, 11, 46, 6, mid);
    fillRR(g, ax + 1.5, -9, 8, 6, 3, rgba('#ffffff', 0.12));
  }
  // Throw pillow.
  g.save();
  g.translate(16 + rnd() * (fw - 32), 4);
  g.rotate((rnd() - 0.5) * 0.6);
  fillRR(g, -7, -7, 14, 12, 4, accent);
  fillRR(g, -5, -6, 10, 3, 2, 'rgba(255,255,255,0.3)');
  g.restore();
}

// ---------- ring light ----------

function drawRingLight(g: G, fw: number, fh: number, accent: string): { cx: number; cy: number; r: number } {
  const cx = fw / 2;
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.beginPath();
  g.ellipse(cx, fh - 12, 30, 8, 0, 0, TAU);
  g.fill();
  g.strokeStyle = '#2b3242';
  g.lineWidth = 3;
  g.lineCap = 'round';
  const hubY = fh - 36;
  g.beginPath();
  g.moveTo(cx, hubY);
  g.lineTo(cx - 26, fh - 8);
  g.moveTo(cx, hubY);
  g.lineTo(cx + 26, fh - 8);
  g.moveTo(cx, hubY);
  g.lineTo(cx + 3, fh - 3);
  g.stroke();
  g.fillStyle = '#11151d';
  for (const [x, y] of [
    [cx - 26, fh - 8],
    [cx + 26, fh - 8],
    [cx + 3, fh - 3],
  ]) {
    g.beginPath();
    g.arc(x, y, 2.5, 0, TAU);
    g.fill();
  }
  g.strokeStyle = '#3a4357';
  g.lineWidth = 3.5;
  g.beginPath();
  g.moveTo(cx, hubY);
  g.lineTo(cx, -10);
  g.stroke();
  const ry = -12;
  const R = 28;
  g.save();
  g.shadowColor = accent;
  g.shadowBlur = 20;
  g.strokeStyle = '#232a38';
  g.lineWidth = 10;
  g.beginPath();
  g.arc(cx, ry, R, 0, TAU);
  g.stroke();
  g.restore();
  g.strokeStyle = '#fff3fd';
  g.lineWidth = 5.5;
  g.beginPath();
  g.arc(cx, ry, R, 0, TAU);
  g.stroke();
  g.strokeStyle = rgba(accent, 0.6);
  g.lineWidth = 1.2;
  g.beginPath();
  g.arc(cx, ry, R + 3.5, 0, TAU);
  g.stroke();
  // Phone clamp + phone.
  g.strokeStyle = '#3a4357';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(cx, ry + R - 2);
  g.lineTo(cx, ry + 12);
  g.stroke();
  fillRR(g, cx - 7.5, ry - 12, 15, 25, 3, '#0b0f15');
  const scr = g.createLinearGradient(0, ry - 10, 0, ry + 11);
  scr.addColorStop(0, '#ff4fd8');
  scr.addColorStop(1, '#5f22b3');
  fillRR(g, cx - 6, ry - 10.5, 12, 21.5, 2, scr);
  return { cx, cy: ry, r: R };
}

// ---------- furnace ----------

interface FurnaceAnchors {
  mx: number;
  my: number;
  mw: number;
  mh: number;
  chimX: number;
  chimY: number;
}

function mouthPath(g: G, mx: number, my: number, mw: number, mh: number): void {
  const r = 14;
  g.beginPath();
  g.moveTo(mx, my + mh);
  g.lineTo(mx, my + r);
  g.arcTo(mx, my, mx + r, my, r);
  g.lineTo(mx + mw - r, my);
  g.arcTo(mx + mw, my, mx + mw, my + r, r);
  g.lineTo(mx + mw, my + mh);
  g.closePath();
}

function drawFurnace(g: G, fw: number, fh: number): FurnaceAnchors {
  const H = 58;
  drawShadow(g, -4, 6, fw + 8, fh, 8, 0.6);
  const front = g.createLinearGradient(0, fh - H, 0, fh);
  front.addColorStop(0, '#2e3440');
  front.addColorStop(1, '#14171d');
  fillRR(g, 0, fh - H, fw, H, 4, front);
  // Hazard stripes at the base.
  g.save();
  g.beginPath();
  g.rect(2, fh - 9, fw - 4, 7);
  g.clip();
  g.fillStyle = '#1a1a1a';
  g.fillRect(0, fh - 9, fw, 9);
  g.strokeStyle = '#ffd400';
  g.lineWidth = 4;
  g.beginPath();
  for (let d = -10; d < fw + 10; d += 10) {
    g.moveTo(d, fh - 2);
    g.lineTo(d + 7, fh - 9);
  }
  g.stroke();
  g.restore();
  // Mouth.
  const mx = 24;
  const my = fh - H + 10;
  const mw = fw - 48;
  const mh = H - 22;
  mouthPath(g, mx, my, mw, mh);
  g.fillStyle = '#0b0302';
  g.fill();
  g.strokeStyle = '#4b3a30';
  g.lineWidth = 3.5;
  g.stroke();
  g.fillStyle = '#6b5446';
  for (let k = 0; k < 7; k++) {
    const px = mx + (mw * k) / 6;
    g.beginPath();
    g.arc(px, my - 4.5, 1.4, 0, TAU);
    g.fill();
  }
  // Top face.
  const top = g.createLinearGradient(0, -H, 0, fh - H);
  top.addColorStop(0, '#3c4350');
  top.addColorStop(1, '#2a2f39');
  fillRR(g, 0, -H, fw, fh, 6, top);
  strokeRR(g, 0.5, -H + 0.5, fw - 1, fh - 1, 6, 'rgba(255,255,255,0.1)', 1);
  // Grates.
  g.fillStyle = 'rgba(0,0,0,0.45)';
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) fillRR(g, 12 + k * 13, -H + 40 + r * 13, 9, 7, 1.5, 'rgba(0,0,0,0.45)');
  // Gauge.
  g.beginPath();
  g.arc(24, -H + 20, 9, 0, TAU);
  g.fillStyle = '#e8eef5';
  g.fill();
  g.strokeStyle = '#1b1f26';
  g.lineWidth = 2;
  g.stroke();
  g.strokeStyle = COLORS.rug;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(24, -H + 20);
  g.lineTo(30, -H + 15);
  g.stroke();
  // "BURN" stencil on the front lip of the top face.
  g.font = `11px ${FONT_TITLE}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = rgba('#ff9f1c', 0.85);
  g.fillText('BURN', fw / 2, fh - H - 9);
  // Chimney.
  const chimX = fw * 0.72;
  const cw = 26;
  const cTop = -H - 28;
  const cBot = -H + 26;
  const pipe = g.createLinearGradient(chimX - cw / 2, 0, chimX + cw / 2, 0);
  pipe.addColorStop(0, '#1b1f26');
  pipe.addColorStop(0.45, '#4a5262');
  pipe.addColorStop(1, '#1b1f26');
  g.fillStyle = pipe;
  g.fillRect(chimX - cw / 2, cTop, cw, cBot - cTop);
  g.beginPath();
  g.ellipse(chimX, cBot, cw / 2, 5, 0, 0, Math.PI);
  g.fill();
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(chimX - cw / 2, cTop + 14, cw, 3);
  g.fillRect(chimX - cw / 2, cTop + 34, cw, 3);
  g.beginPath();
  g.ellipse(chimX, cTop, cw / 2, 5, 0, 0, TAU);
  g.fillStyle = '#5a6374';
  g.fill();
  g.beginPath();
  g.ellipse(chimX, cTop, cw / 2 - 3, 3.3, 0, 0, TAU);
  g.fillStyle = '#0a0b0d';
  g.fill();
  return { mx, my, mw, mh, chimX, chimY: cTop };
}

const FLAME_LAYERS = [
  { color: '#c81e1e', scale: 1.0, width: 1.0 },
  { color: '#ff6a00', scale: 0.82, width: 0.8 },
  { color: '#ffb000', scale: 0.6, width: 0.6 },
  { color: '#fff2b0', scale: 0.35, width: 0.4 },
];

function animFurnace(g: G, t: number, a: FurnaceAnchors, glowRef: { grad: CanvasGradient | null; owner: G | null }): void {
  const bottom = a.my + a.mh;
  // Heat glow.
  if (!glowRef.grad || glowRef.owner !== g) {
    const cx = a.mx + a.mw / 2;
    const grad = g.createRadialGradient(cx, bottom - 6, 4, cx, bottom - 6, 110);
    grad.addColorStop(0, 'rgba(255,150,40,0.45)');
    grad.addColorStop(0.4, 'rgba(255,90,20,0.16)');
    grad.addColorStop(1, 'rgba(255,60,0,0)');
    glowRef.grad = grad;
    glowRef.owner = g;
  }
  const flicker = 0.75 + 0.15 * Math.sin(t * 13) + 0.1 * Math.sin(t * 29 + 1);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = flicker;
  g.fillStyle = glowRef.grad;
  g.fillRect(a.mx - 110, bottom - 116, a.mw + 220, 230);
  g.restore();
  // Flames inside the mouth.
  g.save();
  mouthPath(g, a.mx + 2, a.my + 2, a.mw - 4, a.mh - 2);
  g.clip();
  const tongues = 7;
  for (const layer of FLAME_LAYERS) {
    g.fillStyle = layer.color;
    g.beginPath();
    for (let i = 0; i < tongues; i++) {
      const x = a.mx + ((i + 0.5) * a.mw) / tongues;
      const n = Math.sin(t * 7.3 + i * 1.7) * 0.5 + Math.sin(t * 11.1 + i * 2.9) * 0.3 + 0.2;
      const h = a.mh * (0.55 + 0.35 * n) * layer.scale;
      const w = (a.mw / tongues) * 1.6 * layer.width;
      const sway = Math.sin(t * 5 + i) * 3;
      g.moveTo(x - w / 2, bottom);
      g.quadraticCurveTo(x - w * 0.5, bottom - h * 0.55, x + sway, bottom - h);
      g.quadraticCurveTo(x + w * 0.5, bottom - h * 0.55, x + w / 2, bottom);
    }
    g.fill();
  }
  g.restore();
  // Embers rising out of the mouth.
  for (let i = 0; i < 9; i++) {
    const ph = (t * (0.45 + hash01(i * 7) * 0.4) + hash01(i * 13)) % 1;
    const x = a.mx + a.mw * (0.15 + 0.7 * hash01(i * 3)) + Math.sin(ph * 6 + i) * 6;
    const y = a.my + 6 - ph * 70;
    g.fillStyle = rgba(ph < 0.5 ? '#ffb000' : '#ff6a00', 0.9 * (1 - ph));
    g.fillRect(x, y, 1.8, 1.8);
  }
  // Chimney smoke.
  for (let i = 0; i < 4; i++) {
    const ph = (t * 0.32 + i / 4) % 1;
    const x = a.chimX + Math.sin(ph * 3 + i * 2) * 8 + ph * 10;
    const y = a.chimY - 4 - ph * 52;
    g.fillStyle = rgba('#9aa6b5', 0.16 * (1 - ph));
    g.beginPath();
    g.arc(x, y, 5 + ph * 11, 0, TAU);
    g.fill();
  }
}

// ---------- plant ----------

function drawPlant(g: G, fw: number, fh: number, accent: string, rnd: () => number): void {
  const cx = fw / 2;
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.beginPath();
  g.ellipse(cx, fh - 4, 15, 5, 0, 0, TAU);
  g.fill();
  const pot = g.createLinearGradient(cx - 12, 0, cx + 12, 0);
  pot.addColorStop(0, '#222833');
  pot.addColorStop(0.4, '#3f4858');
  pot.addColorStop(1, '#1d222b');
  g.beginPath();
  g.moveTo(cx - 12, fh - 22);
  g.lineTo(cx + 12, fh - 22);
  g.lineTo(cx + 9, fh - 3);
  g.lineTo(cx - 9, fh - 3);
  g.closePath();
  g.fillStyle = pot;
  g.fill();
  g.fillStyle = rgba(accent, 0.55);
  g.fillRect(cx - 11, fh - 15, 22, 1.5);
  fillRR(g, cx - 14, fh - 26, 28, 6, 3, '#4b5468');
  g.beginPath();
  g.ellipse(cx, fh - 24, 11, 2.6, 0, 0, TAU);
  g.fillStyle = '#2a1c12';
  g.fill();
  const greens = ['#1d7a45', '#24a05a', '#2fc46d', '#3ade7f'];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const order = i % 2 === 0 ? i / 2 : n - 1 - (i - 1) / 2; // outer leaves first
    const angle = -Math.PI / 2 + (order - (n - 1) / 2) * 0.33 + (rnd() - 0.5) * 0.2;
    const len = 16 + rnd() * 13 - Math.abs(order - (n - 1) / 2) * 1.2;
    g.save();
    g.translate(cx, fh - 25);
    g.rotate(angle);
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(len * 0.5, -len * 0.34, len, 0);
    g.quadraticCurveTo(len * 0.5, len * 0.34, 0, 0);
    g.fillStyle = greens[Math.floor(rnd() * greens.length)];
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(1, 0);
    g.lineTo(len * 0.85, 0);
    g.stroke();
    g.restore();
  }
}

// ---------- SPACES table ----------

function drawMic(g: G, x: number, y: number): void {
  g.fillStyle = 'rgba(0,0,0,0.4)';
  g.beginPath();
  g.ellipse(x, y + 5, 5, 2, 0, 0, TAU);
  g.fill();
  g.strokeStyle = '#596379';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(x, y + 4);
  g.lineTo(x, y - 1);
  g.stroke();
  fillRR(g, x - 2.6, y - 8, 5.2, 8, 2.6, '#1b2130');
  strokeRR(g, x - 2.6, y - 8, 5.2, 8, 2.6, '#8a95ab', 1);
}

function drawSpacesTable(g: G, fw: number, fh: number, accent: string): { bx: number; by: number } {
  const H = 14;
  const ty = -H;
  const th = fh - 6;
  drawShadow(g, 6, 14, fw - 12, fh - 12, 40, 0.55);
  // Pedestal and table edge.
  fillRR(g, fw / 2 - 20, th - 24, 40, 24, 6, '#080b10');
  fillRR(g, 0, ty + H, fw, th, 44, '#0a0e14');
  strokeRR(g, 0.5, ty + H + 0.5, fw - 1, th - 1, 44, rgba(accent, 0.22), 1);
  const top = g.createLinearGradient(0, ty, 0, ty + th);
  top.addColorStop(0, '#223044');
  top.addColorStop(1, '#121a26');
  fillRR(g, 0, ty, fw, th, 44, top);
  g.save();
  g.shadowColor = accent;
  g.shadowBlur = 12;
  strokeRR(g, 1.5, ty + 1.5, fw - 3, th - 3, 42, rgba(accent, 0.85), 2.5);
  g.restore();
  strokeRR(g, 16, ty + 14, fw - 32, th - 28, 30, 'rgba(255,255,255,0.06)', 1.5);
  fillRR(g, 30, ty + 6, fw - 60, 8, 4, 'rgba(255,255,255,0.05)');
  // Mics around the table.
  const midY = ty + th / 2;
  drawMic(g, 22, midY);
  drawMic(g, fw - 22, midY);
  drawMic(g, fw / 2 - 44, ty + 20);
  drawMic(g, fw / 2 + 44, ty + 20);
  drawMic(g, fw / 2 - 44, ty + th - 18);
  drawMic(g, fw / 2 + 44, ty + th - 18);
  // Branding.
  g.font = `9px ${FONT_TITLE}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = rgba(accent, 0.85);
  g.fillText('X SPACES', fw / 2, ty + th - 13);
  // The big red button.
  const bx = fw / 2;
  const by = midY - 6;
  g.beginPath();
  g.arc(bx, by + 2, 23, 0, TAU);
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fill();
  g.beginPath();
  g.arc(bx, by, 22, 0, TAU);
  g.fillStyle = '#1a0a10';
  g.fill();
  g.strokeStyle = rgba(COLORS.rug, 0.55);
  g.lineWidth = 2;
  g.stroke();
  // Hazard ring.
  g.save();
  g.beginPath();
  g.arc(bx, by, 21, 0, TAU);
  g.arc(bx, by, 18, 0, TAU, true);
  g.clip();
  g.strokeStyle = '#ffd400';
  g.lineWidth = 2.4;
  g.beginPath();
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU;
    g.moveTo(bx + Math.cos(a) * 17, by + Math.sin(a) * 17);
    g.lineTo(bx + Math.cos(a + 0.25) * 22, by + Math.sin(a + 0.25) * 22);
  }
  g.stroke();
  g.restore();
  const dome = g.createRadialGradient(bx - 5, by - 6, 1, bx, by, 16);
  dome.addColorStop(0, '#ffa3b3');
  dome.addColorStop(0.45, COLORS.rug);
  dome.addColorStop(1, '#8e0f28');
  g.beginPath();
  g.arc(bx, by, 16, 0, TAU);
  g.fillStyle = dome;
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.beginPath();
  g.ellipse(bx - 5, by - 7, 6, 3.2, -0.45, 0, TAU);
  g.fill();
  return { bx, by };
}

function animSpacesTable(g: G, t: number, bx: number, by: number, hot: boolean): void {
  const pulse = (Math.sin(t * (hot ? 6 : 2.2)) + 1) / 2;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = rgba(COLORS.rug, hot ? 0.35 + pulse * 0.45 : 0.08 + pulse * 0.12);
  g.lineWidth = hot ? 4 : 3;
  g.beginPath();
  g.arc(bx, by, 25 + pulse * (hot ? 9 : 4), 0, TAU);
  g.stroke();
  if (hot) {
    g.fillStyle = rgba(COLORS.rug, 0.12 + pulse * 0.12);
    g.beginPath();
    g.arc(bx, by, 17, 0, TAU);
    g.fill();
  }
  g.restore();
}

function animRingLight(g: G, t: number, cx: number, cy: number, r: number, accent: string): void {
  const pulse = 0.65 + 0.35 * Math.sin(t * 1.8);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = rgba(accent, 0.18 * pulse);
  g.lineWidth = 14;
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.stroke();
  g.strokeStyle = rgba('#ffffff', 0.25 * pulse);
  g.lineWidth = 3;
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.stroke();
  g.restore();
  // LIVE dot on the phone.
  if (Math.sin(t * 4) > -0.3) {
    g.fillStyle = COLORS.rug;
    g.beginPath();
    g.arc(cx, cy - 7, 1.8, 0, TAU);
    g.fill();
  }
}

// ---------- build ----------

function couchColor(x: number, y: number): string {
  const room = roomAt(x, y);
  if (room?.id === 'telegramHq') return '#2a64c4';
  if (room?.id === 'kolStudio') return '#b4318f';
  return '#5f22b3';
}

export function buildPropSprites(scale: number): PropSprite[] {
  const out: PropSprite[] = [];
  PROPS.forEach((def, idx) => {
    if (def.kind === 'pool') return;
    const over = OVERHANG[def.kind];
    const fw = def.rect.w * TILE;
    const fh = def.rect.h * TILE;
    const w = fw + PAD * 2;
    const h = fh + over + PAD * 2;
    const canvas = createCanvas(w * scale, h * scale);
    const g = get2d(canvas);
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.translate(PAD, PAD + over);
    const fx = def.rect.x * TILE;
    const fy = def.rect.y * TILE;
    const accent = roomAt(fx + fw / 2, fy + fh / 2)?.accent ?? COLORS.pump;
    const seed = idx * 7919 + 13;
    const rnd = mulberry32(seed);
    let anim: PropSprite['anim'] = null;
    // Animations draw in footprint-local coordinates (translated to the footprint origin).
    const local = (fn: (g2: G, t: number, st: PropAnimState) => void): PropSprite['anim'] => (g2, t, st) => {
      g2.save();
      g2.translate(fx, fy);
      fn(g2, t, st);
      g2.restore();
    };
    switch (def.kind) {
      case 'tradingDesk': {
        const mons: MonitorAnchor[] = [];
        drawTradingDesk(g, fw, fh, accent, rnd, mons);
        anim = local((g2, t) => animTradingDesk(g2, t, mons));
        break;
      }
      case 'serverRack': {
        const leds: Led[] = [];
        const { barY } = drawServerRack(g, fw, fh, accent, leds);
        anim = local((g2, t) => animServerRack(g2, t, leds, fw, barY, idx));
        break;
      }
      case 'vaultSafe': {
        const a = drawVault(g, fw, fh);
        anim = local((g2, t) => animVault(g2, t, fw, a));
        break;
      }
      case 'memeBoard': {
        const strip = drawMemeBoard(g, fw, accent, rnd);
        anim = local((g2, t) => animMemeBoard(g2, t, accent, strip));
        break;
      }
      case 'couch':
        drawCouch(g, fw, fh, couchColor(fx + fw / 2, fy + fh / 2), accent === '#ff4fd8' ? '#ffd400' : accent, rnd);
        break;
      case 'ringLight': {
        const r = drawRingLight(g, fw, fh, accent);
        anim = local((g2, t) => animRingLight(g2, t, r.cx, r.cy, r.r, accent));
        break;
      }
      case 'furnace': {
        const a = drawFurnace(g, fw, fh);
        const glowRef: { grad: CanvasGradient | null; owner: G | null } = { grad: null, owner: null };
        anim = local((g2, t) => animFurnace(g2, t, a, glowRef));
        break;
      }
      case 'plant':
        drawPlant(g, fw, fh, accent, rnd);
        break;
      case 'spacesTable': {
        const b = drawSpacesTable(g, fw, fh, accent);
        anim = local((g2, t, st) => animSpacesTable(g2, t, b.bx, b.by, st.emergencyHot));
        break;
      }
      default:
        break;
    }
    out.push({ def, kind: def.kind, canvas, x: fx - PAD, y: fy - over - PAD, w, h, sortY: fy + fh, anim });
  });
  return out;
}

// ---------- pool water (flat, animated) ----------

interface PoolCache {
  owner: G | null;
  grads: CanvasGradient[];
}
const poolCache: PoolCache = { owner: null, grads: [] };
const POOLS = PROPS.filter((p) => p.kind === 'pool');

/** Animated water for every pool prop. `g` has the world transform. Culls by the view rect. */
export function drawPoolWater(g: G, t: number, vx0: number, vy0: number, vx1: number, vy1: number): void {
  if (poolCache.owner !== g) {
    poolCache.owner = g;
    poolCache.grads = POOLS.map((p) => {
      const y = p.rect.y * TILE;
      const h = p.rect.h * TILE;
      const grad = g.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, '#0d7896');
      grad.addColorStop(0.5, '#07486b');
      grad.addColorStop(1, '#04233a');
      return grad;
    });
  }
  POOLS.forEach((p, pi) => {
    const wx = p.rect.x * TILE + 8;
    const wy = p.rect.y * TILE + 8;
    const ww = p.rect.w * TILE - 16;
    const wh = p.rect.h * TILE - 16;
    if (wx > vx1 || wy > vy1 || wx + ww < vx0 || wy + wh < vy0) return;
    g.save();
    g.beginPath();
    rrect(g, wx, wy, ww, wh, 10);
    g.clip();
    g.fillStyle = poolCache.grads[pi];
    g.fillRect(wx, wy, ww, wh);
    // Caustic wave lines.
    g.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const yy = wy + 10 + (i * (wh - 20)) / 5;
      g.beginPath();
      for (let xx = 0; xx <= ww; xx += 14) {
        const yv = yy + Math.sin(xx * 0.035 + t * 1.6 + i * 1.3) * 3 + Math.sin(xx * 0.09 - t * 2.1 + i) * 1.5;
        if (xx === 0) g.moveTo(wx + xx, yv);
        else g.lineTo(wx + xx, yv);
      }
      g.strokeStyle = i % 2 ? 'rgba(130,240,255,0.10)' : 'rgba(200,255,255,0.07)';
      g.stroke();
    }
    // Sparkles.
    for (let i = 0; i < 26; i++) {
      const s = Math.sin(t * 2.6 + i * 1.71);
      if (s < 0.6) continue;
      const a = (s - 0.6) / 0.4;
      g.fillStyle = rgba('#ffffff', 0.7 * a);
      const sx = wx + hash01(i * 11 + pi) * ww;
      const sy = wy + hash01(i * 23 + pi) * wh;
      g.fillRect(sx - 1, sy - 1, 2, 2);
      g.fillRect(sx - 3 * a, sy - 0.25, 6 * a, 0.5);
    }
    // Floating SOL coins and a pill pool float.
    for (let i = 0; i < 4; i++) {
      const cx = wx + ww / 2 + Math.sin(t * 0.13 + i * 2.1) * (ww / 2 - 26);
      const cy = wy + wh / 2 + Math.sin(t * 0.21 + i * 1.3) * (wh / 2 - 18) + Math.sin(t * 2 + i) * 1.2;
      const rip = (t * 0.8 + i * 0.37) % 1;
      g.strokeStyle = rgba('#ffffff', 0.18 * (1 - rip));
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(cx, cy + 2, 10 + rip * 10, 4 + rip * 4, 0, 0, TAU);
      g.stroke();
      if (i === 0) {
        // Inflatable ring.
        g.lineWidth = 6;
        g.strokeStyle = '#ff4fd8';
        g.beginPath();
        g.ellipse(cx, cy, 11, 8, 0, 0, TAU);
        g.stroke();
        g.strokeStyle = '#ffffff';
        g.lineWidth = 6;
        for (let k = 0; k < 4; k++) {
          const a0 = (k / 4) * TAU + t * 0.3;
          g.beginPath();
          g.ellipse(cx, cy, 11, 8, 0, a0, a0 + 0.45);
          g.stroke();
        }
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.ellipse(cx, cy - 1, 9, 6, 0, Math.PI * 1.1, Math.PI * 1.6);
        g.stroke();
      } else {
        g.beginPath();
        g.arc(cx, cy, 7, 0, TAU);
        g.fillStyle = '#141024';
        g.fill();
        g.strokeStyle = '#d6c8ff';
        g.lineWidth = 1;
        g.stroke();
        const bars = [COLORS.solGreen, '#5fb7d4', COLORS.sol];
        for (let k = 0; k < 3; k++) {
          g.fillStyle = bars[k];
          const by = cy - 3 + k * 2.4;
          g.beginPath();
          g.moveTo(cx - 3.2 + (k === 1 ? 1 : 0), by);
          g.lineTo(cx + 4 - (k === 1 ? 0 : 1), by);
          g.lineTo(cx + 3.2 - (k === 1 ? 1 : 0), by + 1.4);
          g.lineTo(cx - 4 + (k === 1 ? 0 : 1), by + 1.4);
          g.closePath();
          g.fill();
        }
      }
    }
    g.restore();
    g.beginPath();
    rrect(g, wx, wy, ww, wh, 10);
    g.strokeStyle = 'rgba(200,250,255,0.18)';
    g.lineWidth = 1.5;
    g.stroke();
  });
}
