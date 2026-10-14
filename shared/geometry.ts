// Collision, line of sight, vision polygons and grid pathfinding on the shared map grid.

import { PLAYER_RADIUS, TILE } from './constants';
import { blocksVisionCell, isSolidCell, MAP_H, MAP_W } from './map';

export interface Vec {
  x: number;
  y: number;
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** True if a circle at (x, y) with radius r overlaps no solid cell. */
export function circleFree(x: number, y: number, r: number = PLAYER_RADIUS): boolean {
  const minTx = Math.floor((x - r) / TILE);
  const maxTx = Math.floor((x + r) / TILE);
  const minTy = Math.floor((y - r) / TILE);
  const maxTy = Math.floor((y + r) / TILE);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!isSolidCell(tx, ty)) continue;
      // Closest point on the cell to the circle center.
      const cx = Math.max(tx * TILE, Math.min(x, (tx + 1) * TILE));
      const cy = Math.max(ty * TILE, Math.min(y, (ty + 1) * TILE));
      if ((cx - x) * (cx - x) + (cy - y) * (cy - y) < r * r) return false;
    }
  }
  return true;
}

/**
 * Move a circle by (dx, dy) with axis-separated sliding collision against the grid.
 * Sub-steps so fast movement can't tunnel through 1-tile walls.
 */
export function moveWithCollision(x: number, y: number, dx: number, dy: number, r: number = PLAYER_RADIUS): Vec {
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / (r * 0.5)));
  const sx = dx / steps;
  const sy = dy / steps;
  let px = x;
  let py = y;
  for (let i = 0; i < steps; i++) {
    if (circleFree(px + sx, py, r)) px += sx;
    if (circleFree(px, py + sy, r)) py += sy;
  }
  return { x: px, y: py };
}

/**
 * Grid line of sight between two world points (walls and void block, furniture doesn't).
 * Uses an Amanatides-Woo voxel traversal.
 */
export function lineOfSight(a: Vec, b: Vec): boolean {
  let tx = Math.floor(a.x / TILE);
  let ty = Math.floor(a.y / TILE);
  const endTx = Math.floor(b.x / TILE);
  const endTy = Math.floor(b.y / TILE);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  const nextBoundX = (stepX > 0 ? tx + 1 : tx) * TILE;
  const nextBoundY = (stepY > 0 ? ty + 1 : ty) * TILE;
  let tMaxX = dx !== 0 ? Math.abs((nextBoundX - a.x) / dx) : Infinity;
  let tMaxY = dy !== 0 ? Math.abs((nextBoundY - a.y) / dy) : Infinity;
  let guard = MAP_W + MAP_H + 4;
  while (tx !== endTx || ty !== endTy) {
    if (guard-- <= 0) break;
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) break; // float error: passed the segment end
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      if (tMaxY > 1) break;
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (blocksVisionCell(tx, ty)) return false;
  }
  return true;
}

/** Distance along a ray from `o` in direction `angle` until it hits a vision-blocking cell, capped at `max`. */
export function castRay(o: Vec, angle: number, max: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let tx = Math.floor(o.x / TILE);
  let ty = Math.floor(o.y / TILE);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  let tMaxX = dx !== 0 ? Math.abs((((stepX > 0 ? tx + 1 : tx) * TILE) - o.x) / dx) : Infinity;
  let tMaxY = dy !== 0 ? Math.abs((((stepY > 0 ? ty + 1 : ty) * TILE) - o.y) / dy) : Infinity;
  let t = 0;
  while (t < max) {
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (t >= max) return max;
    if (blocksVisionCell(tx, ty)) return t;
  }
  return max;
}

/**
 * Visibility polygon around `o` with radius `radius`: an array of points (world px) in angular order.
 * Rays are cast uniformly; 360 rays is plenty for 40px tiles at typical vision radii.
 */
export function visibilityPolygon(o: Vec, radius: number, rays = 360): Vec[] {
  const pts: Vec[] = new Array(rays);
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const d = castRay(o, a, radius);
    pts[i] = { x: o.x + Math.cos(a) * d, y: o.y + Math.sin(a) * d };
  }
  return pts;
}

/** True if `target` is within `radius` of `viewer` and in line of sight. */
export function canSee(viewer: Vec, target: Vec, radius: number): boolean {
  return dist(viewer, target) <= radius && lineOfSight(viewer, target);
}

// ---------- Pathfinding (A* on walkable tiles, 8-directional, no corner cutting) ----------

export function tileOf(p: Vec): { tx: number; ty: number } {
  return { tx: Math.floor(p.x / TILE), ty: Math.floor(p.y / TILE) };
}

export function tileCenter(tx: number, ty: number): Vec {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

/** Nearest walkable tile to a world point (spiral search). */
export function nearestWalkableTile(p: Vec): { tx: number; ty: number } | null {
  const { tx, ty } = tileOf(p);
  for (let r = 0; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!isSolidCell(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
  }
  return null;
}

/**
 * Returns a list of world-space waypoints (tile centers) from `from` to `to`, excluding the start tile.
 * Returns [] if already there, null if unreachable.
 */
export function findPath(from: Vec, to: Vec): Vec[] | null {
  const s = nearestWalkableTile(from);
  const g = nearestWalkableTile(to);
  if (!s || !g) return null;
  const idx = (x: number, y: number) => y * MAP_W + x;
  const start = idx(s.tx, s.ty);
  const goal = idx(g.tx, g.ty);
  if (start === goal) return [];
  const gScore = new Float64Array(MAP_W * MAP_H).fill(Infinity);
  const came = new Int32Array(MAP_W * MAP_H).fill(-1);
  const closed = new Uint8Array(MAP_W * MAP_H);
  const h = (i: number) => {
    const x = i % MAP_W;
    const y = (i / MAP_W) | 0;
    const dx = Math.abs(x - g.tx);
    const dy = Math.abs(y - g.ty);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  // Binary heap of [f, index].
  const heap: [number, number][] = [];
  const push = (f: number, i: number) => {
    heap.push([f, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  gScore[start] = 0;
  push(h(start), start);
  const dirs = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  while (heap.length) {
    const [, cur] = pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % MAP_W;
    const cy = (cur / MAP_W) | 0;
    for (const [dx, dy, cost] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (isSolidCell(nx, ny)) continue;
      // No diagonal corner cutting.
      if (dx !== 0 && dy !== 0 && (isSolidCell(cx + dx, cy) || isSolidCell(cx, cy + dy))) continue;
      const ni = idx(nx, ny);
      const ng = gScore[cur] + cost;
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = cur;
        push(ng + h(ni), ni);
      }
    }
  }
  if (came[goal] === -1) return null;
  const path: Vec[] = [];
  for (let c = goal; c !== start; c = came[c]) path.push(tileCenter(c % MAP_W, (c / MAP_W) | 0));
  path.reverse();
  return path;
}
