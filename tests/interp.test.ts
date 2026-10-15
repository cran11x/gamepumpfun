import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTERP_DELAY_MS } from '../shared/constants';
import { WORLD_H, WORLD_W } from '../shared/map';
import type { PlayerView, Snapshot } from '../shared/protocol';
import type { TimedSnapshot } from '../client/src/store';
import { InterpClock, RemoteInterpolator } from '../client/src/game/interp';
import { NO_INTERACTIONS } from '../client/src/game/interactions';
import { Renderer, type RenderPlayer, type WorldView } from '../client/src/render/index';
import { buildStaticTiles, STATIC_TILE_PX, StaticMap } from '../client/src/render/staticMap';

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

// ---------- render/: the static layers (the render-side tests live here) ----------

type DrawArgs = number[];

/** A 2D context that draws nothing: methods are no-ops, drawImage calls are logged. */
function fakeContext(drawn?: DrawArgs[]): CanvasRenderingContext2D {
  const props: Record<string | symbol, unknown> = {};
  const gradient = { addColorStop() {} };
  return new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => gradient;
      if (k === 'measureText') return (text: string) => ({ width: String(text).length * 6 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (k === 'drawImage') return (_img: unknown, ...a: number[]) => drawn?.push(a);
      return () => {};
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function fakeCanvas(drawn?: DrawArgs[]): HTMLCanvasElement {
  const g = fakeContext(drawn);
  return { width: 300, height: 150, style: {}, clientWidth: 0, clientHeight: 0, getContext: () => g } as unknown as HTMLCanvasElement;
}

/** Just enough DOM for the renderer: canvases, a window size, Path2D, and a clock that ticks 1 ms per read. */
function fakeDom(size: { w: number; h: number }): { now: () => number; advance: (ms: number) => void } {
  let t = 1000;
  vi.stubGlobal('document', { createElement: () => fakeCanvas() });
  vi.stubGlobal('window', {
    get innerWidth() {
      return size.w;
    },
    get innerHeight() {
      return size.h;
    },
    devicePixelRatio: 1,
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal(
    'Path2D',
    class {
      moveTo() {}
      lineTo() {}
    },
  );
  vi.spyOn(performance, 'now').mockImplementation(() => (t += 1));
  return { now: () => t, advance: (ms) => (t += ms) };
}

function worldView(): WorldView {
  const self: RenderPlayer = { id: 'me', name: 'me', color: 0, x: 1280, y: 300, facing: 1, moving: false, walk: 0, alive: true, isRugger: false, inVent: false, disconnected: false, seed: 1 };
  return {
    phase: 'playing',
    self,
    selfVentId: null,
    role: 'holder',
    viewerDead: false,
    noFog: false,
    visionRadius: 300,
    fud: false,
    remotes: [],
    bodies: [],
    sabotage: null,
    taskGlow: [],
    interactions: NO_INTERACTIONS,
    snapCamera: true,
    serverNow: 0,
  };
}

interface RendererInternals {
  builtScale: number;
  job: Generator<void, void, void> | null;
  staticMap: StaticMap;
}

describe('static map rebuild', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the tiles cover the whole world, and draw() leaves no gap between them', () => {
    fakeDom({ w: 800, h: 600 });
    const job = buildStaticTiles(1.75);
    let steps = 0;
    let r = job.next();
    while (!r.done) {
      steps++;
      r = job.next();
    }
    // Many small steps, not one big one.
    expect(steps).toBeGreaterThan(100);
    const map = new StaticMap();
    map.use(r.value);
    for (const [x0, y0, x1, y1] of [
      [-50, -40, 900, 700],
      [1000.3, 610.7, 2310.9, 1371.2],
      [WORLD_W - 700, WORLD_H - 500, WORLD_W + 60, WORLD_H + 60],
    ]) {
      const drawn: DrawArgs[] = [];
      map.draw(fakeContext(drawn), x0, y0, x1, y1);
      expect(drawn.length).toBeGreaterThan(1);
      const dests = drawn.map(([, , , , dx, dy, dw, dh]) => ({ x0: dx, y0: dy, x1: dx + dw, y1: dy + dh }));
      // Every point of the view inside the world is painted, boundaries between tiles included.
      for (let y = Math.max(0, y0); y < Math.min(WORLD_H, y1); y += 7.3) {
        for (let x = Math.max(0, x0); x < Math.min(WORLD_W, x1); x += 7.3) {
          expect(dests.some((d) => x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1)).toBe(true);
        }
      }
      for (const b of [STATIC_TILE_PX, 2 * STATIC_TILE_PX, 3 * STATIC_TILE_PX, 4 * STATIC_TILE_PX]) {
        if (b <= x0 || b >= x1) continue;
        // Across a tile edge, the left tile reaches past it (no hairline seam).
        expect(dests.some((d) => d.x0 < b - 0.5 && d.x1 > b + 0.5)).toBe(true);
      }
    }
  });

  it('after the window grows, the rebuild is spread over many frames and swaps in complete', () => {
    const size = { w: 800, h: 600 };
    const dom = fakeDom(size);
    const r = new Renderer(fakeCanvas());
    const inner = r as unknown as RendererInternals;
    expect(inner.builtScale).toBe(1);
    expect(inner.job).toBeNull();
    size.w = 1920;
    size.h = 1080;
    r.skipFrame(1 / 60); // notices the new size, waits for it to settle
    expect(inner.job).toBeNull();
    dom.advance(500);
    const oldMap = inner.staticMap.scale;
    let frames = 0;
    let maxFrameMs = 0;
    while (inner.builtScale === 1 && frames < 1000) {
      const t0 = dom.now();
      r.skipFrame(1 / 60);
      maxFrameMs = Math.max(maxFrameMs, dom.now() - t0);
      frames++;
      if (inner.builtScale === 1) expect(inner.staticMap.scale).toBe(oldMap); // the old map stays meanwhile
    }
    expect(inner.builtScale).toBe(1.5);
    expect(inner.staticMap.scale).toBe(1.5);
    expect(inner.job).toBeNull();
    expect(frames).toBeGreaterThan(20);
    // The fake clock ticks once per read: the frame budget holds a handful of steps.
    expect(maxFrameMs).toBeLessThanOrEqual(12);
  });

  it('a pending rebuild never advances on frames that draw the world', () => {
    const size = { w: 800, h: 600 };
    const dom = fakeDom(size);
    const r = new Renderer(fakeCanvas());
    const inner = r as unknown as RendererInternals;
    size.w = 1920;
    size.h = 1080;
    r.skipFrame(1 / 60);
    dom.advance(500);
    r.skipFrame(1 / 60); // starts it
    const job = inner.job;
    expect(job).not.toBeNull();
    let steps = 0;
    const next = job!.next.bind(job);
    job!.next = () => {
      steps++;
      return next();
    };
    for (let i = 0; i < 30; i++) r.renderWorld(worldView(), 1 / 60, i / 60);
    expect(steps).toBe(0);
    expect(inner.builtScale).toBe(1);
    r.skipFrame(1 / 60);
    expect(steps).toBeGreaterThan(0);
  });
});
