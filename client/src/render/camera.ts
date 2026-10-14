// Camera: smooth follow + zoom so that about 2.4 x BASE_VISION fits the shorter screen side.

import { BASE_VISION } from '../../../shared/constants';
import { WORLD_H, WORLD_W } from '../../../shared/map';
import { clamp, damp } from './util';

export class Camera {
  x = WORLD_W / 2;
  y = WORLD_H / 2;
  zoom = 1;

  static zoomFor(cssW: number, cssH: number): number {
    return clamp(Math.min(cssW, cssH) / (2.4 * BASE_VISION), 0.5, 1.6);
  }

  follow(tx: number, ty: number, dt: number, rate: number): void {
    this.x = damp(this.x, tx, rate, dt);
    this.y = damp(this.y, ty, rate, dt);
    // Never lag absurdly far behind (e.g. after a long frame).
    const dx = tx - this.x;
    const dy = ty - this.y;
    const max = 600;
    const d = Math.hypot(dx, dy);
    if (d > max) {
      this.x = tx - (dx / d) * max;
      this.y = ty - (dy / d) * max;
    }
  }

  snap(tx: number, ty: number): void {
    this.x = tx;
    this.y = ty;
  }
}
