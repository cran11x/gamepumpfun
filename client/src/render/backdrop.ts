// Home / lobby backdrop: a few pills wandering the station while the camera slowly drifts
// after the "leader". Uses the shared pathfinding + collision, so it looks like real play.

import { BASE_SPEED, PLAYER_COLORS } from '../../../shared/constants';
import { findPath, moveWithCollision, type Vec } from '../../../shared/geometry';
import { ROOMS, SPAWN_POINTS, TASK_STATIONS, VENTS } from '../../../shared/map';
import { TILE } from '../../../shared/constants';
import { mulberry32 } from './util';

export interface Wanderer {
  x: number;
  y: number;
  color: number;
  /** Pill skin (a lobby player's equipped skin), if any. */
  skin?: string;
  facing: 1 | -1;
  moving: boolean;
  walk: number;
  seed: number;
  path: Vec[] | null;
  pi: number;
  wait: number;
  speed: number;
  stuck: number;
}

const MIN_PILLS = 6;
const MAX_PILLS = 9;

/** Interesting walkable spots: consoles, bridges and room interiors. */
const TARGETS: Vec[] = [
  ...TASK_STATIONS.map((s) => ({ x: s.x, y: s.y + 26 })),
  ...VENTS.map((v) => ({ x: v.x, y: v.y + 30 })),
  ...ROOMS.map((r) => ({ x: (r.rect.x + 1.5) * TILE, y: (r.rect.y + r.rect.h - 1.5) * TILE })),
  ...SPAWN_POINTS,
];

export class Backdrop {
  readonly pills: Wanderer[] = [];
  private readonly rnd = mulberry32(0xa11ce);
  private colorsKey = '';

  /**
   * Keep the pill set in sync with the given colors (lobby players), padded with random ones.
   * `skins[i]` is the pill skin worn by the player with `colors[i]`.
   */
  sync(colors: readonly number[], skins?: readonly (string | undefined)[]): void {
    const key = skins ? colors.join(',') + '|' + skins.join(',') : colors.join(',');
    if (key === this.colorsKey && this.pills.length > 0) return;
    this.colorsKey = key;
    const wanted: number[] = [];
    const wantedSkins: (string | undefined)[] = [];
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      if (wanted.includes(c) || wanted.length >= MAX_PILLS) continue;
      wanted.push(c);
      wantedSkins.push(skins?.[i]);
    }
    let guard = 0;
    while (wanted.length < MIN_PILLS && guard++ < 100) {
      const c = Math.floor(this.rnd() * PLAYER_COLORS.length);
      if (!wanted.includes(c)) wanted.push(c);
    }
    while (this.pills.length > wanted.length) this.pills.pop();
    for (let i = 0; i < wanted.length; i++) {
      const existing = this.pills[i];
      if (existing) {
        existing.color = wanted[i];
        existing.skin = wantedSkins[i];
        continue;
      }
      const sp = SPAWN_POINTS[i % SPAWN_POINTS.length];
      this.pills.push({
        x: sp.x,
        y: sp.y,
        color: wanted[i],
        skin: wantedSkins[i],
        facing: this.rnd() < 0.5 ? 1 : -1,
        moving: false,
        walk: 0,
        seed: Math.floor(this.rnd() * 1000),
        path: null,
        pi: 0,
        wait: 0.3 + this.rnd() * 2,
        speed: BASE_SPEED * (0.55 + this.rnd() * 0.2),
        stuck: 0,
      });
    }
  }

  /** Where the camera should look. */
  focus(): Vec {
    const l = this.pills[0];
    return l ? { x: l.x, y: l.y } : SPAWN_POINTS[0];
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.1);
    const leader = this.pills[0];
    for (let i = 0; i < this.pills.length; i++) {
      const p = this.pills[i];
      p.moving = false;
      if (!p.path || p.pi >= p.path.length) {
        p.wait -= step;
        if (p.wait > 0) continue;
        this.pickTarget(p, i === 0 ? null : leader);
        p.wait = 0.6 + this.rnd() * 2.4;
        continue;
      }
      const wp = p.path[p.pi];
      const dx = wp.x - p.x;
      const dy = wp.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 6) {
        p.pi++;
        continue;
      }
      const s = Math.min(d, p.speed * step);
      const next = moveWithCollision(p.x, p.y, (dx / d) * s, (dy / d) * s);
      const moved = Math.hypot(next.x - p.x, next.y - p.y);
      if (Math.abs(dx) > 0.5) p.facing = dx > 0 ? 1 : -1;
      p.x = next.x;
      p.y = next.y;
      p.moving = moved > 0.05;
      p.walk += moved * 0.11;
      if (moved < 0.1) {
        p.stuck += step;
        if (p.stuck > 0.8) {
          p.path = null;
          p.stuck = 0;
        }
      } else {
        p.stuck = 0;
      }
    }
  }

  private pickTarget(p: Wanderer, leader: Wanderer | null): void {
    let candidates = TARGETS;
    if (leader) {
      const near = TARGETS.filter((t) => Math.hypot(t.x - leader.x, t.y - leader.y) < 650);
      if (near.length > 1) candidates = near;
    } else {
      const far = TARGETS.filter((t) => Math.hypot(t.x - p.x, t.y - p.y) > 500);
      if (far.length > 0) candidates = far;
    }
    const target = candidates[Math.floor(this.rnd() * candidates.length)];
    const path = findPath(p, target);
    p.path = path && path.length > 0 ? path : null;
    p.pi = 0;
  }
}
