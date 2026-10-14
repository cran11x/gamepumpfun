// Remote player interpolation: other players are rendered INTERP_DELAY_MS in the past,
// blending between the two snapshots that bracket that moment.

import type { PlayerView, Snapshot } from '../../../shared/protocol';
import type { RenderPlayer } from '../render/index';
import { hashString } from '../render/util';
import type { TimedSnapshot } from '../store';

/** Moves bigger than this between two snapshots are teleports (meeting, bridges): no lerp. */
const TELEPORT_PX = 150;

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
