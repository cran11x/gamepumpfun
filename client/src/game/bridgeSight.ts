// Hatch pops for other players' bridge use, as a living holder sees it.
//
// Holders are never sent a rugger inside a bridge, but interest management also leaves out anyone
// the server doesn't count as in the holder's view. So a player appearing or vanishing is not, by
// itself, a bridge exit or entry. A pop is shown only when the server's own rules leave no other
// explanation and we could see the spot: showing nothing beats pointing a false tell at someone.

import { BASE_VISION, FUD_VISION_MULT, VENT_RANGE } from '../../../shared/constants';
import { lineOfSight, type Vec } from '../../../shared/geometry';
import { VENTS, type Vent } from '../../../shared/map';
import type { MeView, PlayerView, Snapshot } from '../../../shared/protocol';

/** Snapshots further apart than this (server ms) don't show what happened in between (stall, reconnect). */
const MAX_SNAPSHOT_GAP_MS = 200;
/** How close to a hatch's center a player coming out of that bridge stands (the server puts them on it). */
const ON_HATCH_PX = 1;
/** How far from the hatch a rugger last seen before entering can be: the range, plus a tick of running. */
const ENTERED_NEAR_PX = VENT_RANGE + 30;

function ventNear(x: number, y: number, range: number): Vent | null {
  let best: Vent | null = null;
  let bd = range * range;
  for (const v of VENTS) {
    const d = (v.x - x) * (v.x - x) + (v.y - y) * (v.y - y);
    if (d <= bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

function findPlayer(list: readonly PlayerView[], id: string): PlayerView | undefined {
  for (const p of list) if (p.id === id) return p;
  return undefined;
}

/**
 * True when a player last seen at `last` (and at `before` one snapshot earlier, if known) would still
 * be in plain view: both where it was and where it was heading by now. A player who stepped behind a
 * wall or out of reach fails one of the two checks; a rugger who vented at a visible spot passes both.
 */
export function vanishedInView(canSee: (x: number, y: number) => boolean, last: Vec, before: Vec | null): boolean {
  if (!canSee(last.x, last.y)) return false;
  if (before) {
    const ax = last.x + (last.x - before.x);
    const ay = last.y + (last.y - before.y);
    if (!canSee(ax, ay)) return false;
  }
  return true;
}

/** The vision radius the client draws for `me` in `snap` (FUD applies at once; the server's lags and is wider). */
export function drawnVisionRadius(snap: Snapshot, me: MeView): number {
  const s = snap.room.settings;
  const fud = me.role === 'holder' && snap.sabotage?.kind === 'fud';
  const mult = me.role === 'rugger' ? s.ruggerVision : s.crewVision * (fud ? FUD_VISION_MULT : 1);
  return BASE_VISION * (Number.isFinite(mult) && mult > 0 ? mult : 1);
}

/**
 * Whether the server, judging from its copy of our position (`eye`, the `me` of a snapshot), counted a
 * player at `p` as in our view at that tick: within our vision radius and in line of sight from the eye.
 * Its interest test is wider (radius + margin, extra viewpoints), so such a player was in that snapshot,
 * and it keeps being sent for a while after (the interest hold) unless it enters a bridge, dies or leaves.
 */
export function plainlyInView(eye: Vec, radius: number, p: Vec): boolean {
  const dx = p.x - eye.x;
  const dy = p.y - eye.y;
  return dx * dx + dy * dy <= radius * radius && lineOfSight(eye, p);
}

export interface BridgeSightInput {
  /** The snapshot before `prev` (or null). */
  prevPrev: Snapshot | null;
  prev: Snapshot;
  snap: Snapshot;
  me: MeView;
  /** The client's fog test, as of the last drawn frame (before anything in `snap` was drawn). */
  canSee(x: number, y: number): boolean;
  /** Bridges whose hatch was in our fog when `prev` arrived. */
  ventsSeenBefore: ReadonlySet<string>;
  /** Players known to have left the room (`playerLeft` events): their vanish is no bridge. */
  departed: ReadonlySet<string>;
}

/**
 * Bridges whose hatch should pop for other players using them between `prev` and `snap`.
 *
 * Ruggers (fellow ruggers' `inVent`) and ghosts (everyone's) are told who is in a bridge. A living holder
 * has to infer it, and only does so in two cases the server leaves no other way to produce:
 * - Came out: a player who was absent appears standing still exactly on a hatch that we could see, and
 *   that the server counted as in our view one tick earlier. Anyone standing there then would have been
 *   sent, so they weren't standing there: they were inside. A player standing on a hatch who just comes
 *   into view (we walked around a corner) does not qualify, however late the server is.
 * - Went in: a player the server counted as in our view one tick earlier, near a hatch, is gone now
 *   with no body and without leaving the room, at a spot (and heading) still in our fog. The interest
 *   hold keeps a player that just left our view in the snapshots, so they didn't just walk out of it.
 */
export function bridgePops(i: BridgeSightInput): Vent[] {
  const { prev, snap, me } = i;
  const out: Vent[] = [];
  if (prev.phase !== 'playing' || snap.phase !== 'playing') return out;
  const add = (v: Vent | null) => {
    if (v && !out.includes(v) && i.canSee(v.x, v.y)) out.push(v);
  };
  const eye = prev.me;
  const gap = snap.now - prev.now;
  const infer = me.alive && me.role !== 'rugger' && !!eye && gap >= 0 && gap <= MAX_SNAPSHOT_GAP_MS;
  const radius = eye ? drawnVisionRadius(prev, me) : 0;

  for (const p of snap.players) {
    if (p.id === me.id || p.inVent || !p.alive) continue;
    const q = findPlayer(prev.players, p.id);
    if (q) {
      if (q.inVent) add(ventNear(p.x, p.y, 6));
      continue;
    }
    if (!infer || !eye || p.moving) continue;
    const v = ventNear(p.x, p.y, ON_HATCH_PX);
    if (v && i.ventsSeenBefore.has(v.id) && plainlyInView(eye, radius, v)) add(v);
  }

  for (const q of prev.players) {
    if (q.id === me.id || q.inVent || !q.alive || q.disconnected) continue;
    const p = findPlayer(snap.players, q.id);
    if (p) {
      if (p.inVent && p.alive) add(ventNear(p.x, p.y, 6));
      continue;
    }
    if (!infer || !eye || i.departed.has(q.id) || snap.bodies.some((b) => b.id === q.id)) continue;
    const v = ventNear(q.x, q.y, ENTERED_NEAR_PX);
    if (!v || !plainlyInView(eye, radius, q)) continue;
    const before = i.prevPrev?.phase === 'playing' ? findPlayer(i.prevPrev.players, q.id) : undefined;
    if (vanishedInView(i.canSee, q, before ?? null)) add(v);
  }
  return out;
}

/** Ids of the bridges whose hatch is in our fog right now. */
export function ventsInSight(canSee: (x: number, y: number) => boolean): Set<string> {
  const seen = new Set<string>();
  for (const v of VENTS) if (canSee(v.x, v.y)) seen.add(v.id);
  return seen;
}
