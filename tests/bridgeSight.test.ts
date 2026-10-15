import { describe, expect, it } from 'vitest';
import { bridgePops, drawnVisionRadius, plainlyInView, vanishedInView, ventsInSight } from '../client/src/game/bridgeSight';
import { lineOfSight, type Vec } from '../shared/geometry';
import { BASE_SPEED, BASE_VISION, DEFAULT_SETTINGS, PLAYER_RADIUS, SERVER_TICK_HZ, TILE } from '../shared/constants';
import { VENTS } from '../shared/map';
import type { BodyView, MeView, PlayerView, RoomView, Snapshot } from '../shared/protocol';

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

// ---------- bridgePops ----------

const VENT = VENTS.find((v) => v.id === 'v_rpc')!; // (460, 740) in the RPC Node
/** A spot north of the hatch with a wall in between, and one further south that sees it. */
const HIDDEN = { x: 381.3, y: 523.9 };
const SEES = { x: 381.3, y: 663.9 };
const ROOM = { code: 'TEST', hostId: 'h', settings: { ...DEFAULT_SETTINGS }, ticker: 'RUGS' } as RoomView;

function meView(pos: Vec, role: 'holder' | 'rugger' = 'holder', alive = true): MeView {
  return { id: 'me', role, alive, x: pos.x, y: pos.y, teleportSeq: 1, tasks: [], activeStationId: null, emergencyLeft: 1 };
}

function pv(id: string, pos: Vec, extra: Partial<PlayerView> = {}): PlayerView {
  return { id, name: id, color: 1, x: pos.x, y: pos.y, facing: 1, moving: false, alive: true, isBot: false, ...extra };
}

function snapAt(now: number, me: MeView, players: PlayerView[], bodies: BodyView[] = []): Snapshot {
  return { t: 'snap', now, phase: 'playing', room: ROOM, players: [pv('me', me), ...players], bodies, taskProgress: 0, sabotage: null, me };
}

interface Case {
  prev: Snapshot;
  snap: Snapshot;
  prevPrev?: Snapshot | null;
  /** Where the client draws from (its predicted position, ahead of the server's copy). */
  eye: Vec;
  seenBefore?: ReadonlySet<string>;
  departed?: ReadonlySet<string>;
}

function pops(c: Case): string[] {
  const canSee = viewer(c.eye);
  return bridgePops({
    prevPrev: c.prevPrev ?? null,
    prev: c.prev,
    snap: c.snap,
    me: c.snap.me!,
    canSee,
    ventsSeenBefore: c.seenBefore ?? ventsInSight(canSee),
    departed: c.departed ?? new Set(),
  }).map((v) => v.id);
}

describe('bridgePops: what a living holder infers', () => {
  it('the test spots are what they claim', () => {
    expect(lineOfSight(HIDDEN, VENT)).toBe(false);
    expect(plainlyInView(SEES, BASE_VISION, VENT)).toBe(true);
    expect(drawnVisionRadius(snapAt(0, meView(SEES), []), meView(SEES))).toBe(BASE_VISION * DEFAULT_SETTINGS.crewVision);
  });

  it('a rugger coming out of a bridge we are watching pops it', () => {
    const me = meView(SEES);
    expect(pops({ prev: snapAt(1000, me, []), snap: snapAt(1050, me, [pv('r', VENT)]), eye: SEES })).toEqual(['v_rpc']);
  });

  it('a rugger going into a bridge we are watching pops it', () => {
    const me = meView(SEES);
    const near = { x: VENT.x + 25, y: VENT.y - 10 };
    expect(pops({ prev: snapAt(1000, me, [pv('r', near)]), snap: snapAt(1050, me, []), eye: SEES })).toEqual(['v_rpc']);
  });

  it('someone standing on a hatch who comes into view as we round the corner is no bridge exit', () => {
    // Our client already shows the hatch (it draws from where we are now); the server, a little behind,
    // only now counts the spot as in view and starts sending the player standing there.
    const prevMe = meView({ x: HIDDEN.x, y: 600 });
    const me = meView({ x: HIDDEN.x, y: 610 });
    expect(lineOfSight(prevMe, VENT)).toBe(false);
    expect(pops({ prev: snapAt(1000, prevMe, []), snap: snapAt(1050, me, [pv('r', VENT)]), eye: SEES, seenBefore: new Set(['v_rpc']) })).toEqual([]);
  });

  it('an exit pops only if the hatch was already in our fog before the player appeared', () => {
    const me = meView(SEES);
    expect(pops({ prev: snapAt(1000, me, []), snap: snapAt(1050, me, [pv('r', VENT)]), eye: SEES, seenBefore: new Set() })).toEqual([]);
  });

  it('a player walking across a hatch, or appearing near one but not on it, is no exit', () => {
    const me = meView(SEES);
    const prev = snapAt(1000, me, []);
    expect(pops({ prev, snap: snapAt(1050, me, [pv('w', VENT, { moving: true })]), eye: SEES })).toEqual([]);
    expect(pops({ prev, snap: snapAt(1050, me, [pv('w', { x: VENT.x + 4, y: VENT.y })]), eye: SEES })).toEqual([]);
  });

  it('a player who walks out of the server view near a hatch is no bridge entry, even if our fog still shows the spot', () => {
    // The server stopped counting them a while ago (behind the wall from its copy of us) and its hold ran
    // out; our client, a step ahead, still sees where they were.
    const prevMe = meView(HIDDEN);
    const near = { x: VENT.x + 20, y: VENT.y };
    expect(lineOfSight(prevMe, near)).toBe(false);
    expect(pops({ prev: snapAt(1000, prevMe, [pv('w', near)]), snap: snapAt(1050, prevMe, []), eye: SEES })).toEqual([]);
  });

  it('vanishing because of a rug, leaving the room or a disconnect is no bridge entry', () => {
    const me = meView(SEES);
    const near = { x: VENT.x + 20, y: VENT.y };
    const prev = snapAt(1000, me, [pv('v', near)]);
    expect(pops({ prev, snap: snapAt(1050, me, [], [{ id: 'v', color: 1, x: near.x, y: near.y }]), eye: SEES })).toEqual([]);
    expect(pops({ prev, snap: snapAt(1050, me, []), eye: SEES, departed: new Set(['v']) })).toEqual([]);
    expect(pops({ prev: snapAt(1000, me, [pv('v', near, { disconnected: true })]), snap: snapAt(1050, me, []), eye: SEES })).toEqual([]);
  });

  it('nothing is inferred across a gap in the snapshots (stall, reconnect)', () => {
    const me = meView(SEES);
    expect(pops({ prev: snapAt(1000, me, []), snap: snapAt(1600, me, [pv('r', VENT)]), eye: SEES })).toEqual([]);
    expect(pops({ prev: snapAt(1000, me, [pv('r', VENT)]), snap: snapAt(1600, me, []), eye: SEES })).toEqual([]);
  });

  it('a hatch outside our fog never pops', () => {
    const me = meView(SEES);
    expect(pops({ prev: snapAt(1000, me, []), snap: snapAt(1050, me, [pv('r', VENT)]), eye: HIDDEN, seenBefore: new Set(['v_rpc']) })).toEqual([]);
  });

  it('ruggers go by the inVent flag, never by appearances', () => {
    const me = meView(SEES, 'rugger');
    const prev = snapAt(1000, me, [pv('f', VENT, { inVent: true, isRugger: true })]);
    expect(pops({ prev, snap: snapAt(1050, me, [pv('f', VENT, { isRugger: true })]), eye: SEES })).toEqual(['v_rpc']);
    expect(pops({ prev: snapAt(1000, me, []), snap: snapAt(1050, me, [pv('h', VENT)]), eye: SEES })).toEqual([]);
    expect(pops({ prev: snapAt(1000, me, [pv('h', { x: VENT.x + 20, y: VENT.y })]), snap: snapAt(1050, me, []), eye: SEES })).toEqual([]);
  });
});

describe('bridgePops against a model of interest management', () => {
  /**
   * The server sends a player while it is within reach and in line of sight of the viewer's server copy
   * (center or a point one radius off), then holds it for 600 ms. The client draws from a position
   * `lagMs` ahead of that copy. A player stands on the hatch the whole time and never uses it.
   */
  function walkIntoView(lagMs: number, from: Vec, to: Vec): string[] {
    const tick = 1000 / SERVER_TICK_HZ;
    const speed = BASE_SPEED / 1000;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const posAt = (t: number) => {
      const d = Math.min(len, Math.max(0, t * speed));
      return { x: from.x + ((to.x - from.x) * d) / len, y: from.y + ((to.y - from.y) * d) / len };
    };
    const reach = BASE_VISION * DEFAULT_SETTINGS.crewVision + 120;
    const qualifies = (eye: Vec, p: Vec) => {
      if (Math.hypot(p.x - eye.x, p.y - eye.y) > reach) return false;
      const pts = [p, { x: p.x + PLAYER_RADIUS, y: p.y }, { x: p.x - PLAYER_RADIUS, y: p.y }, { x: p.x, y: p.y + PLAYER_RADIUS }, { x: p.x, y: p.y - PLAYER_RADIUS }];
      return pts.some((q) => lineOfSight(eye, q));
    };
    const all: string[] = [];
    let lastQualified = -Infinity;
    let prev: Snapshot | null = null;
    let prevPrev: Snapshot | null = null;
    let seenBefore: ReadonlySet<string> = new Set();
    for (let t = 0; t <= (len / speed) + 1500; t += tick) {
      const server = posAt(t - lagMs);
      if (qualifies(server, VENT)) lastQualified = t;
      const sent = t - lastQualified <= 600;
      const snap = snapAt(t, meView(server), sent ? [pv('r', VENT)] : []);
      const canSee = viewer(posAt(t));
      if (prev) all.push(...bridgePops({ prevPrev, prev, snap, me: snap.me!, canSee, ventsSeenBefore: seenBefore, departed: new Set() }).map((v) => v.id));
      seenBefore = ventsInSight(canSee);
      prevPrev = prev;
      prev = snap;
    }
    return all;
  }

  it('someone idle on a hatch never pops as we walk into view, at any latency', () => {
    for (const lag of [0, 60, 120, 200, 300, 500]) {
      expect(walkIntoView(lag, HIDDEN, SEES), `lag ${lag} ms`).toEqual([]);
      expect(walkIntoView(lag, SEES, HIDDEN), `lag ${lag} ms, walking away`).toEqual([]);
    }
  });
});
