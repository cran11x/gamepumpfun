import { describe, expect, it } from 'vitest';
import { vanishedInView } from '../client/src/game/bridgeSight';
import { lineOfSight, type Vec } from '../shared/geometry';
import { TILE } from '../shared/constants';
import { VENTS } from '../shared/map';

/** canSee for a viewer at `eye` with vision radius `r`, like Renderer.canSee. */
const viewer = (eye: Vec, r = 300) => (x: number, y: number) => Math.hypot(x - eye.x, y - eye.y) <= r && lineOfSight(eye, { x, y });

describe('vanishedInView (bridge vs. out of view)', () => {
  it('a player who vanishes in plain view, standing or walking, went into a bridge', () => {
    const eye = { x: 32 * TILE, y: 4 * TILE }; // Launchpad, open floor
    const see = viewer(eye);
    expect(vanishedInView(see, { x: eye.x + 100, y: eye.y + 60 }, null)).toBe(true);
    expect(vanishedInView(see, { x: eye.x + 100, y: eye.y + 60 }, { x: eye.x + 90, y: eye.y + 60 })).toBe(true);
  });

  it('a player last seen beyond the vision radius just left our reach', () => {
    const eye = { x: 32 * TILE, y: 4 * TILE };
    expect(vanishedInView(viewer(eye, 300), { x: eye.x + 310, y: eye.y }, null)).toBe(false);
  });

  it('a player walking behind a wall left our line of sight', () => {
    const see = (x: number, y: number) => x < 1000; // a wall at x = 1000
    // Last seen just before the wall, heading into it: where they were heading is hidden.
    expect(vanishedInView(see, { x: 990, y: 300 }, { x: 975, y: 300 })).toBe(false);
    // Walking away from the wall instead, still in view: that one vanished in plain sight.
    expect(vanishedInView(see, { x: 960, y: 300 }, { x: 975, y: 300 })).toBe(true);
  });

  it('works with real map walls: a vanish at a visible bridge counts, one behind a wall does not', () => {
    const vent = VENTS.find((v) => v.id === 'v_launch')!;
    const see = viewer({ x: vent.x + 120, y: vent.y });
    expect(vanishedInView(see, vent, null)).toBe(true);
    // Outside the Launchpad's top wall (y < 2 tiles is outside the station): never in line of sight.
    expect(vanishedInView(see, { x: vent.x + 120, y: 1 * TILE }, null)).toBe(false);
  });
});
