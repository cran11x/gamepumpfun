// UI logic that runs without a browser: ejection copy, the rugged cutscene's early dismissal, the client
// network layer (refusal backoff, failed rejoin), chat replay dedupe and toast placement helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, EjectionView, S2C, Snapshot } from '../shared/protocol';
import { ejectionText } from '../client/src/ui/ejection';
import { dismissRuggedCutscene } from '../client/src/ui/cutscene';
import { Net, REFUSED_RETRY_MS, isConnectionRefusal } from '../client/src/net';
import { Store } from '../client/src/store';
import { refusalText } from '../client/src/ui/home';
import { friendlyError } from '../client/src/ui/index';
import { boxesOverlap } from '../client/src/ui/toasts';

function snapWith(ejection: EjectionView, confirmEjects: boolean): Snapshot {
  return { ejection, room: { settings: { confirmEjects } } } as unknown as Snapshot;
}

describe('ejectionText', () => {
  it('shows the remaining-rugger count when the server sends it', () => {
    const one = ejectionText(snapWith({ ejectedId: 'a', ejectedName: 'Bob', wasRugger: false, tie: false, ruggersLeft: 1 }, true));
    expect(one).toEqual({ main: 'Bob was not the Rugger.', sub: '1 Rugger remains.', tie: false });
    const two = ejectionText(snapWith({ ejectedId: 'a', ejectedName: 'Bob', wasRugger: true, tie: false, ruggersLeft: 2 }, true));
    expect(two.sub).toBe('2 Ruggers remain.');
    const none = ejectionText(snapWith({ ejectedId: 'a', ejectedName: 'Bob', wasRugger: true, tie: false, ruggersLeft: 0 }, true));
    expect(none.sub).toBe('0 Ruggers remain.');
  });

  it('leaves the count out when ruggersLeft is absent (confirmEjects off), never printing "undefined"', () => {
    const t = ejectionText(snapWith({ ejectedId: 'a', ejectedName: 'Bob', tie: false }, false));
    expect(t).toEqual({ main: 'Bob was blacklisted.', sub: '', tie: false });
    const skipped = ejectionText(snapWith({ ejectedId: null, tie: true }, false));
    expect(skipped).toEqual({ main: 'No one was blacklisted.', sub: '', tie: true });
  });
});

describe('dismissRuggedCutscene', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function fakeCut(leaving = false) {
    const classes = new Set<string>(['cut', ...(leaving ? ['is-leaving'] : [])]);
    return {
      classes,
      removed: false,
      classList: { add: (c: string) => classes.add(c) },
      remove() {
        this.removed = true;
      },
    };
  }

  it('fades out a running cutscene and removes it after the fade', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    const running = fakeCut();
    const fading = fakeCut(true);
    const layer = {
      querySelectorAll: (sel: string) => (sel === '.cut:not(.is-leaving)' ? [running] : []),
    } as unknown as HTMLElement;
    dismissRuggedCutscene(layer);
    expect(running.classes.has('is-leaving')).toBe(true);
    expect(running.removed).toBe(false);
    vi.advanceTimersByTime(300);
    expect(running.removed).toBe(true);
    expect(fading.removed).toBe(false); // already leaving: its own timer removes it
  });

  it('is a no-op when no cutscene is showing', () => {
    const layer = { querySelectorAll: () => [] } as unknown as HTMLElement;
    expect(() => dismissRuggedCutscene(layer)).not.toThrow();
  });
});

// ---------- Network layer ----------

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = FakeWS.CONNECTING;
  sent: Array<{ t: string; [k: string]: unknown }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  open(): void {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  recv(msg: S2C): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  close(code = 1006, reason = ''): void {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const REFUSAL: S2C = { t: 'error', code: 'RATE_LIMITED', message: 'Too many connections from your network' };
const pong = (): S2C => ({ t: 'pong', ts: Date.now(), serverNow: Date.now() });

describe('Net', () => {
  let storage: Map<string, string>;
  const last = () => FakeWS.all[FakeWS.all.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.all = [];
    storage = new Map();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('location', { protocol: 'http:', host: 'test.local' });
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('backs off to slow retries while the server refuses the network, and says why', () => {
    const net = new Net();
    const status: boolean[] = [];
    const errors: string[] = [];
    net.onStatus((c) => status.push(c));
    net.on((m) => m.t === 'error' && errors.push(m.message));
    net.connect();
    expect(FakeWS.all).toHaveLength(1);

    for (const [i, wait] of REFUSED_RETRY_MS.entries()) {
      const ws = last();
      ws.open(); // the server accepts the upgrade, then refuses
      ws.recv(REFUSAL);
      ws.close(1008, 'too many connections');
      expect(net.refusal).toMatchObject({ message: 'Too many connections from your network', attempts: i + 1 });
      expect(net.refusal!.retryAt).toBe(Date.now() + wait);
      vi.advanceTimersByTime(wait - 1);
      expect(FakeWS.all).toHaveLength(i + 1); // no quick reconnect loop
      vi.advanceTimersByTime(1);
      expect(FakeWS.all).toHaveLength(i + 2);
    }
    // Capped at the slowest retry.
    last().open();
    last().recv(REFUSAL);
    last().close(1008, 'too many connections');
    expect(net.refusal!.retryAt - Date.now()).toBe(REFUSED_RETRY_MS[REFUSED_RETRY_MS.length - 1]);
    // A refused socket is never reported as connected; the message reached the UI every time.
    expect(status.every((c) => c === false)).toBe(true);
    expect(errors).toHaveLength(4);

    // A slot frees up: the first answer clears the refusal, reports connected and resets the backoff.
    vi.advanceTimersByTime(REFUSED_RETRY_MS[REFUSED_RETRY_MS.length - 1]);
    last().open();
    expect(status[status.length - 1]).toBe(false);
    last().recv(pong());
    expect(net.refusal).toBeNull();
    expect(status[status.length - 1]).toBe(true);
    const n = FakeWS.all.length;
    last().close();
    vi.advanceTimersByTime(500);
    expect(FakeWS.all).toHaveLength(n + 1);
  });

  it('treats a 1008 "too many connections" close as a refusal even without the error message', () => {
    const net = new Net();
    net.connect();
    last().open();
    last().close(1008, 'too many connections');
    expect(net.refusal).toMatchObject({ attempts: 1, message: 'Too many connections from your network' });
    vi.advanceTimersByTime(REFUSED_RETRY_MS[0] - 1);
    expect(FakeWS.all).toHaveLength(1);
  });

  it('keeps growing the ordinary backoff when sockets open but the server never answers', () => {
    const net = new Net();
    net.connect();
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      last().open();
      last().close();
      const before = FakeWS.all.length;
      let waited = 0;
      while (FakeWS.all.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      gaps.push(waited);
    }
    expect(gaps).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(net.refusal).toBeNull();
  });

  it('turns any error answering a rejoin into REJOIN_FAILED and forgets the session', () => {
    Net.saveSession({ code: 'ABCD', playerId: 'p1', sessionKey: 'k' });
    const net = new Net();
    const got: S2C[] = [];
    net.on((m) => got.push(m));
    net.connect();
    last().open();
    expect(last().sent[0]).toEqual({ t: 'rejoin', code: 'ABCD', playerId: 'p1', sessionKey: 'k' });
    last().recv({ t: 'error', code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.' });
    expect(got.at(-1)).toMatchObject({ t: 'error', code: 'REJOIN_FAILED' });
    expect(Net.loadSession()).toBeNull();
    // Later errors on the same socket are ordinary errors again.
    last().recv({ t: 'error', code: 'RATE_LIMITED', message: 'Slow down' });
    expect(got.at(-1)).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('keeps the session when the rejoin is answered with welcome, or never looked at (refused socket)', () => {
    Net.saveSession({ code: 'ABCD', playerId: 'p1', sessionKey: 'k' });
    const net = new Net();
    net.connect();
    last().open();
    last().recv(REFUSAL);
    last().close(1008, 'too many connections');
    expect(Net.loadSession()).toEqual({ code: 'ABCD', playerId: 'p1', sessionKey: 'k' });
    vi.advanceTimersByTime(REFUSED_RETRY_MS[0]);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'rejoin' });
    last().recv({ t: 'welcome', playerId: 'p1', code: 'ABCD', sessionKey: 'k2' } as S2C);
    last().recv({ t: 'error', code: 'INVALID_ACTION', message: 'Too far' });
    expect(Net.loadSession()).toEqual({ code: 'ABCD', playerId: 'p1', sessionKey: 'k2' });
  });

  it('sends the store home on a failed rejoin', () => {
    Net.saveSession({ code: 'ABCD', playerId: 'p1', sessionKey: 'k' });
    const net = new Net();
    const store = new Store(net);
    store.snap = { phase: 'playing' } as Snapshot;
    store.roomCode = 'ABCD';
    const phases: Array<string | null> = [];
    store.onPhase(({ to }) => phases.push(to));
    net.connect();
    last().open();
    last().recv({ t: 'error', code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a minute.' });
    expect(store.inRoom).toBe(false);
    expect(store.roomCode).toBeNull();
    expect(phases).toEqual(['lobby']);
    expect(store.lastError?.code).toBe('REJOIN_FAILED');
  });

  it('recognizes only the connection-cap refusal', () => {
    expect(isConnectionRefusal(REFUSAL)).toBe(true);
    expect(isConnectionRefusal({ t: 'error', code: 'RATE_LIMITED', message: 'Slow down' })).toBe(false);
    expect(isConnectionRefusal({ t: 'error', code: 'BAD_REQUEST', message: 'Too many connections' })).toBe(false);
  });
});

describe('Store chat replay', () => {
  function makeStore() {
    let push: (m: S2C) => void = () => {};
    const fakeNet = { on: (h: (m: S2C) => void) => ((push = h), () => {}), onStatus: () => () => {} };
    const store = new Store(fakeNet as unknown as Net);
    return { store, push: (m: S2C) => push(m) };
  }
  const line = (ts: number, text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
    t: 'chat',
    channel: 'meeting',
    fromId: 'p1',
    fromName: 'Bob',
    color: 2,
    text,
    ts,
    ...patch,
  });

  it('drops replayed lines with the same (ts, fromId, channel, text) and keeps new ones in order', () => {
    const { store, push } = makeStore();
    const heard: string[] = [];
    store.onChat((m) => heard.push(m.text));
    push(line(1, 'gm'));
    push(line(2, 'dev is sus'));
    push(line(2, 'joined', { channel: 'system', fromId: null }));
    // Rejoin: the server replays its log, then live lines continue.
    push(line(1, 'gm'));
    push(line(2, 'dev is sus'));
    push(line(2, 'joined', { channel: 'system', fromId: null }));
    push(line(3, 'missed while away'));
    expect(store.chat.map((c) => c.text)).toEqual(['gm', 'dev is sus', 'joined', 'missed while away']);
    expect(heard).toEqual(['gm', 'dev is sus', 'joined', 'missed while away']);
  });

  it('keeps lines that differ in any key field', () => {
    const { store, push } = makeStore();
    push(line(5, 'skip'));
    push(line(5, 'skip', { fromId: 'p2' }));
    push(line(5, 'skip', { channel: 'ghost' }));
    push(line(6, 'skip'));
    push(line(5, 'skip!'));
    expect(store.chat).toHaveLength(5);
  });

  it('accepts the replay again after a reset (new room or reload)', () => {
    const { store, push } = makeStore();
    push(line(1, 'gm'));
    store.reset();
    push(line(1, 'gm'));
    expect(store.chat).toHaveLength(1);
  });
});

// ---------- UI copy and layout helpers ----------

describe('connection and rate-limit messages', () => {
  it('shows what a rate limit was about, but keeps the short chat "Slow down" copy', () => {
    expect(friendlyError('RATE_LIMITED', 'Too many connections from your network')).toBe('Too many connections from your network.');
    expect(friendlyError('RATE_LIMITED', 'Too many attempts. Try again in a minute.')).toBe('Too many attempts. Try again in a minute.');
    expect(friendlyError('RATE_LIMITED', 'Slow down')).toBe('Slow down a sec.');
  });

  it('counts down to the next retry on the home screen', () => {
    const r = { message: 'Too many connections from your network', attempts: 1, retryAt: 20_000 };
    expect(refusalText(r, 5_000)).toBe('Too many connections from your network. Retrying in 15s…');
    expect(refusalText(r, 19_100)).toBe('Too many connections from your network. Retrying in 1s…');
    expect(refusalText(r, 20_000)).toBe('Too many connections from your network. Retrying…');
    expect(refusalText({ ...r, retryAt: 0 }, 5_000)).toBe('Too many connections from your network. Retrying…');
  });
});

describe('boxesOverlap (toasts over HUD controls)', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
  it('detects intersection and ignores touching edges and empty (hidden) boxes', () => {
    expect(boxesOverlap(box(400, 148, 832, 209), box(0, 187, 388, 390))).toBe(false); // toast right of the joystick zone
    expect(boxesOverlap(box(352, 148, 728, 209), box(644, 160, 722, 238))).toBe(true); // toast over SAB
    expect(boxesOverlap(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(false);
    expect(boxesOverlap(box(0, 0, 100, 100), box(0, 0, 0, 0))).toBe(false);
  });
});
