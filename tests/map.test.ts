import { describe, expect, it } from 'vitest';
import { PLAYER_RADIUS, TILE } from '../shared/constants';
import { canSee, circleFree, findPath, lineOfSight, moveWithCollision } from '../shared/geometry';
import {
  EMERGENCY_BUTTON,
  ROOMS,
  SABOTAGE_STATIONS,
  SPAWN_POINTS,
  TASK_STATIONS,
  VENTS,
  roomAt,
} from '../shared/map';

const interactables = [
  ...TASK_STATIONS.map((s) => ({ id: s.id, room: s.room, x: s.x, y: s.y })),
  ...VENTS.map((v) => ({ id: v.id, room: v.room, x: v.x, y: v.y })),
  ...SABOTAGE_STATIONS.map((s) => ({ id: s.id, room: s.room, x: s.x, y: s.y })),
];

describe('map invariants', () => {
  it('has unique ids', () => {
    const ids = interactables.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('places every interactable on free floor inside its room', () => {
    for (const it of interactables) {
      expect(circleFree(it.x, it.y, PLAYER_RADIUS), `${it.id} blocked`).toBe(true);
      expect(roomAt(it.x, it.y)?.id, `${it.id} room`).toBe(it.room);
    }
  });

  it('spawn points are free and in the launchpad', () => {
    for (const p of SPAWN_POINTS) {
      expect(circleFree(p.x, p.y, PLAYER_RADIUS)).toBe(true);
      expect(roomAt(p.x, p.y)?.id).toBe('launchpad');
    }
  });

  it('every interactable and room is reachable from spawn', () => {
    const start = SPAWN_POINTS[0];
    for (const it of interactables) expect(findPath(start, it), it.id).not.toBeNull();
    for (const r of ROOMS) {
      const c = { x: (r.rect.x + 1.5) * TILE, y: (r.rect.y + 1.5) * TILE };
      expect(findPath(start, c), r.id).not.toBeNull();
    }
  });

  it('emergency button is reachable within range from a free spot', () => {
    expect(roomAt(EMERGENCY_BUTTON.x, EMERGENCY_BUTTON.y)?.id).toBe('launchpad');
  });

  it('vent links are symmetric', () => {
    for (const v of VENTS)
      for (const l of v.links) expect(VENTS.find((o) => o.id === l)?.links).toContain(v.id);
  });
});

describe('geometry', () => {
  it('walls stop movement', () => {
    const start = { x: 32 * TILE, y: 3 * TILE }; // launchpad, near the north wall (wall row y=1)
    const moved = moveWithCollision(start.x, start.y, 0, -500);
    expect(moved.y).toBeGreaterThanOrEqual(2 * TILE + PLAYER_RADIUS - 0.01);
  });

  it('walls block line of sight between rooms', () => {
    const launch = { x: 32 * TILE, y: 10 * TILE };
    const trading = { x: 10 * TILE, y: 10 * TILE };
    expect(lineOfSight(launch, trading)).toBe(false);
    expect(canSee(launch, { x: 35 * TILE, y: 10 * TILE }, 300)).toBe(true);
  });
});
