// What the local player can interact with right now (see Interactions in context.ts).
// Mirrors the server's range rules; also requires line of sight so nothing is usable
// (or revealed) through walls.

import { EMERGENCY_RANGE, KILL_RANGE, REPORT_RANGE, USE_RANGE, VENT_RANGE } from '../../../shared/constants';
import { lineOfSight, type Vec } from '../../../shared/geometry';
import { EMERGENCY_BUTTON, sabotageStationById, stationById, VENTS } from '../../../shared/map';
import type { MeView, Snapshot } from '../../../shared/protocol';
import type { Interactions, UseTarget } from '../context';

export const NO_INTERACTIONS: Interactions = Object.freeze({ use: null, killTargetId: null, reportBodyId: null, ventId: null }) as Interactions;

function d2(a: Vec, x: number, y: number): number {
  const dx = a.x - x;
  const dy = a.y - y;
  return dx * dx + dy * dy;
}

const probe: Vec = { x: 0, y: 0 };
function los(a: Vec, x: number, y: number): boolean {
  probe.x = x;
  probe.y = y;
  return lineOfSight(a, probe);
}

function sameUse(a: UseTarget | null, b: UseTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  switch (a.type) {
    case 'task':
    case 'fix':
      return a.stationId === (b as typeof a).stationId && a.kind === (b as typeof a).kind;
    case 'vent':
      return a.ventId === (b as typeof a).ventId;
    case 'emergency':
      return true;
  }
}

/**
 * Computes the interactions for this frame. Returns `prev` unchanged when nothing changed,
 * so callers (the HUD) can cheaply detect changes by identity.
 */
export function computeInteractions(snap: Snapshot, me: MeView, self: Vec, inVent: boolean, prev: Interactions): Interactions {
  if (snap.phase !== 'playing') return NO_INTERACTIONS;
  let use: UseTarget | null = null;
  let killTargetId: string | null = null;
  let reportBodyId: string | null = null;
  let ventId: string | null = null;

  if (!inVent) {
    // 1. Sabotage fix consoles (living players only).
    if (me.alive && snap.sabotage) {
      let best = USE_RANGE * USE_RANGE;
      for (const s of snap.sabotage.stations) {
        if (s.fixed) continue;
        const st = sabotageStationById(s.id);
        if (!st) continue;
        const dd = d2(self, st.x, st.y);
        if (dd <= best && los(self, st.x, st.y)) {
          best = dd;
          use = { type: 'fix', stationId: st.id, kind: st.fix };
        }
      }
    }
    // 2. Own undone task consoles (ruggers: their fake list; ghosts too).
    if (!use) {
      let best = USE_RANGE * USE_RANGE;
      for (const task of me.tasks) {
        if (task.done) continue;
        const st = stationById(task.stationId);
        if (!st) continue;
        const dd = d2(self, st.x, st.y);
        if (dd <= best && los(self, st.x, st.y)) {
          best = dd;
          use = { type: 'task', stationId: st.id, kind: task.kind };
        }
      }
    }
    // 3. The SPACES button.
    if (
      !use &&
      me.alive &&
      me.emergencyLeft > 0 &&
      snap.sabotage?.kind !== 'devDump' &&
      d2(self, EMERGENCY_BUTTON.x, EMERGENCY_BUTTON.y) <= EMERGENCY_RANGE * EMERGENCY_RANGE &&
      los(self, EMERGENCY_BUTTON.x, EMERGENCY_BUTTON.y)
    ) {
      use = { type: 'emergency' };
    }

    // Rug target: nearest living non-rugger in range and in sight.
    if (me.role === 'rugger' && me.alive) {
      let best = KILL_RANGE * KILL_RANGE;
      for (const p of snap.players) {
        if (p.id === me.id || !p.alive || p.isRugger || p.inVent) continue;
        const dd = d2(self, p.x, p.y);
        if (dd <= best && los(self, p.x, p.y)) {
          best = dd;
          killTargetId = p.id;
        }
      }
    }

    // Report: nearest rugged bag in range and in sight.
    if (me.alive) {
      let best = REPORT_RANGE * REPORT_RANGE;
      for (const b of snap.bodies) {
        const dd = d2(self, b.x, b.y);
        if (dd <= best && los(self, b.x, b.y)) {
          best = dd;
          reportBodyId = b.id;
        }
      }
    }
  }

  // Bridges (living ruggers).
  if (me.role === 'rugger' && me.alive) {
    if (me.ventId) ventId = me.ventId;
    else if (!inVent) {
      let best = VENT_RANGE * VENT_RANGE;
      for (const v of VENTS) {
        const dd = d2(self, v.x, v.y);
        if (dd <= best && los(self, v.x, v.y)) {
          best = dd;
          ventId = v.id;
        }
      }
    }
  }

  if (
    sameUse(use, prev.use) &&
    killTargetId === prev.killTargetId &&
    reportBodyId === prev.reportBodyId &&
    ventId === prev.ventId
  ) {
    return prev;
  }
  return { use: sameUse(use, prev.use) ? prev.use : use, killTargetId, reportBodyId, ventId };
}
