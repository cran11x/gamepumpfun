// Tiny vector glyphs for task consoles, sabotage consoles and bridge hatches.
// All glyphs are drawn centered on (x, y) and fit inside a box of size `s`.

import type { FixKind, TaskKind } from '../../../shared/protocol';
import { TAU } from './util';

type G = CanvasRenderingContext2D;

function begin(g: G, x: number, y: number, s: number, color: string): number {
  g.save();
  g.translate(x, y);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const lw = Math.max(1.2, s * 0.12);
  g.lineWidth = lw;
  return s / 2;
}

export function drawTaskIcon(g: G, kind: TaskKind, x: number, y: number, s: number, color: string): void {
  const h = begin(g, x, y, s, color);
  switch (kind) {
    case 'verifyCA': {
      // Shield with a check mark.
      g.beginPath();
      g.moveTo(0, -h);
      g.quadraticCurveTo(h * 0.55, -h * 0.75, h * 0.9, -h * 0.7);
      g.quadraticCurveTo(h * 0.95, h * 0.35, 0, h);
      g.quadraticCurveTo(-h * 0.95, h * 0.35, -h * 0.9, -h * 0.7);
      g.quadraticCurveTo(-h * 0.55, -h * 0.75, 0, -h);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(-h * 0.4, 0);
      g.lineTo(-h * 0.08, h * 0.32);
      g.lineTo(h * 0.45, -h * 0.3);
      g.stroke();
      break;
    }
    case 'snipeLaunch': {
      g.beginPath();
      g.arc(0, 0, h * 0.62, 0, TAU);
      g.stroke();
      g.beginPath();
      g.moveTo(0, -h);
      g.lineTo(0, -h * 0.35);
      g.moveTo(0, h);
      g.lineTo(0, h * 0.35);
      g.moveTo(-h, 0);
      g.lineTo(-h * 0.35, 0);
      g.moveTo(h, 0);
      g.lineTo(h * 0.35, 0);
      g.stroke();
      g.beginPath();
      g.arc(0, 0, h * 0.14, 0, TAU);
      g.fill();
      break;
    }
    case 'burnLP': {
      g.beginPath();
      g.moveTo(0, h);
      g.bezierCurveTo(-h * 0.9, h * 0.9, -h * 0.85, -h * 0.1, -h * 0.25, -h * 0.55);
      g.quadraticCurveTo(-h * 0.2, -h * 0.1, 0, 0);
      g.quadraticCurveTo(h * 0.05, -h * 0.65, h * 0.15, -h);
      g.bezierCurveTo(h * 0.9, -h * 0.35, h * 0.95, h * 0.85, 0, h);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(0, h * 0.75);
      g.quadraticCurveTo(-h * 0.35, h * 0.55, -h * 0.05, h * 0.1);
      g.quadraticCurveTo(h * 0.35, h * 0.5, 0, h * 0.75);
      g.fill();
      break;
    }
    case 'shillPost': {
      // Speech bubble with typing dots.
      g.beginPath();
      g.moveTo(-h, -h * 0.65);
      g.lineTo(h, -h * 0.65);
      g.lineTo(h, h * 0.45);
      g.lineTo(-h * 0.2, h * 0.45);
      g.lineTo(-h * 0.6, h * 0.95);
      g.lineTo(-h * 0.55, h * 0.45);
      g.lineTo(-h, h * 0.45);
      g.closePath();
      g.stroke();
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.arc(i * h * 0.45, -h * 0.1, h * 0.12, 0, TAU);
        g.fill();
      }
      break;
    }
    case 'addLiquidity': {
      g.beginPath();
      g.moveTo(0, -h);
      g.bezierCurveTo(h * 0.35, -h * 0.45, h * 0.8, -h * 0.05, h * 0.8, h * 0.3);
      g.arc(0, h * 0.3, h * 0.8, 0, Math.PI);
      g.bezierCurveTo(-h * 0.8, -h * 0.05, -h * 0.35, -h * 0.45, 0, -h);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(-h * 0.4, h * 0.35);
      g.quadraticCurveTo(-h * 0.35, h * 0.75, 0, h * 0.75);
      g.stroke();
      break;
    }
    case 'bubblemap': {
      const pts: [number, number, number][] = [
        [-h * 0.5, -h * 0.4, 0.34],
        [h * 0.55, -h * 0.25, 0.28],
        [-h * 0.05, h * 0.55, 0.3],
      ];
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      g.lineTo(pts[1][0], pts[1][1]);
      g.lineTo(pts[2][0], pts[2][1]);
      g.closePath();
      g.stroke();
      for (const [px, py, r] of pts) {
        g.beginPath();
        g.arc(px, py, h * r, 0, TAU);
        g.fill();
      }
      break;
    }
    case 'connectSocials': {
      g.save();
      g.rotate(-Math.PI / 4);
      g.beginPath();
      g.ellipse(-h * 0.38, 0, h * 0.5, h * 0.3, 0, 0, TAU);
      g.stroke();
      g.beginPath();
      g.ellipse(h * 0.38, 0, h * 0.5, h * 0.3, 0, 0, TAU);
      g.stroke();
      g.restore();
      break;
    }
    case 'deleteBots': {
      g.beginPath();
      g.moveTo(-h * 0.7, -h * 0.35);
      g.lineTo(h * 0.7, -h * 0.35);
      g.lineTo(h * 0.7, h * 0.65);
      g.lineTo(-h * 0.7, h * 0.65);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(0, -h * 0.35);
      g.lineTo(0, -h * 0.8);
      g.stroke();
      g.beginPath();
      g.arc(0, -h * 0.88, h * 0.12, 0, TAU);
      g.fill();
      // X eyes
      g.lineWidth *= 0.8;
      for (const ex of [-h * 0.3, h * 0.3]) {
        g.beginPath();
        g.moveTo(ex - h * 0.14, h * 0.0);
        g.lineTo(ex + h * 0.14, h * 0.28);
        g.moveTo(ex + h * 0.14, h * 0.0);
        g.lineTo(ex - h * 0.14, h * 0.28);
        g.stroke();
      }
      break;
    }
    case 'swapSol': {
      g.beginPath();
      g.moveTo(-h * 0.8, -h * 0.35);
      g.lineTo(h * 0.7, -h * 0.35);
      g.moveTo(h * 0.35, -h * 0.7);
      g.lineTo(h * 0.75, -h * 0.35);
      g.lineTo(h * 0.35, 0);
      g.moveTo(h * 0.8, h * 0.4);
      g.lineTo(-h * 0.7, h * 0.4);
      g.moveTo(-h * 0.35, h * 0.05);
      g.lineTo(-h * 0.75, h * 0.4);
      g.lineTo(-h * 0.35, h * 0.75);
      g.stroke();
      break;
    }
    case 'syncNode': {
      g.beginPath();
      g.arc(0, 0, h * 0.75, -Math.PI * 0.15, Math.PI * 1.25);
      g.stroke();
      // Arrow head at the arc start.
      const a = -Math.PI * 0.15;
      const ax = Math.cos(a) * h * 0.75;
      const ay = Math.sin(a) * h * 0.75;
      g.beginPath();
      g.moveTo(ax + h * 0.35, ay - h * 0.05);
      g.lineTo(ax, ay);
      g.lineTo(ax - h * 0.05, ay - h * 0.42);
      g.stroke();
      g.beginPath();
      g.arc(0, 0, h * 0.18, 0, TAU);
      g.fill();
      break;
    }
  }
  g.restore();
}

export function drawFixIcon(g: G, kind: FixKind, x: number, y: number, s: number, color: string): void {
  const h = begin(g, x, y, s, color);
  switch (kind) {
    case 'fixDump': {
      // BUY WALL: stacked green bars with an up arrow.
      const bars = [0.35, 0.6, 0.9];
      bars.forEach((bh, i) => {
        const bx = -h * 0.8 + i * h * 0.6;
        g.fillRect(bx, h - bh * h * 1.6, h * 0.4, bh * h * 1.6);
      });
      g.beginPath();
      g.moveTo(-h * 0.9, -h * 0.2);
      g.lineTo(h * 0.2, -h * 0.85);
      g.moveTo(-h * 0.25, -h * 0.9);
      g.lineTo(h * 0.25, -h * 0.9);
      g.lineTo(h * 0.2, -h * 0.45);
      g.stroke();
      break;
    }
    case 'fixFud': {
      // Light bulb.
      g.beginPath();
      g.arc(0, -h * 0.2, h * 0.62, Math.PI * 0.8, Math.PI * 2.2);
      g.lineTo(h * 0.25, h * 0.55);
      g.lineTo(-h * 0.25, h * 0.55);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(-h * 0.25, h * 0.8);
      g.lineTo(h * 0.25, h * 0.8);
      g.stroke();
      break;
    }
    case 'fixRpc': {
      // Antenna with signal arcs.
      g.beginPath();
      g.moveTo(0, -h * 0.2);
      g.lineTo(-h * 0.5, h);
      g.moveTo(0, -h * 0.2);
      g.lineTo(h * 0.5, h);
      g.moveTo(-h * 0.3, h * 0.45);
      g.lineTo(h * 0.3, h * 0.45);
      g.stroke();
      g.beginPath();
      g.arc(0, -h * 0.2, h * 0.14, 0, TAU);
      g.fill();
      for (const r of [0.45, 0.8]) {
        g.beginPath();
        g.arc(0, -h * 0.2, h * r, -Math.PI * 0.8, -Math.PI * 0.2);
        g.stroke();
      }
      break;
    }
  }
  g.restore();
}

/** Cross-chain bridge glyph: an arch with a deck and pillars, in Solana gradient colors. */
export function drawBridgeGlyph(g: G, x: number, y: number, s: number, a: string, b: string): void {
  g.save();
  g.translate(x, y);
  const h = s / 2;
  const grad = g.createLinearGradient(-h, 0, h, 0);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.strokeStyle = grad;
  g.lineCap = 'round';
  g.lineWidth = Math.max(1.2, s * 0.13);
  g.beginPath();
  g.moveTo(-h, h * 0.35);
  g.quadraticCurveTo(0, -h * 1.05, h, h * 0.35);
  g.stroke();
  g.lineWidth = Math.max(1.2, s * 0.11);
  g.beginPath();
  g.moveTo(-h * 1.1, h * 0.05);
  g.lineTo(h * 1.1, h * 0.05);
  g.stroke();
  g.lineWidth = Math.max(0.8, s * 0.07);
  g.beginPath();
  for (const px of [-0.55, 0, 0.55]) {
    const archY = h * 0.35 - (1 - px * px) * h * 0.7;
    g.moveTo(px * h, archY);
    g.lineTo(px * h, h * 0.05);
  }
  g.moveTo(-h * 0.85, h * 0.05);
  g.lineTo(-h * 0.85, h * 0.6);
  g.moveTo(h * 0.85, h * 0.05);
  g.lineTo(h * 0.85, h * 0.6);
  g.stroke();
  g.restore();
}
