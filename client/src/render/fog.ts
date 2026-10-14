// Fog of war: darkness everywhere except the local player's visibility polygon, with a soft
// radial falloff. Rendered at reduced resolution into an offscreen canvas (cheap, and the
// upscale naturally softens the edges), then composited over the world.

import { castRay, type Vec } from '../../../shared/geometry';
import { createCanvas, get2d, supportsCanvasFilter } from './util';

const RAYS = 360;
/** Rays that hit a wall continue a little so the wall's face stays visible. */
const WALL_REVEAL = 14;

export interface FogCamera {
  x: number;
  y: number;
  zoom: number;
}

export class Fog {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private scale = 0.5;
  private cssW = 1;
  private cssH = 1;
  private readonly pts = new Float32Array(RAYS * 2);
  private readonly origin: Vec = { x: 0, y: 0 };
  private keyX = NaN;
  private keyY = NaN;
  private keyR = NaN;
  private grad: CanvasGradient | null = null;
  private gradR = -1;
  private readonly blur: boolean;

  constructor() {
    this.canvas = createCanvas(2, 2);
    this.g = get2d(this.canvas);
    this.blur = supportsCanvasFilter(this.g);
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    // Fixed pixel budget (~160k px): cheap on every screen, and the bilinear upscale plus the
    // radial falloff keep the edge soft.
    this.scale = Math.max(0.18, Math.min(0.5, Math.sqrt(160_000 / Math.max(1, cssW * cssH))));
    const w = Math.max(2, Math.ceil(cssW * this.scale));
    const h = Math.max(2, Math.ceil(cssH * this.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Recomputes the visibility polygon only when the origin or radius actually changed. */
  private update(ox: number, oy: number, radius: number): void {
    if (Math.abs(ox - this.keyX) < 0.25 && Math.abs(oy - this.keyY) < 0.25 && Math.abs(radius - this.keyR) < 0.25) return;
    this.keyX = ox;
    this.keyY = oy;
    this.keyR = radius;
    this.origin.x = ox;
    this.origin.y = oy;
    const pts = this.pts;
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      let d = castRay(this.origin, a, radius);
      if (d < radius) d = Math.min(radius, d + WALL_REVEAL);
      pts[i * 2] = Math.cos(a) * d;
      pts[i * 2 + 1] = Math.sin(a) * d;
    }
  }

  /**
   * Renders the fog for a viewer at (ox, oy) with the given vision radius.
   * `cam` must be the same (shaken) camera used for the world this frame.
   */
  render(cam: FogCamera, ox: number, oy: number, radius: number, darkness: string): void {
    this.update(ox, oy, radius);
    const g = this.g;
    const k = this.scale;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.filter = 'none';
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.fillStyle = darkness;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.globalCompositeOperation = 'destination-out';
    if (this.blur) g.filter = 'blur(1.5px)';
    const s = k * cam.zoom;
    g.setTransform(s, 0, 0, s, k * (this.cssW / 2 - cam.x * cam.zoom) + ox * s, k * (this.cssH / 2 - cam.y * cam.zoom) + oy * s);
    const r = Math.round(radius);
    if (!this.grad || this.gradR !== r) {
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, r));
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.68, 'rgba(0,0,0,1)');
      grad.addColorStop(0.9, 'rgba(0,0,0,0.55)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      this.grad = grad;
      this.gradR = r;
    }
    const pts = this.pts;
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 1; i < RAYS; i++) g.lineTo(pts[i * 2], pts[i * 2 + 1]);
    g.closePath();
    g.fillStyle = this.grad;
    g.fill();
    g.filter = 'none';
    g.globalCompositeOperation = 'source-over';
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Forget the cached polygon (e.g. after a teleport the next frame recomputes anyway). */
  invalidate(): void {
    this.keyX = NaN;
  }
}
