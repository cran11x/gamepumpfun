import { describe, expect, it } from 'vitest';
import { INTERP_DELAY_MS } from '../shared/constants';
import type { PlayerView, Snapshot } from '../shared/protocol';
import type { TimedSnapshot } from '../client/src/store';
import { InterpClock, RemoteInterpolator } from '../client/src/game/interp';

const SNAP_MS = 50;
const FRAME_MS = 1000 / 60;
/** The remote walks right at 200 px/s of server time. */
const SPEED = 0.2;
/** Local clocks share no origin with the server clock. */
const LOCAL_SHIFT = -1_234_567;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function snapAt(now: number): Snapshot {
  const walker: PlayerView = { id: 'walker', name: 'walker', color: 1, x: 100 + (now % 100_000) * SPEED, y: 300, facing: 1, moving: true, alive: true, isBot: false };
  return { t: 'snap', now, phase: 'playing', players: [walker], bodies: [] } as unknown as Snapshot;
}

interface Frame {
  local: number;
  rt: number;
  first: number;
  last: number;
  x: number;
}

/**
 * 20 Hz snapshots delivered in order after `delay(k)` ms, rendered at 60 fps.
 * `timeline(local, clock)` gives the render time for a frame.
 */
function runWith(delay: (k: number) => number, seconds: number, timeline: (local: number, clock: InterpClock) => number): Frame[] {
  const arrivals: { at: number; snap: Snapshot }[] = [];
  let lastAt = -Infinity;
  for (let k = 0; k * SNAP_MS < seconds * 1000 + 1000; k++) {
    const now = 1_000_000 + k * SNAP_MS;
    const at = Math.max(lastAt, now + LOCAL_SHIFT + delay(k));
    lastAt = at;
    arrivals.push({ at, snap: snapAt(now) });
  }
  const clock = new InterpClock();
  const remotes = new RemoteInterpolator();
  const history: TimedSnapshot[] = [];
  const frames: Frame[] = [];
  let next = 0;
  const start = arrivals[0].at + 1;
  for (let local = start; local < start + seconds * 1000; local += FRAME_MS) {
    while (next < arrivals.length && arrivals[next].at <= local) {
      const a = arrivals[next++];
      history.push({ snap: a.snap, recvAt: a.at });
      if (history.length > 30) history.shift();
      clock.onSnapshot(a.snap.now, a.at);
    }
    const rt = timeline(local, clock);
    remotes.update(history, rt, 'me', FRAME_MS / 1000);
    frames.push({ local, rt, first: history[0].snap.now, last: history[history.length - 1].snap.now, x: remotes.get('walker')!.x });
  }
  return frames;
}

/** Latency plus uniform 0..jitter ms, from a fixed seed. */
function run(latency: number, jitter: number, seconds: number, timeline: (local: number, clock: InterpClock) => number): Frame[] {
  const rand = rng(latency * 1000 + jitter + 7);
  return runWith(() => latency + rand() * jitter, seconds, timeline);
}

const arrivalTimeline = (local: number, clock: InterpClock) => clock.renderTime(local, INTERP_DELAY_MS);

describe('InterpClock: remote players on a timeline anchored to snapshot arrival', () => {
  const cases: [string, number, number][] = [
    ['no latency', 0, 0],
    ['80 ms', 80, 0],
    ['200 ms', 200, 0],
    ['120 ms + 0-40 ms jitter', 120, 40],
    ['60 ms + 0-40 ms jitter', 60, 40],
  ];
  for (const [name, latency, jitter] of cases) {
    it(`always renders between two received snapshots and moves smoothly (${name})`, () => {
      const frames = run(latency, jitter, 12, arrivalTimeline).slice(120); // after a 2 s warm-up
      const step = SPEED * FRAME_MS;
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        // Strictly inside the history: there is always a newer snapshot to interpolate toward.
        expect(f.rt).toBeGreaterThan(f.first);
        expect(f.rt).toBeLessThan(f.last);
        if (i === 0) continue;
        const p = frames[i - 1];
        // Never backwards, never more than 10% off real time.
        expect(f.rt - p.rt).toBeGreaterThanOrEqual(FRAME_MS * 0.9 - 1e-6);
        expect(f.rt - p.rt).toBeLessThanOrEqual(FRAME_MS * 1.1 + 1e-6);
        // So the remote walks every frame instead of stepping at 20 Hz.
        expect(f.x - p.x).toBeGreaterThan(step * 0.85);
        expect(f.x - p.x).toBeLessThan(step * 1.15);
      }
    });
  }

  it('adds no more than the jitter on top of the latency and INTERP_DELAY_MS', () => {
    const frames = run(80, 0, 6, arrivalTimeline).slice(120);
    for (const f of frames) {
      const serverNow = f.local - LOCAL_SHIFT;
      expect(serverNow - f.rt).toBeGreaterThan(80 + INTERP_DELAY_MS - 5);
      expect(serverNow - f.rt).toBeLessThan(80 + INTERP_DELAY_MS + 5);
    }
  });

  it('the latency-compensated server clock (the old timeline) runs past the newest snapshot at 80 ms', () => {
    const frames = run(80, 0, 6, (local) => local - LOCAL_SHIFT - INTERP_DELAY_MS).slice(120);
    expect(frames.filter((f) => f.rt >= f.last).length).toBeGreaterThan(frames.length * 0.3);
  });

  it('eases toward a late packet without running backwards', () => {
    // 80 ms, but every 40th snapshot (and the ones queued behind it) is 45 ms late.
    const frames = runWith((k) => (k % 40 === 39 ? 125 : 80), 12, arrivalTimeline).slice(120);
    for (let i = 1; i < frames.length; i++) {
      const d = frames[i].rt - frames[i - 1].rt;
      expect(d).toBeGreaterThanOrEqual(FRAME_MS * 0.9 - 1e-6);
      expect(d).toBeLessThanOrEqual(FRAME_MS * 1.1 + 1e-6);
      expect(frames[i].rt).toBeGreaterThan(frames[i].first);
    }
  });

  it('restarts on a clock jump and after reset', () => {
    const clock = new InterpClock();
    expect(clock.ready).toBe(false);
    clock.onSnapshot(10_000, 0);
    expect(clock.ready).toBe(true);
    expect(clock.renderTime(0, 100)).toBe(9_900);
    // Reconnected to a server whose clock is 5 s ahead: no slow 10% catch-up.
    clock.onSnapshot(15_050, 50);
    expect(clock.renderTime(50, 100)).toBe(14_950);
    clock.reset();
    expect(clock.ready).toBe(false);
  });
});
