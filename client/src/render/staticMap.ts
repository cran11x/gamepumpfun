// Pre-renders everything that never changes (floor, walls, labels, bridge hatches, consoles,
// the pool basin) into one offscreen canvas. Props with height are separate sprites (props.ts)
// so they can be Y-sorted with players.

import { TILE } from '../../../shared/constants';
import {
  CELL_FLOOR,
  CELL_OBSTACLE,
  CELL_WALL,
  EMERGENCY_BUTTON,
  HALLS,
  MAP_H,
  MAP_W,
  PROPS,
  ROOMS,
  SABOTAGE_STATIONS,
  SPAWN_POINTS,
  TASK_STATIONS,
  VENTS,
  WORLD_H,
  WORLD_W,
  cellAt,
  roomAt,
  type RoomDef,
  type RoomId,
} from '../../../shared/map';
import { drawBridgeGlyph, drawFixIcon, drawTaskIcon } from './icons';
import { COLORS, FONT_MONO, FONT_TITLE, rgba } from './palette';
import { createCanvas, fillRR, get2d, hash01, mulberry32, rrect, strokeRR, TAU } from './util';

type G = CanvasRenderingContext2D;

/** Height of a north wall's visible front face, in px. */
export const WALL_FACE = TILE * 0.5;

const FIX_LABELS: Record<string, string> = { fixDump: 'BUY WALL', fixFud: 'FUD FIX', fixRpc: 'RPC FIX' };

function isFloorish(tx: number, ty: number): boolean {
  const c = cellAt(tx, ty);
  return c === CELL_FLOOR || c === CELL_OBSTACLE;
}

function roomOfTile(tx: number, ty: number): RoomDef | null {
  return roomAt((tx + 0.5) * TILE, (ty + 0.5) * TILE);
}

export function roomAccent(id: RoomId): string {
  return ROOMS.find((r) => r.id === id)?.accent ?? COLORS.hallNeon;
}

function wallAccent(tx: number, ty: number): string {
  const order = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  for (const [dx, dy] of order) {
    if (!isFloorish(tx + dx, ty + dy)) continue;
    const r = roomOfTile(tx + dx, ty + dy);
    if (r) return r.accent;
  }
  return COLORS.hallNeon;
}

export class StaticMap {
  canvas: HTMLCanvasElement | null = null;
  scale = 1;

  render(scale: number): void {
    const c = createCanvas(WORLD_W * scale, WORLD_H * scale);
    const g = get2d(c, { alpha: false });
    g.setTransform(scale, 0, 0, scale, 0, 0);
    drawVoid(g);
    drawFloors(g);
    drawRoomDecor(g);
    drawPoolBasins(g);
    drawAmbientOcclusion(g);
    drawWalls(g);
    drawRoomLabels(g);
    for (const v of VENTS) drawVentHatch(g, v.x, v.y);
    drawTaskConsoles(g);
    drawSabotageConsoles(g);
    this.canvas = c;
    this.scale = scale;
  }

  /** Draws the visible part of the map. `g` must already have the world transform. */
  draw(g: G, x0: number, y0: number, x1: number, y1: number): void {
    const c = this.canvas;
    if (!c) return;
    const s = this.scale;
    const sx0 = Math.max(0, Math.floor(x0 * s));
    const sy0 = Math.max(0, Math.floor(y0 * s));
    const sx1 = Math.min(c.width, Math.ceil(x1 * s));
    const sy1 = Math.min(c.height, Math.ceil(y1 * s));
    if (sx1 <= sx0 || sy1 <= sy0) return;
    g.drawImage(c, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0 / s, sy0 / s, (sx1 - sx0) / s, (sy1 - sy0) / s);
  }
}

// ---------- layers ----------

function drawVoid(g: G): void {
  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, WORLD_W, WORLD_H);
  // Faint terminal dot grid outside the station.
  g.fillStyle = 'rgba(120,150,190,0.05)';
  for (let y = 10; y < WORLD_H; y += 20) {
    for (let x = 10; x < WORLD_W; x += 20) g.fillRect(x, y, 1.2, 1.2);
  }
  // Occasional brighter "data" specks.
  const rnd = mulberry32(77);
  for (let i = 0; i < 260; i++) {
    const x = rnd() * WORLD_W;
    const y = rnd() * WORLD_H;
    g.fillStyle = rnd() < 0.5 ? 'rgba(43,255,136,0.08)' : 'rgba(34,229,255,0.07)';
    g.fillRect(x, y, 2, 2);
  }
}

function drawFloors(g: G): void {
  g.fillStyle = COLORS.floor;
  for (const r of ROOMS) g.fillRect(r.rect.x * TILE, r.rect.y * TILE, r.rect.w * TILE, r.rect.h * TILE);
  for (const h of HALLS) g.fillRect(h.x * TILE, h.y * TILE, h.w * TILE, h.h * TILE);

  // Per-tile variation for texture.
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (!isFloorish(tx, ty)) continue;
      const h = hash01(ty * 997 + tx * 31 + 5);
      if (h < 0.14) {
        g.fillStyle = 'rgba(255,255,255,0.016)';
        g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      } else if (h > 0.93) {
        g.fillStyle = 'rgba(0,0,0,0.12)';
        g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      }
    }
  }

  // Room accent tint + soft center glow.
  for (const r of ROOMS) {
    const x = r.rect.x * TILE;
    const y = r.rect.y * TILE;
    const w = r.rect.w * TILE;
    const h = r.rect.h * TILE;
    g.fillStyle = rgba(r.accent, 0.035);
    g.fillRect(x, y, w, h);
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rad = Math.max(w, h) * 0.75;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, rgba(r.accent, 0.075));
    grad.addColorStop(1, rgba(r.accent, 0));
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
    g.restore();
  }

  // Tile grid lines.
  const gridRects = [...ROOMS.map((r) => ({ ...r.rect, accent: r.accent })), ...HALLS.map((h) => ({ ...h, accent: COLORS.hallNeon }))];
  for (const r of gridRects) {
    g.beginPath();
    for (let tx = r.x; tx <= r.x + r.w; tx++) {
      g.moveTo(tx * TILE + 0.5, r.y * TILE);
      g.lineTo(tx * TILE + 0.5, (r.y + r.h) * TILE);
    }
    for (let ty = r.y; ty <= r.y + r.h; ty++) {
      g.moveTo(r.x * TILE, ty * TILE + 0.5);
      g.lineTo((r.x + r.w) * TILE, ty * TILE + 0.5);
    }
    g.strokeStyle = 'rgba(255,255,255,0.035)';
    g.lineWidth = 1;
    g.stroke();
    // Small crosshair marks every two tiles: trading-terminal feel.
    g.beginPath();
    for (let ty = r.y + 1; ty < r.y + r.h; ty += 2) {
      for (let tx = r.x + 1; tx < r.x + r.w; tx += 2) {
        const px = tx * TILE + 0.5;
        const py = ty * TILE + 0.5;
        g.moveTo(px - 3, py);
        g.lineTo(px + 3, py);
        g.moveTo(px, py - 3);
        g.lineTo(px, py + 3);
      }
    }
    g.strokeStyle = rgba(r.accent, 0.12);
    g.stroke();
  }

  // Hall center lines.
  g.save();
  g.setLineDash([10, 12]);
  g.strokeStyle = 'rgba(255,255,255,0.055)';
  g.lineWidth = 2;
  for (const h of HALLS) {
    g.beginPath();
    if (h.w >= h.h) {
      const y = (h.y + h.h / 2) * TILE;
      g.moveTo(h.x * TILE + 6, y);
      g.lineTo((h.x + h.w) * TILE - 6, y);
    } else {
      const x = (h.x + h.w / 2) * TILE;
      g.moveTo(x, h.y * TILE + 6);
      g.lineTo(x, (h.y + h.h) * TILE - 6);
    }
    g.stroke();
  }
  g.restore();
}

function roomRectPx(id: RoomId): { x: number; y: number; w: number; h: number; accent: string } {
  const r = ROOMS.find((q) => q.id === id)!;
  return { x: r.rect.x * TILE, y: r.rect.y * TILE, w: r.rect.w * TILE, h: r.rect.h * TILE, accent: r.accent };
}

function withClip(g: G, r: { x: number; y: number; w: number; h: number }, fn: () => void): void {
  g.save();
  g.beginPath();
  g.rect(r.x, r.y, r.w, r.h);
  g.clip();
  fn();
  g.restore();
}

function drawRoomDecor(g: G): void {
  // Launchpad: spawn ring around the SPACES table.
  {
    const cx = EMERGENCY_BUTTON.x;
    const cy = EMERGENCY_BUTTON.y;
    const glow = g.createRadialGradient(cx, cy, 20, cx, cy, 200);
    glow.addColorStop(0, rgba(COLORS.pump, 0.09));
    glow.addColorStop(1, rgba(COLORS.pump, 0));
    g.fillStyle = glow;
    g.beginPath();
    g.ellipse(cx, cy, 200, 150, 0, 0, TAU);
    g.fill();
    g.save();
    g.setLineDash([8, 10]);
    g.strokeStyle = rgba(COLORS.pump, 0.2);
    g.lineWidth = 2;
    g.beginPath();
    g.ellipse(cx, cy, 150, 105, 0, 0, TAU);
    g.stroke();
    g.restore();
    for (const sp of SPAWN_POINTS) {
      g.beginPath();
      g.arc(sp.x, sp.y, 7, 0, TAU);
      g.fillStyle = rgba(COLORS.pump, 0.07);
      g.fill();
      g.strokeStyle = rgba(COLORS.pump, 0.22);
      g.lineWidth = 1.2;
      g.stroke();
    }
  }

  // Trading floor: a giant painted candle chart between the desk rows.
  {
    const r = roomRectPx('tradingFloor');
    const rnd = mulberry32(11);
    let price = 4;
    const baseY = r.y + 5.6 * TILE;
    for (let i = 0; i < 26; i++) {
      const x = r.x + 30 + i * 20;
      const open = price;
      price = Math.max(0, Math.min(52, price + (rnd() - 0.42) * 18));
      const close = price;
      const hi = Math.max(open, close) + rnd() * 8;
      const lo = Math.min(open, close) - rnd() * 8;
      const up = close >= open;
      const col = up ? COLORS.pump : COLORS.rug;
      g.strokeStyle = rgba(col, 0.09);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x, baseY - hi);
      g.lineTo(x, baseY - lo);
      g.stroke();
      g.fillStyle = rgba(col, 0.07);
      const top = baseY - Math.max(open, close);
      g.fillRect(x - 5, top, 10, Math.max(3, Math.abs(close - open)));
    }
  }

  // Meme lab: polka dots.
  withClip(g, roomRectPx('memeLab'), () => {
    const r = roomRectPx('memeLab');
    g.fillStyle = rgba(r.accent, 0.035);
    for (let y = r.y + 20; y < r.y + r.h; y += 40) {
      for (let x = r.x + 20 + ((y / 40) % 2) * 20; x < r.x + r.w; x += 40) {
        g.beginPath();
        g.arc(x, y, 5, 0, TAU);
        g.fill();
      }
    }
  });

  // RPC node: floor cables between racks and consoles.
  {
    const cables: [number, number][][] = [
      [
        [4.5, 21],
        [4.5, 22],
        [5.5, 22],
        [5.5, 23],
      ],
      [
        [7.5, 20],
        [7.5, 21.2],
        [9.5, 21.2],
        [9.5, 17.5],
      ],
      [
        [11.5, 22],
        [11.5, 19.5],
        [10.5, 19.5],
        [10.5, 16.6],
        [5.5, 16.6],
      ],
    ];
    for (const path of cables) {
      g.beginPath();
      path.forEach(([tx, ty], i) => (i === 0 ? g.moveTo(tx * TILE, ty * TILE) : g.lineTo(tx * TILE, ty * TILE)));
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      g.lineWidth = 6;
      g.stroke();
      g.strokeStyle = rgba('#2f8cff', 0.28);
      g.lineWidth = 3;
      g.stroke();
    }
  }

  // Liquidity pool: wet tiles around the basin.
  for (const p of PROPS) {
    if (p.kind !== 'pool') continue;
    const x = p.rect.x * TILE;
    const y = p.rect.y * TILE;
    const w = p.rect.w * TILE;
    const h = p.rect.h * TILE;
    g.beginPath();
    rrect(g, x - 26, y - 26, w + 52, h + 52, 30);
    g.strokeStyle = rgba('#22e5ff', 0.05);
    g.lineWidth = 22;
    g.stroke();
    const rnd = mulberry32(5);
    for (let i = 0; i < 7; i++) {
      const side = rnd();
      const px = side < 0.5 ? x + rnd() * w : rnd() < 0.5 ? x - 30 : x + w + 30;
      const py = side < 0.5 ? (rnd() < 0.5 ? y - 30 : y + h + 30) : y + rnd() * h;
      g.beginPath();
      g.ellipse(px, py, 10 + rnd() * 12, 4 + rnd() * 5, rnd() * 3, 0, TAU);
      g.fillStyle = rgba('#22e5ff', 0.06);
      g.fill();
    }
  }

  // Dev vault: gold diamond plate.
  withClip(g, roomRectPx('devVault'), () => {
    const r = roomRectPx('devVault');
    g.strokeStyle = rgba(r.accent, 0.04);
    g.lineWidth = 1.5;
    g.beginPath();
    for (let d = -r.h; d < r.w + r.h; d += 16) {
      g.moveTo(r.x + d, r.y);
      g.lineTo(r.x + d - r.h, r.y + r.h);
      g.moveTo(r.x + d - r.h, r.y);
      g.lineTo(r.x + d, r.y + r.h);
    }
    g.stroke();
  });

  // Telegram HQ: a rug under the couch and faint paper planes.
  {
    const r = roomRectPx('telegramHq');
    fillRR(g, 4.4 * TILE, 35.6 * TILE, 5.2 * TILE, 2.9 * TILE, 14, rgba(r.accent, 0.08));
    strokeRR(g, 4.4 * TILE, 35.6 * TILE, 5.2 * TILE, 2.9 * TILE, 14, rgba(r.accent, 0.14), 1.5);
    const planes: [number, number, number][] = [
      [6.5, 33.2, -0.3],
      [11, 35, 0.2],
      [13, 32.5, -0.6],
    ];
    for (const [tx, ty, rot] of planes) {
      g.save();
      g.translate(tx * TILE, ty * TILE);
      g.rotate(rot);
      g.beginPath();
      g.moveTo(-14, 0);
      g.lineTo(14, -8);
      g.lineTo(4, 10);
      g.lineTo(0, 3);
      g.closePath();
      g.fillStyle = rgba(r.accent, 0.07);
      g.fill();
      g.restore();
    }
  }

  // KOL studio: stage spotlight and a carpet under the couches.
  {
    const r = roomRectPx('kolStudio');
    fillRR(g, 26.6 * TILE, 37.4 * TILE, 10.8 * TILE, 2.3 * TILE, 18, rgba(r.accent, 0.06));
    const cx = 32 * TILE;
    const cy = 36.6 * TILE;
    const spot = g.createRadialGradient(cx, cy, 10, cx, cy, 150);
    spot.addColorStop(0, 'rgba(255,240,252,0.10)');
    spot.addColorStop(0.5, rgba(r.accent, 0.06));
    spot.addColorStop(1, rgba(r.accent, 0));
    g.fillStyle = spot;
    g.beginPath();
    g.ellipse(cx, cy, 150, 95, 0, 0, TAU);
    g.fill();
    // "ON AIR" floor marker.
    g.save();
    g.font = `16px ${FONT_TITLE}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = rgba(COLORS.rug, 0.12);
    g.fillText('ON AIR', cx, 33.4 * TILE);
    g.restore();
  }

  // Burn room: scorch marks and hazard border around the furnace.
  for (const p of PROPS) {
    if (p.kind !== 'furnace') continue;
    const x = p.rect.x * TILE;
    const y = p.rect.y * TILE;
    const w = p.rect.w * TILE;
    const h = p.rect.h * TILE;
    const cx = x + w / 2;
    const cy = y + h;
    const scorch = g.createRadialGradient(cx, cy, 10, cx, cy, 140);
    scorch.addColorStop(0, 'rgba(255,120,30,0.10)');
    scorch.addColorStop(0.5, 'rgba(0,0,0,0.18)');
    scorch.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = scorch;
    g.fillRect(cx - 160, cy - 160, 320, 320);
    // Hazard stripes border.
    g.save();
    const bx = x - 12;
    const by = y - 12;
    const bw = w + 24;
    const bh = h + 24;
    g.beginPath();
    g.rect(bx, by, bw, bh);
    g.rect(bx + 10, by + 10, bw - 20, bh - 20);
    g.clip('evenodd');
    g.fillStyle = 'rgba(20,20,20,0.6)';
    g.fillRect(bx, by, bw, bh);
    g.strokeStyle = 'rgba(255,212,0,0.32)';
    g.lineWidth = 6;
    g.beginPath();
    for (let d = -bh; d < bw + bh; d += 16) {
      g.moveTo(bx + d, by);
      g.lineTo(bx + d + bh, by + bh);
    }
    g.stroke();
    g.restore();
  }
}

function drawPoolBasins(g: G): void {
  for (const p of PROPS) {
    if (p.kind !== 'pool') continue;
    const x = p.rect.x * TILE;
    const y = p.rect.y * TILE;
    const w = p.rect.w * TILE;
    const h = p.rect.h * TILE;
    // Drop shadow.
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = 16;
    g.shadowOffsetY = 6;
    fillRR(g, x - 6, y - 6, w + 12, h + 12, 20, '#263042');
    g.restore();
    // Coping with a bright rim.
    const rim = g.createLinearGradient(0, y - 6, 0, y + h + 6);
    rim.addColorStop(0, '#3e4b62');
    rim.addColorStop(1, '#222b3a');
    fillRR(g, x - 6, y - 6, w + 12, h + 12, 20, rim);
    strokeRR(g, x - 6, y - 6, w + 12, h + 12, 20, 'rgba(255,255,255,0.12)', 1.5);
    // Coping tiles.
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 1;
    g.beginPath();
    for (let px = x + 20; px < x + w; px += 26) {
      g.moveTo(px, y - 6);
      g.lineTo(px, y + 5);
      g.moveTo(px, y + h - 5);
      g.lineTo(px, y + h + 6);
    }
    g.stroke();
    // Basin (the water is drawn live on top of this).
    fillRR(g, x + 6, y + 6, w - 12, h - 12, 12, '#03121b');
    strokeRR(g, x + 6, y + 6, w - 12, h - 12, 12, rgba('#22e5ff', 0.45), 2);
    // Ladder on the west side.
    const lx = x + 22;
    g.strokeStyle = '#c4ced9';
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(lx, y - 8);
    g.lineTo(lx, y + 26);
    g.moveTo(lx + 16, y - 8);
    g.lineTo(lx + 16, y + 26);
    for (let ry = y + 4; ry < y + 26; ry += 8) {
      g.moveTo(lx, ry);
      g.lineTo(lx + 16, ry);
    }
    g.stroke();
    // Depth markers.
    g.font = `700 9px ${FONT_MONO}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillText('LP 2.0M', x + w / 2, y + h + 1);
    g.fillText('NO RUG PULLING', x + w / 2, y - 1);
  }
}

function drawAmbientOcclusion(g: G): void {
  const north = g.createLinearGradient(0, 0, 0, 18);
  north.addColorStop(0, 'rgba(0,0,0,0.42)');
  north.addColorStop(1, 'rgba(0,0,0,0)');
  const south = g.createLinearGradient(0, TILE, 0, TILE - 8);
  south.addColorStop(0, 'rgba(0,0,0,0.3)');
  south.addColorStop(1, 'rgba(0,0,0,0)');
  const west = g.createLinearGradient(0, 0, 12, 0);
  west.addColorStop(0, 'rgba(0,0,0,0.3)');
  west.addColorStop(1, 'rgba(0,0,0,0)');
  const east = g.createLinearGradient(TILE, 0, TILE - 12, 0);
  east.addColorStop(0, 'rgba(0,0,0,0.3)');
  east.addColorStop(1, 'rgba(0,0,0,0)');
  const solid = (tx: number, ty: number) => !isFloorish(tx, ty);
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (!isFloorish(tx, ty)) continue;
      const n = solid(tx, ty - 1);
      const s = solid(tx, ty + 1);
      const w = solid(tx - 1, ty);
      const e = solid(tx + 1, ty);
      if (!n && !s && !w && !e) continue;
      g.save();
      g.translate(tx * TILE, ty * TILE);
      if (n) {
        g.fillStyle = north;
        g.fillRect(0, 0, TILE, 18);
      }
      if (s) {
        g.fillStyle = south;
        g.fillRect(0, TILE - 8, TILE, 8);
      }
      if (w) {
        g.fillStyle = west;
        g.fillRect(0, 0, 12, TILE);
      }
      if (e) {
        g.fillStyle = east;
        g.fillRect(TILE - 12, 0, 12, TILE);
      }
      g.restore();
    }
  }
}

function drawWalls(g: G): void {
  const neon = new Map<string, Path2D>();
  const addSeg = (accent: string, x0: number, y0: number, x1: number, y1: number) => {
    let p = neon.get(accent);
    if (!p) {
      p = new Path2D();
      neon.set(accent, p);
    }
    p.moveTo(x0, y0);
    p.lineTo(x1, y1);
  };
  const faceGrad = g.createLinearGradient(0, TILE - WALL_FACE, 0, TILE);
  faceGrad.addColorStop(0, COLORS.wallFaceTop);
  faceGrad.addColorStop(1, COLORS.wallFaceBottom);
  const capGrad = g.createLinearGradient(0, 0, 0, TILE);
  capGrad.addColorStop(0, '#222c3b');
  capGrad.addColorStop(1, COLORS.wall);

  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (cellAt(tx, ty) !== CELL_WALL) continue;
      const x = tx * TILE;
      const y = ty * TILE;
      const accent = wallAccent(tx, ty);
      const floorS = isFloorish(tx, ty + 1);
      const floorN = isFloorish(tx, ty - 1);
      const floorE = isFloorish(tx + 1, ty);
      const floorW = isFloorish(tx - 1, ty);
      g.save();
      g.translate(x, y);
      g.fillStyle = capGrad;
      g.fillRect(0, 0, TILE, TILE);
      // Panel seams on the cap.
      g.fillStyle = 'rgba(255,255,255,0.025)';
      g.fillRect(0, 0, TILE, 1);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(TILE - 1, 0, 1, TILE);
      if (floorS) {
        // Front face toward the viewer.
        const fy = TILE - WALL_FACE;
        g.fillStyle = faceGrad;
        g.fillRect(0, fy, TILE, WALL_FACE);
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(TILE / 2 - 0.5, fy + 2, 1, WALL_FACE - 2);
        g.fillStyle = rgba(accent, 0.07);
        g.fillRect(0, fy, TILE, WALL_FACE);
        // Baseboard strip.
        g.fillStyle = rgba(accent, 0.28);
        g.fillRect(0, TILE - 2, TILE, 1);
        // Tiny status light on some panels.
        if (hash01(tx * 131 + ty * 7) < 0.18) {
          g.fillStyle = rgba(accent, 0.7);
          g.fillRect(TILE / 2 + 5, fy + 6, 3, 2);
        }
      }
      g.restore();
      const faceTop = floorS ? y + TILE - WALL_FACE : y + TILE;
      if (floorS) addSeg(accent, x, faceTop, x + TILE, faceTop);
      if (floorN) addSeg(accent, x, y + 0.5, x + TILE, y + 0.5);
      if (floorE) addSeg(accent, x + TILE - 0.5, y, x + TILE - 0.5, faceTop);
      if (floorW) addSeg(accent, x + 0.5, y, x + 0.5, faceTop);
    }
  }
  // Neon edges: glow pass then crisp pass, one stroke per accent color.
  g.save();
  g.lineCap = 'square';
  for (const [accent, path] of neon) {
    g.shadowColor = accent;
    g.shadowBlur = 10;
    g.strokeStyle = rgba(accent, 0.55);
    g.lineWidth = 3;
    g.stroke(path);
  }
  g.shadowBlur = 0;
  for (const [accent, path] of neon) {
    g.strokeStyle = accent;
    g.lineWidth = 1.6;
    g.stroke(path);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 0.6;
    g.stroke(path);
  }
  g.restore();
}

function drawRoomLabels(g: G): void {
  g.save();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const r of ROOMS) {
    const cx = (r.rect.x + r.rect.w / 2) * TILE;
    const cy = (r.rect.y + r.rect.h - 0.55) * TILE;
    const size = r.rect.w >= 14 ? 26 : 22;
    g.font = `${size}px ${FONT_TITLE}`;
    const spaced = r.name.split('').join(' ');
    g.fillStyle = rgba(r.accent, 0.16);
    g.fillText(spaced, cx, cy);
    g.strokeStyle = rgba(r.accent, 0.12);
    g.lineWidth = 1;
    g.strokeText(spaced, cx, cy);
    const w = Math.min(g.measureText(spaced).width, r.rect.w * TILE - 30);
    g.fillStyle = rgba(r.accent, 0.12);
    g.fillRect(cx - w / 2, cy + size * 0.55, w, 2);
  }
  g.restore();
}

/** Bridge hatch (vent) decal. Also used by the dynamic layer for the opening animation base. */
export function drawVentHatch(g: G, x: number, y: number): void {
  g.save();
  g.translate(x, y);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  fillRR(g, -20, -15, 40, 30, 7, '#0e131c');
  g.restore();
  strokeRR(g, -20, -15, 40, 30, 7, rgba(COLORS.sol, 0.6), 2);
  fillRR(g, -16, -11, 32, 22, 4, '#04060a');
  // Grille slats.
  for (let i = 0; i < 4; i++) {
    g.fillStyle = '#1d2534';
    g.fillRect(-15, -9.5 + i * 5.2, 30, 2.4);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(-15, -9.5 + i * 5.2, 30, 0.8);
  }
  // Screws.
  g.fillStyle = '#3a4456';
  for (const [sx, sy] of [
    [-16.5, -11.5],
    [16.5, -11.5],
    [-16.5, 11.5],
    [16.5, 11.5],
  ]) {
    g.beginPath();
    g.arc(sx, sy, 1.4, 0, TAU);
    g.fill();
  }
  drawBridgeGlyph(g, 0, 0, 18, COLORS.sol, COLORS.solGreen);
  g.restore();
}

function drawTaskConsoles(g: G): void {
  for (const s of TASK_STATIONS) {
    const accent = roomAccent(s.room);
    g.save();
    g.translate(s.x, s.y);
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 6;
    g.shadowOffsetY = 2;
    fillRR(g, -16, -16, 32, 32, 8, '#141b26');
    g.restore();
    strokeRR(g, -16, -16, 32, 32, 8, rgba(accent, 0.5), 1.5);
    fillRR(g, -11.5, -11.5, 23, 23, 5, '#080c12');
    g.fillStyle = rgba(accent, 0.08);
    g.fillRect(-11.5, -11.5, 23, 23);
    drawTaskIcon(g, s.kind, 0, 0, 13, rgba(accent, 0.9));
    // Corner ticks.
    g.strokeStyle = rgba(accent, 0.35);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-19, -12);
    g.lineTo(-19, -19);
    g.lineTo(-12, -19);
    g.moveTo(19, 12);
    g.lineTo(19, 19);
    g.lineTo(12, 19);
    g.stroke();
    g.restore();
  }
}

function drawSabotageConsoles(g: G): void {
  for (const s of SABOTAGE_STATIONS) {
    g.save();
    g.translate(s.x, s.y);
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 6;
    g.shadowOffsetY = 2;
    fillRR(g, -17, -17, 34, 34, 8, '#1a1015');
    g.restore();
    // Hazard border.
    g.save();
    g.beginPath();
    rrect(g, -17, -17, 34, 34, 8);
    rrect(g, -13, -13, 26, 26, 5);
    g.clip('evenodd');
    g.fillStyle = '#2a1118';
    g.fillRect(-17, -17, 34, 34);
    g.strokeStyle = rgba(COLORS.rug, 0.55);
    g.lineWidth = 3;
    g.beginPath();
    for (let d = -40; d < 40; d += 8) {
      g.moveTo(d, -17);
      g.lineTo(d + 34, 17);
    }
    g.stroke();
    g.restore();
    fillRR(g, -13, -13, 26, 26, 5, '#07090d');
    const iconColor = s.fix === 'fixDump' ? COLORS.pump : s.fix === 'fixFud' ? '#ffd400' : '#2f8cff';
    drawFixIcon(g, s.fix, 0, 0, 15, rgba(iconColor, 0.9));
    g.font = `700 7.5px ${FONT_MONO}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.6)';
    const label = FIX_LABELS[s.fix] ?? '';
    const lw = g.measureText(label).width + 8;
    fillRR(g, -lw / 2, 20, lw, 11, 3, 'rgba(0,0,0,0.55)');
    g.fillStyle = rgba(COLORS.rug, 0.85);
    g.fillText(label, 0, 25.8);
    g.restore();
  }
}
