// Rug patterns (see shared/cosmetics.ts): drawn flat on the floor under the victim's own rugged
// bag, and by the UI for the ejection ride and the shop. Each pattern is painted once into a
// cached canvas (field plus fringe); animated rugs add a light overlay per frame.

import { mulberry32, createCanvas, get2d, hashString, rrect, TAU } from './util';
import { sparkle, twinkle } from './skins';

type G = CanvasRenderingContext2D;

/** Native field size in world units (the fringe extends past the short ends). */
export const RUG_W = 92;
export const RUG_H = 50;
/** Fringe length beyond each short end, in field units. */
export const RUG_FRINGE = 6;
/** Texture resolution (pixels per field unit). */
const PX = 4;
const CORNER = 2.2;

interface RugArt {
  fringe: string;
  fringeDark: string;
  /** Thicker tassels with knots. */
  tassels?: boolean;
  paint(g: G, w: number, h: number, rnd: () => number): void;
  anim?(g: G, w: number, h: number, t: number): void;
}

// ---------- painting helpers ----------

function lozenge(g: G, cx: number, cy: number, rx: number, ry: number): void {
  g.beginPath();
  g.moveTo(cx - rx, cy);
  g.lineTo(cx, cy - ry);
  g.lineTo(cx + rx, cy);
  g.lineTo(cx, cy + ry);
  g.closePath();
}

function band(g: G, w: number, h: number, inset: number, width: number, style: string | CanvasGradient): void {
  g.fillStyle = style;
  g.fillRect(inset, inset, w - inset * 2, width);
  g.fillRect(inset, h - inset - width, w - inset * 2, width);
  g.fillRect(inset, inset, width, h - inset * 2);
  g.fillRect(w - inset - width, inset, width, h - inset * 2);
}

function frame(g: G, w: number, h: number, inset: number, color: string, lw: number): void {
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
}

// ---------- the six rugs ----------

const persian: RugArt = {
  fringe: '#efe2bd',
  fringeDark: '#c9b78a',
  paint(g, w, h, rnd) {
    const navy = '#1d2858';
    const cream = '#ecdcae';
    const gold = '#d9b45a';
    g.fillStyle = '#801b2e';
    g.fillRect(0, 0, w, h);
    // Soft wool variation.
    for (let i = 0; i < 90; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,220,200,0.05)';
      g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 6, 0.5);
    }
    // Field diaper: tiny cream diamonds.
    g.fillStyle = 'rgba(236,220,174,0.32)';
    for (let y = 9; y < h - 7; y += 5) {
      for (let x = 9 + ((y / 5) % 2) * 3; x < w - 7; x += 6) {
        lozenge(g, x, y, 0.9, 0.9);
        g.fill();
      }
    }
    // Main border band with a running motif.
    band(g, w, h, 0, 6, navy);
    g.fillStyle = gold;
    for (let x = 4; x < w - 2; x += 5) {
      lozenge(g, x, 3, 1.5, 1.6);
      g.fill();
      lozenge(g, x, h - 3, 1.5, 1.6);
      g.fill();
    }
    for (let y = 8; y < h - 6; y += 5) {
      lozenge(g, 3, y, 1.6, 1.5);
      g.fill();
      lozenge(g, w - 3, y, 1.6, 1.5);
      g.fill();
    }
    g.fillStyle = '#b8452e';
    for (let x = 6.5; x < w - 2; x += 5) {
      g.fillRect(x - 0.45, 2.55, 0.9, 0.9);
      g.fillRect(x - 0.45, h - 3.45, 0.9, 0.9);
    }
    frame(g, w, h, 1, cream, 0.6);
    frame(g, w, h, 6, cream, 0.9);
    frame(g, w, h, 7.4, gold, 0.5);
    // Corner spandrels.
    g.fillStyle = navy;
    g.strokeStyle = gold;
    g.lineWidth = 0.6;
    const ci = 7.4;
    const corners = [ci, ci, 1, 1, w - ci, ci, -1, 1, ci, h - ci, 1, -1, w - ci, h - ci, -1, -1];
    for (let i = 0; i < corners.length; i += 4) {
      const x = corners[i];
      const y = corners[i + 1];
      const sx = corners[i + 2];
      const sy = corners[i + 3];
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + sx * 15, y);
      g.quadraticCurveTo(x + sx * 7, y + sy * 3, x, y + sy * 10);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = cream;
      lozenge(g, x + sx * 4, y + sy * 2.6, 1.4, 1.1);
      g.fill();
      g.fillStyle = navy;
    }
    // Central medallion with pendants.
    const cx = w / 2;
    const cy = h / 2;
    g.fillStyle = navy;
    lozenge(g, cx - 29, cy, 4, 3);
    g.fill();
    lozenge(g, cx + 29, cy, 4, 3);
    g.fill();
    g.strokeStyle = gold;
    g.lineWidth = 0.6;
    lozenge(g, cx - 29, cy, 4, 3);
    g.stroke();
    lozenge(g, cx + 29, cy, 4, 3);
    g.stroke();
    lozenge(g, cx, cy, 25, 16);
    g.fill();
    g.lineWidth = 1;
    g.stroke();
    lozenge(g, cx, cy, 17.5, 11);
    g.fillStyle = '#c2562f';
    g.fill();
    g.strokeStyle = cream;
    g.lineWidth = 0.7;
    g.stroke();
    lozenge(g, cx, cy, 10, 6.4);
    g.fillStyle = cream;
    g.fill();
    lozenge(g, cx, cy, 5, 3.2);
    g.fillStyle = navy;
    g.fill();
    g.beginPath();
    g.arc(cx, cy, 1.2, 0, TAU);
    g.fillStyle = gold;
    g.fill();
    // Rosettes in the field.
    const ros = [20, 14, 72, 14, 20, 36, 72, 36];
    for (let i = 0; i < ros.length; i += 2) {
      g.fillStyle = cream;
      for (let k = 0; k < 4; k++) {
        const a = (k * TAU) / 4;
        g.beginPath();
        g.arc(ros[i] + Math.cos(a) * 1.3, ros[i + 1] + Math.sin(a) * 1.3, 0.9, 0, TAU);
        g.fill();
      }
      g.beginPath();
      g.arc(ros[i], ros[i + 1], 0.8, 0, TAU);
      g.fillStyle = gold;
      g.fill();
    }
  },
};

const checker: RugArt = {
  fringe: '#f2f4f7',
  fringeDark: '#9aa6b5',
  paint(g, w, h) {
    const rows = 6;
    const cols = 11;
    const cw = w / cols;
    const ch = h / rows;
    g.fillStyle = '#eef1f5';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#0c0e13';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) if ((r + c) & 1) g.fillRect(c * cw, r * ch, cw + 0.05, ch + 0.05);
    }
    // Woven texture and a soft light falloff.
    g.fillStyle = 'rgba(128,128,128,0.12)';
    for (let y = 0.8; y < h; y += 1.6) g.fillRect(0, y, w, 0.3);
    const shade = g.createLinearGradient(0, 0, 0, h);
    shade.addColorStop(0, 'rgba(255,255,255,0.08)');
    shade.addColorStop(1, 'rgba(0,0,0,0.14)');
    g.fillStyle = shade;
    g.fillRect(0, 0, w, h);
    band(g, w, h, 0, 2.4, '#0c0e13');
    frame(g, w, h, 2.9, '#eef1f5', 0.7);
  },
};

const dump: RugArt = {
  fringe: '#5a5f6b',
  fringeDark: '#2b2e36',
  paint(g, w, h, rnd) {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#17141c');
    bg.addColorStop(1, '#0b0a0f');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // Chart grid.
    g.fillStyle = 'rgba(255,255,255,0.06)';
    for (let x = 6; x < w; x += 8) g.fillRect(x, 0, 0.4, h);
    for (let y = 5; y < h; y += 8) g.fillRect(0, y, w, 0.4);
    // The dump: red candles all the way down, one tiny dead-cat bounce.
    const red = '#ff3b5c';
    let price = 7;
    const n = 9;
    const mids: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = 9 + i * 9.3;
      const bounce = i === 5;
      const open = price;
      const close = bounce ? open - 2.2 : open + 2.6 + rnd() * 2.6;
      const top = Math.min(open, close);
      const bot = Math.max(open, close);
      g.strokeStyle = bounce ? '#2bff88' : red;
      g.lineWidth = 0.7;
      g.beginPath();
      g.moveTo(x, top - 1.2 - rnd() * 1.8);
      g.lineTo(x, bot + 1 + rnd() * 1.8);
      g.stroke();
      g.fillStyle = bounce ? '#2bff88' : red;
      g.fillRect(x - 2.4, top, 4.8, Math.max(1, bot - top));
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(x - 1.8, top + 0.4, 0.7, Math.max(0.4, bot - top - 0.8));
      mids.push(x, (open + close) / 2);
      price = close + (bounce ? 0 : rnd() * 0.6);
    }
    // Moving-average line with a red glow.
    for (let pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass === 0 ? 'rgba(255,59,92,0.25)' : 'rgba(255,170,185,0.9)';
      g.lineWidth = pass === 0 ? 2.4 : 0.6;
      g.beginPath();
      for (let i = 0; i < mids.length; i += 2) {
        if (i === 0) g.moveTo(mids[i] - 6, mids[i + 1] - 3);
        g.lineTo(mids[i], mids[i + 1]);
      }
      g.lineTo(w, mids[mids.length - 1] + 3);
      g.stroke();
    }
    // Liquidation zone at the bottom.
    const liq = g.createLinearGradient(0, h - 10, 0, h);
    liq.addColorStop(0, 'rgba(255,59,92,0)');
    liq.addColorStop(1, 'rgba(255,59,92,0.28)');
    g.fillStyle = liq;
    g.fillRect(0, h - 10, w, 10);
    frame(g, w, h, 1.3, 'rgba(255,59,92,0.85)', 0.8);
  },
};

const frog: RugArt = {
  fringe: '#b6ff3b',
  fringeDark: '#5f8f1f',
  paint(g, w, h, rnd) {
    const bg = g.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w * 0.62);
    bg.addColorStop(0, '#53b84f');
    bg.addColorStop(1, '#2a7531');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // Warts.
    for (let i = 0; i < 46; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = 0.7 + rnd() * 2.1;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fillStyle = 'rgba(28,84,34,0.75)';
      g.fill();
      g.beginPath();
      g.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, TAU);
      g.fillStyle = 'rgba(160,236,130,0.6)';
      g.fill();
    }
    // Ripples.
    g.strokeStyle = 'rgba(200,255,200,0.35)';
    g.lineWidth = 0.6;
    const rip = [30, 12, 62, 38, 46, 26];
    for (let i = 0; i < rip.length; i += 2) {
      for (let k = 1; k <= 2; k++) {
        g.beginPath();
        g.ellipse(rip[i], rip[i + 1], 3 * k + 1, 1.4 * k + 0.6, 0, 0, TAU);
        g.stroke();
      }
    }
    // Lily pads.
    const pads = [13, 37, 7, 82, 12, 5.6, 80, 40, 4.6, 64, 8, 3.6];
    for (let i = 0; i < pads.length; i += 3) {
      const x = pads[i];
      const y = pads[i + 1];
      const r = pads[i + 2];
      const a = -0.6 + i;
      g.beginPath();
      g.moveTo(x, y);
      g.arc(x, y, r, a + 0.38, a - 0.38 + TAU);
      g.closePath();
      g.fillStyle = '#1f6d2c';
      g.fill();
      g.strokeStyle = '#123f1a';
      g.lineWidth = 0.6;
      g.stroke();
      g.strokeStyle = 'rgba(150,230,140,0.45)';
      g.lineWidth = 0.4;
      g.beginPath();
      for (let k = 1; k < 6; k++) {
        const b = a + (k * TAU) / 6;
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(b) * r * 0.85, y + Math.sin(b) * r * 0.85);
      }
      g.stroke();
    }
    // A pink lotus.
    for (let k = 0; k < 5; k++) {
      const a = (k * TAU) / 5 - Math.PI / 2;
      g.beginPath();
      g.ellipse(82 + Math.cos(a) * 1.6, 12 + Math.sin(a) * 1.6, 1.5, 0.9, a, 0, TAU);
      g.fillStyle = '#ffb3e6';
      g.fill();
    }
    g.beginPath();
    g.arc(82, 12, 0.9, 0, TAU);
    g.fillStyle = '#ffd400';
    g.fill();
    // A frog peeking from the pad.
    const fx = 13;
    const fy = 35;
    g.beginPath();
    g.ellipse(fx, fy + 1.4, 5, 3.2, 0, Math.PI, TAU);
    g.fillStyle = '#6fd25c';
    g.fill();
    g.strokeStyle = '#1b4a1f';
    g.lineWidth = 0.6;
    g.stroke();
    for (let s = -1; s <= 1; s += 2) {
      g.beginPath();
      g.arc(fx + s * 2.4, fy - 1.4, 1.9, 0, TAU);
      g.fillStyle = '#6fd25c';
      g.fill();
      g.stroke();
      g.beginPath();
      g.arc(fx + s * 2.4, fy - 1.4, 1.2, 0, TAU);
      g.fillStyle = '#ffffff';
      g.fill();
      g.beginPath();
      g.ellipse(fx + s * 2.4, fy - 1.3, 0.75, 0.45, 0, 0, TAU);
      g.fillStyle = '#05070a';
      g.fill();
    }
    g.beginPath();
    g.arc(fx, fy + 0.3, 2, 0.25, Math.PI - 0.25);
    g.strokeStyle = '#1b4a1f';
    g.stroke();
    // Border with stitching.
    band(g, w, h, 0, 2.3, '#1d5a24');
    g.strokeStyle = 'rgba(182,255,59,0.75)';
    g.lineWidth = 0.5;
    g.setLineDash([1.6, 1.2]);
    g.strokeRect(1.15, 1.15, w - 2.3, h - 2.3);
    g.setLineDash([]);
  },
};

const gold: RugArt = {
  fringe: '#ffd400',
  fringeDark: '#a87d00',
  tassels: true,
  paint(g, w, h) {
    const bg = g.createRadialGradient(w / 2, h / 2, 3, w / 2, h / 2, w * 0.6);
    bg.addColorStop(0, '#3a1a66');
    bg.addColorStop(1, '#170a2b');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    // Lattice.
    g.save();
    g.beginPath();
    g.rect(6, 6, w - 12, h - 12);
    g.clip();
    g.strokeStyle = 'rgba(255,212,0,0.26)';
    g.lineWidth = 0.5;
    g.beginPath();
    for (let x = -h; x < w + h; x += 9) {
      g.moveTo(x, 0);
      g.lineTo(x + h, h);
      g.moveTo(x, h);
      g.lineTo(x + h, 0);
    }
    g.stroke();
    // Gold studs where the diagonals cross: x - y = a meets x + y = b.
    g.fillStyle = 'rgba(255,220,90,0.6)';
    for (let a = -h; a < w + h; a += 9) {
      for (let b = 0; b < w + 2 * h; b += 9) {
        const x = (a + b) / 2;
        const y = (b - a) / 2;
        if (x > 6 && x < w - 6 && y > 6 && y < h - 6) g.fillRect(x - 0.5, y - 0.5, 1, 1);
      }
    }
    g.restore();
    // Gold border.
    const metal = g.createLinearGradient(0, 0, w, h);
    metal.addColorStop(0, '#fff0a0');
    metal.addColorStop(0.25, '#ffc933');
    metal.addColorStop(0.5, '#b8860b');
    metal.addColorStop(0.75, '#ffdf6b');
    metal.addColorStop(1, '#c99400');
    band(g, w, h, 0, 3.4, metal);
    frame(g, w, h, 5, '#ffd400', 0.5);
    frame(g, w, h, 6.2, 'rgba(255,212,0,0.6)', 0.35);
    // Corner ornaments.
    const cs = [9.5, 9.5, w - 9.5, 9.5, 9.5, h - 9.5, w - 9.5, h - 9.5];
    for (let i = 0; i < cs.length; i += 2) {
      lozenge(g, cs[i], cs[i + 1], 2.6, 2.6);
      g.fillStyle = metal;
      g.fill();
      g.fillStyle = '#ffe680';
      for (let k = 0; k < 4; k++) {
        const a = (k * TAU) / 4 + Math.PI / 4;
        g.beginPath();
        g.arc(cs[i] + Math.cos(a) * 4, cs[i + 1] + Math.sin(a) * 4, 0.7, 0, TAU);
        g.fill();
      }
    }
    // Sun medallion.
    g.strokeStyle = '#ffd400';
    g.lineWidth = 0.8;
    g.beginPath();
    g.arc(w / 2, h / 2, 8.5, 0, TAU);
    g.stroke();
    g.beginPath();
    for (let k = 0; k < 16; k++) {
      const a = (k * TAU) / 16;
      const r1 = 10;
      const r2 = k % 2 ? 12.5 : 14.5;
      g.moveTo(w / 2 + Math.cos(a) * r1, h / 2 + Math.sin(a) * r1);
      g.lineTo(w / 2 + Math.cos(a) * r2, h / 2 + Math.sin(a) * r2);
    }
    g.stroke();
    // Pendants toward the ends.
    for (let s = -1; s <= 1; s += 2) {
      lozenge(g, w / 2 + s * 27, h / 2, 5, 3.4);
      g.fillStyle = metal;
      g.fill();
      lozenge(g, w / 2 + s * 27, h / 2, 2.4, 1.6);
      g.fillStyle = '#2a1150';
      g.fill();
    }
  },
  anim(g, w, h, t) {
    const p = (t % 3.4) / 3.4;
    const x = -24 + p * (w + 48);
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(255,236,160,0.22)';
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 7, 0);
    g.lineTo(x - 11, h);
    g.lineTo(x - 18, h);
    g.closePath();
    g.fill();
    g.globalCompositeOperation = 'source-over';
    const tw = twinkle(t, 2.1, 0.7, 8);
    if (tw > 0.04) sparkle(g, 9.5, 9.5, 4 * tw, 'rgba(255,250,220,0.95)');
    const tw2 = twinkle(t, 2.1, 2.9, 8);
    if (tw2 > 0.04) sparkle(g, w - 9.5, h - 9.5, 4 * tw2, 'rgba(255,250,220,0.95)');
  },
};

let galaxyStars: HTMLCanvasElement | null = null;

function buildGalaxyStars(): HTMLCanvasElement {
  const s = 3;
  const c = createCanvas(RUG_W * s, RUG_H * s);
  const g = get2d(c);
  g.scale(s, s);
  const rnd = mulberry32(0x5a712);
  for (let i = 0; i < 34; i++) {
    const x = rnd() * RUG_W;
    const y = rnd() * RUG_H;
    const r = 0.25 + rnd() * 0.45;
    g.fillStyle = rnd() < 0.2 ? 'rgba(170,230,255,0.9)' : 'rgba(255,255,255,0.85)';
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
  return c;
}

// Twinkling bright stars: x, y, phase.
const GALAXY_TWINKLES = [12, 9, 0.3, 33, 41, 1.7, 58, 6, 2.9, 86, 30, 4.1, 21, 26, 5.3, 70, 44, 0.9, 47, 15, 3.6];

const galaxy: RugArt = {
  fringe: '#c8d0ff',
  fringeDark: '#3a3f7a',
  paint(g, w, h, rnd) {
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#0a0322');
    bg.addColorStop(0.45, '#1c0c4a');
    bg.addColorStop(1, '#06173a');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const neb = [24, 16, 24, 'rgba(153,69,255,0.6)', 68, 34, 22, 'rgba(34,229,255,0.32)', 54, 9, 14, 'rgba(255,79,216,0.32)', 14, 40, 14, 'rgba(47,140,255,0.35)'] as const;
    for (let i = 0; i < neb.length; i += 4) {
      const x = neb[i] as number;
      const y = neb[i + 1] as number;
      const r = neb[i + 2] as number;
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, neb[i + 3] as string);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 70; i++) {
      g.fillStyle = `rgba(255,255,255,${(0.2 + rnd() * 0.5).toFixed(2)})`;
      const s = 0.3 + rnd() * 0.35;
      g.fillRect(rnd() * w, rnd() * h, s, s);
    }
    // Ringed planet.
    const px = 80;
    const py = 13;
    g.strokeStyle = 'rgba(255,224,176,0.85)';
    g.lineWidth = 0.7;
    g.beginPath();
    g.ellipse(px, py, 6.8, 1.8, -0.35, Math.PI, TAU);
    g.stroke();
    const pg = g.createRadialGradient(px - 1.2, py - 1.2, 0.3, px, py, 3.8);
    pg.addColorStop(0, '#ffe0a8');
    pg.addColorStop(1, '#d9772b');
    g.fillStyle = pg;
    g.beginPath();
    g.arc(px, py, 3.6, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(px, py, 6.8, 1.8, -0.35, 0, Math.PI);
    g.stroke();
    // The moon.
    const mx = 11;
    const my = 39;
    const mg = g.createRadialGradient(mx - 1, my - 1, 0.3, mx, my, 3.6);
    mg.addColorStop(0, '#f4f6ff');
    mg.addColorStop(1, '#9aa3c0');
    g.fillStyle = mg;
    g.beginPath();
    g.arc(mx, my, 3.4, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(90,100,140,0.5)';
    g.beginPath();
    g.arc(mx + 1, my - 0.6, 0.8, 0, TAU);
    g.arc(mx - 1.2, my + 1.2, 0.6, 0, TAU);
    g.fill();
    frame(g, w, h, 1, 'rgba(200,210,255,0.55)', 0.6);
  },
  anim(g, w, h, t) {
    galaxyStars ??= buildGalaxyStars();
    // To the moon, horizontally: a star layer drifts sideways.
    const ox = (t * 5) % w;
    g.drawImage(galaxyStars, -ox, 0, w, h);
    g.drawImage(galaxyStars, w - ox, 0, w, h);
    for (let i = 0; i < GALAXY_TWINKLES.length; i += 3) {
      const a = twinkle(t, 2.3, GALAXY_TWINKLES[i + 2], 3);
      if (a > 0.05) sparkle(g, GALAXY_TWINKLES[i], GALAXY_TWINKLES[i + 1], 0.8 + 2.2 * a, 'rgba(255,255,255,0.95)');
    }
    // A shooting star every few seconds.
    const p = (t % 4.6) / 0.8;
    if (p < 1) {
      const x = 20 + p * 50;
      const y = 6 + p * 12;
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 0.6;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - 7, y - 1.7);
      g.stroke();
      g.strokeStyle = 'rgba(160,220,255,0.35)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x - 2, y - 0.5);
      g.lineTo(x - 12, y - 2.9);
      g.stroke();
    }
  },
};

const RUGS: Record<string, RugArt> = {
  rug_persian: persian,
  rug_checker: checker,
  rug_dump: dump,
  rug_frog: frog,
  rug_gold: gold,
  rug_galaxy: galaxy,
};

export const RUG_IDS: readonly string[] = Object.keys(RUGS);

function artFor(id: string | null | undefined): RugArt | undefined {
  return id && Object.prototype.hasOwnProperty.call(RUGS, id) ? RUGS[id] : undefined;
}

/** True when this client can draw the rug id. */
export function isKnownRug(id: string | null | undefined): boolean {
  return !!artFor(id);
}

// ---------- texture cache ----------

const textures = new Map<string, HTMLCanvasElement>();

function drawFringe(g: G, art: RugArt, x: number, dir: 1 | -1, rnd: () => number): void {
  const step = art.tassels ? 2.6 : 1.55;
  g.lineCap = 'round';
  for (let y = 1.6; y <= RUG_H - 1.4; y += step) {
    const len = RUG_FRINGE - (art.tassels ? 0.6 : 1.2) - rnd() * 0.9;
    const sway = (rnd() - 0.5) * 1.2;
    g.strokeStyle = (Math.round(y / step) & 1) === 0 ? art.fringe : art.fringeDark;
    g.lineWidth = art.tassels ? 1.15 : 0.7;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + dir * len * 0.5, y + sway * 0.4, x + dir * len, y + sway);
    g.stroke();
    if (art.tassels) {
      g.fillStyle = art.fringeDark;
      g.beginPath();
      g.arc(x + dir * 1.6, y + sway * 0.1, 0.85, 0, TAU);
      g.fill();
    }
  }
  // Binding where the threads leave the rug.
  g.fillStyle = art.fringeDark;
  g.fillRect(dir > 0 ? x - 0.2 : x - 0.9, 0.8, 1.1, RUG_H - 1.6);
}

function buildTexture(id: string, art: RugArt): HTMLCanvasElement {
  const c = createCanvas((RUG_W + RUG_FRINGE * 2) * PX, RUG_H * PX);
  const g = get2d(c);
  g.scale(PX, PX);
  const rnd = mulberry32(hashString(id));
  drawFringe(g, art, RUG_FRINGE, -1, rnd);
  drawFringe(g, art, RUG_FRINGE + RUG_W, 1, rnd);
  g.translate(RUG_FRINGE, 0);
  g.save();
  g.beginPath();
  rrect(g, 0, 0, RUG_W, RUG_H, CORNER);
  g.clip();
  art.paint(g, RUG_W, RUG_H, rnd);
  // Gentle pile sheen: lit from the top-left.
  const sheen = g.createLinearGradient(0, 0, RUG_W, RUG_H);
  sheen.addColorStop(0, 'rgba(255,255,255,0.07)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, RUG_W, RUG_H);
  g.restore();
  g.beginPath();
  rrect(g, 0.35, 0.35, RUG_W - 0.7, RUG_H - 0.7, CORNER);
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.lineWidth = 0.7;
  g.stroke();
  return c;
}

function texture(id: string, art: RugArt): HTMLCanvasElement {
  let c = textures.get(id);
  if (!c) {
    c = buildTexture(id, art);
    textures.set(id, c);
  }
  return c;
}

/**
 * Draws rug `id` flat, its field `w` x `h` centered on (cx, cy), fringe past the short (left and
 * right) ends, with a soft drop shadow. `t` is in seconds (animated rugs). Returns false (drawing
 * nothing) for an unknown id. Any 2D context works (world canvas, shop and ejection previews).
 */
export function drawRug(g: G, id: string | null | undefined, cx: number, cy: number, w: number, h: number, t: number): boolean {
  const art = artFor(id);
  if (!art || !id) return false;
  const tex = texture(id, art);
  const sx = w / RUG_W;
  const sy = h / RUG_H;
  const fx = RUG_FRINGE * sx;
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  g.fillStyle = 'rgba(0,0,0,0.42)';
  g.beginPath();
  rrect(g, x0 + 1.2 * sx, y0 + 2.2 * sy, w, h, CORNER * sx);
  g.fill();
  g.drawImage(tex, x0 - fx, y0, w + fx * 2, h);
  if (art.anim) {
    g.save();
    g.translate(x0, y0);
    g.scale(sx, sy);
    g.beginPath();
    rrect(g, 0, 0, RUG_W, RUG_H, CORNER);
    g.clip();
    art.anim(g, RUG_W, RUG_H, t);
    g.restore();
  }
  return true;
}
