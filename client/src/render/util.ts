// Small math + canvas helpers shared by the render modules.

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach of `current` toward `target`. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Integer hash to [0, 1). Deterministic, allocation free. */
export function hash01(n: number): number {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** FNV-1a string hash (unsigned 32 bit). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adds a rounded-rectangle sub-path (works everywhere, unlike ctx.roundRect). */
export function rrect(g: CanvasRenderingContext2D | Path2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

export function fillRR(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, style: string | CanvasGradient): void {
  g.beginPath();
  rrect(g, x, y, w, h, r);
  g.fillStyle = style;
  g.fill();
}

export function strokeRR(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, style: string | CanvasGradient, lw: number): void {
  g.beginPath();
  rrect(g, x, y, w, h, r);
  g.strokeStyle = style;
  g.lineWidth = lw;
  g.stroke();
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function get2d(c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const g = c.getContext('2d', opts);
  if (!g) throw new Error('Canvas 2D is not available');
  return g;
}

/** True if the browser applies `ctx.filter` (Safari historically ignores it). */
export function supportsCanvasFilter(g: CanvasRenderingContext2D): boolean {
  try {
    const prev = g.filter;
    g.filter = 'blur(2px)';
    const ok = g.filter === 'blur(2px)';
    g.filter = prev || 'none';
    return ok;
  } catch {
    return false;
  }
}
