// Remote player interpolation: other players are rendered INTERP_DELAY_MS in the past,
// blending between the two snapshots that bracket that moment.

import type { PlayerView, Snapshot } from '../../../shared/protocol';
import type { RenderPlayer } from '../render/index';
import { hashString } from '../render/util';
import type { TimedSnapshot } from '../store';

/** Moves bigger than this between two snapshots are teleports (meeting, bridges): no lerp. */
const TELEPORT_PX = 150;

/** A snapshot whose arrival offset jumps by more than this (reconnect, clock change) restarts the clock. */
const CLOCK_RESYNC_MS = 1000;
/** The smoothed render time jumps instead of easing when it is this far from its target. */
const CLOCK_SNAP_MS = 250;
/** While easing toward its target, the render clock runs at most this much faster or slower than real time. */
const CLOCK_MAX_SKEW = 0.1;
/** Error (ms) at which the full skew applies; smaller errors ease proportionally. */
const CLOCK_SKEW_SPAN_MS = 250;

/**
 * The timeline remote players are rendered on, anchored to snapshot ARRIVAL rather than to the
 * latency-compensated server clock. The newest snapshot is always one-way-latency old, so
 * `serverNow - INTERP_DELAY_MS` runs past it once latency reaches ~50 ms and remotes step at 20 Hz.
 *
 * `offset` tracks (snap.now - local time) of the latest-arriving snapshots: a late packet pulls it
 * down quickly, early ones let it drift back slowly, so jitter only ever pushes rendering later.
 * The render time then advances with local time, sped up or slowed down by at most CLOCK_MAX_SKEW
 * to follow its target, so it never runs backwards (short of a CLOCK_SNAP_MS resync).
 */
export class InterpClock {
  private offset = NaN;
  private rt = NaN;
  private at = NaN;

  reset(): void {
    this.offset = NaN;
    this.rt = NaN;
    this.at = NaN;
  }

  /** At least one snapshot has been seen since the last reset. */
  get ready(): boolean {
    return Number.isFinite(this.offset);
  }

  /** Feed every snapshot on arrival: its server time and the local clock (ms) at receipt. */
  onSnapshot(serverNow: number, localNow: number): void {
    const off = serverNow - localNow;
    if (!Number.isFinite(off)) return;
    if (!this.ready || Math.abs(off - this.offset) > CLOCK_RESYNC_MS) this.offset = off;
    else if (off < this.offset) this.offset += (off - this.offset) * 0.5;
    else this.offset += (off - this.offset) * 0.03;
  }

  /** Server time to render remote players at for local time `localNow` (call once per frame). */
  renderTime(localNow: number, delayMs: number): number {
    const target = localNow + this.offset - delayMs;
    const dt = localNow - this.at;
    if (!Number.isFinite(this.rt) || !(dt >= 0) || Math.abs(target - this.rt) > CLOCK_SNAP_MS) {
      this.rt = target;
    } else {
      // Error left after advancing at real speed.
      const err = target - (this.rt + dt);
      const skew = Math.max(-CLOCK_MAX_SKEW, Math.min(CLOCK_MAX_SKEW, err / CLOCK_SKEW_SPAN_MS));
      this.rt += dt * (1 + skew);
    }
    this.at = localNow;
    return this.rt;
  }
}

interface Remote extends RenderPlayer {
  stamp: number;
}

function findPlayer(list: readonly PlayerView[], id: string): PlayerView | undefined {
  for (const p of list) if (p.id === id) return p;
  return undefined;
}

export class RemoteInterpolator {
  /** Interpolated remote players for this frame (self excluded). */
  readonly list: RenderPlayer[] = [];
  private readonly byId = new Map<string, Remote>();
  private stamp = 0;

  clear(): void {
    this.list.length = 0;
    this.byId.clear();
  }

  get(id: string): RenderPlayer | undefined {
    return this.byId.get(id);
  }

  update(history: readonly TimedSnapshot[], renderTime: number, selfId: string | null, dt: number): void {
    if (history.length === 0) {
      this.clear();
      return;
    }
    const first = history[0].snap;
    const last = history[history.length - 1].snap;
    let a: Snapshot = last;
    let b: Snapshot = last;
    if (renderTime <= first.now) {
      a = first;
      b = first;
    } else if (renderTime < last.now) {
      for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].snap.now <= renderTime) {
          a = history[i].snap;
          b = history[i + 1].snap;
          break;
        }
      }
    }
    const span = b.now - a.now;
    const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - a.now) / span)) : 1;
    const stamp = ++this.stamp;

    for (const pb of b.players) {
      if (pb.id === selfId) continue;
      let x = pb.x;
      let y = pb.y;
      if (a !== b) {
        const pa = findPlayer(a.players, pb.id);
        if (pa && !!pa.inVent === !!pb.inVent && pa.alive === pb.alive) {
          const d = Math.hypot(pb.x - pa.x, pb.y - pa.y);
          if (d < TELEPORT_PX) {
            x = pa.x + (pb.x - pa.x) * t;
            y = pa.y + (pb.y - pa.y) * t;
          }
        }
      }
      let r = this.byId.get(pb.id);
      if (!r) {
        r = {
          id: pb.id,
          name: pb.name,
          color: pb.color,
          x,
          y,
          facing: pb.facing,
          moving: false,
          walk: 0,
          alive: pb.alive,
          isRugger: !!pb.isRugger,
          inVent: !!pb.inVent,
          disconnected: !!pb.disconnected,
          seed: hashString(pb.id) % 1000,
          cosmetics: pb.cosmetics,
          stamp,
        };
        this.byId.set(pb.id, r);
        this.list.push(r);
      }
      const moved = Math.hypot(x - r.x, y - r.y);
      if (moved < TELEPORT_PX) r.walk += moved * 0.11;
      if (pb.moving && moved < 0.05) r.walk += dt * 2;
      r.x = x;
      r.y = y;
      r.name = pb.name;
      r.color = pb.color;
      r.facing = pb.facing === -1 ? -1 : 1;
      r.moving = pb.moving && !pb.inVent;
      r.alive = pb.alive;
      r.isRugger = !!pb.isRugger;
      r.inVent = !!pb.inVent;
      r.disconnected = !!pb.disconnected;
      r.cosmetics = pb.cosmetics;
      r.stamp = stamp;
    }

    // Players that disappeared (left, vented out of sight for non-ruggers, died for the living).
    if (this.byId.size !== this.list.length || this.list.some((p) => (p as Remote).stamp !== stamp)) {
      for (let i = this.list.length - 1; i >= 0; i--) {
        const p = this.list[i] as Remote;
        if (p.stamp !== stamp) {
          this.list.splice(i, 1);
          this.byId.delete(p.id);
        }
      }
    }
  }
}
