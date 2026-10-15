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
import {
  NAME_FX_CLASS,
  burnCopy,
  burnModeOf,
  burnWhat,
  formatTokens,
  formatTokensShort,
  isAllyRed,
  isPendingBurnError,
  itemPrice,
  nameFxClass,
  nextWeekStartUtc,
  purchasePrice,
  rankedStartGate,
  receiptToast,
  resetCountdown,
  timeAgo,
} from '../client/src/ui/ranked';
import { expectedBurnAmount } from '../client/src/wallet';
import { COSMETICS } from '../shared/cosmetics';
import type { BurnConfig, PlayerView } from '../shared/protocol';
import { readFileSync } from 'node:fs';

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

// ---------- Ranked + burns UI ----------

describe('ranked error copy', () => {
  it('has friendly defaults for the ranked error codes', () => {
    expect(friendlyError('NEED_WALLET', 'Ranked needs a Phantom sign-in')).toBe('Ranked needs a Phantom sign-in. Connect Phantom first.');
    expect(friendlyError('NEED_TICKET', 'Ranked needs a ticket. Burn one to enter.')).toBe('You need a ranked ticket. Burn one to enter.');
    expect(friendlyError('RANKED_LOCKED', 'No bots in ranked')).toBe('Ranked rooms use fixed settings and no bots.');
    expect(friendlyError('RANKED_LOCKED', '')).toBe('Ranked rooms use fixed settings and no bots.');
  });

  it("keeps the server's list of who is missing a ticket or a sign-in at START", () => {
    expect(friendlyError('NEED_TICKET', 'No ranked ticket: Bob, Ann')).toBe('No ranked ticket: Bob, Ann.');
    expect(friendlyError('NEED_WALLET', 'Not signed in: Bob')).toBe('Not signed in: Bob.');
  });
});

const BURN: BurnConfig = { mode: 'mock', cluster: 'mainnet-beta', mint: null, decimals: 6, rankedEntryPrice: 50_000, priceMultiplier: 1 };

describe('burn prices and copy', () => {
  it('formats whole tokens with thousands separators', () => {
    expect(formatTokens(50_000)).toBe('50,000');
    expect(formatTokens(1_234_567.4)).toBe('1,234,567');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokensShort(12_345_678)).toBe('12.3M');
    expect(formatTokensShort(98_765)).toBe('98,765');
  });

  it('prices cosmetics as base x multiplier, exactly like the wallet check (and the server)', () => {
    for (const mult of [1, 0.5, 2.5, 1.37, 0.0001]) {
      const burn = { ...BURN, priceMultiplier: mult };
      for (const item of COSMETICS) {
        const want = expectedBurnAmount(burn, { purpose: 'cosmetic', itemId: item.id });
        expect(itemPrice(burn, item)).toBe(want);
        expect(purchasePrice(burn, { purpose: 'cosmetic', itemId: item.id })).toBe(want);
      }
    }
    expect(purchasePrice(BURN, { purpose: 'ranked' })).toBe(50_000);
    expect(purchasePrice(BURN, { purpose: 'cosmetic', itemId: 'nope' })).toBeNull();
    expect(formatTokens(itemPrice({ priceMultiplier: 2 }, COSMETICS.find((c) => c.id === 'skin_holo')!))).toBe('200,000');
  });

  it('says burned tokens are destroyed and nobody receives them, with no price or return promise', () => {
    const t = burnCopy(50_000, '$RUGS', burnWhat({ purpose: 'ranked' }));
    expect(t).toBe('Burn 50,000 $RUGS. Tokens are destroyed forever. Nobody receives them. You get: 1 ranked ticket.');
    const c = burnCopy(60_000, '$RUGS', burnWhat({ purpose: 'cosmetic', itemId: 'name_fire' }));
    expect(c).toContain('You get: On Fire (name effect).');
    for (const line of [t, c]) expect(line).not.toMatch(/moon|pump|profit|return|reward|value|price|deflation|supply|invest/i);
  });

  it('treats only a sent-but-unconfirmed burn as pending (never offered a second burn)', () => {
    expect(isPendingBurnError('Your burn was sent but is not confirmed yet. It will be checked again; you can also retry in a minute.')).toBe(true);
    expect(isPendingBurnError('Session expired. Connect Phantom again to finish confirming your burn.')).toBe(true);
    expect(isPendingBurnError('You cancelled the burn in Phantom. Nothing was burned.')).toBe(false);
    expect(isPendingBurnError('Not enough $RUGS')).toBe(false);
  });

  it('toasts burns that confirmed later', () => {
    expect(receiptToast({ purpose: 'ranked', amount: 50_000 }, '$RUGS')).toBe('50,000 $RUGS burned. Ranked ticket added.');
    expect(receiptToast({ purpose: 'cosmetic', itemId: 'skin_gold', amount: 60_000 }, '$RUGS')).toBe('60,000 $RUGS burned. Gold Trim unlocked.');
  });

  it("hides every burn feature unless the server says 'live' or 'mock'", () => {
    expect(burnModeOf({ burn: { mode: 'live' } })).toBe('live');
    expect(burnModeOf({ burn: { mode: 'mock' } })).toBe('mock');
    expect(burnModeOf({ burn: { mode: 'off' } })).toBe('off');
    expect(burnModeOf({ burn: null })).toBe('off');
    expect(burnModeOf({ burn: { mode: 'LIVE' as never } })).toBe('off');
    expect(burnModeOf(null)).toBe('off');
  });
});

describe('ranked lobby START gating', () => {
  const p = (id: string, extra: Partial<PlayerView> = {}): PlayerView =>
    ({ id, name: id.toUpperCase(), color: 0, x: 0, y: 0, facing: 1, moving: false, alive: true, isBot: false, hasTicket: true, ...extra }) as PlayerView;

  it('needs four players, all with a ticket and connected', () => {
    expect(rankedStartGate([p('a'), p('b'), p('c')])).toEqual({ canStart: false, warn: true, hint: 'need 1 more player (ranked has no bots)' });
    expect(rankedStartGate([p('a')]).hint).toBe('need 3 more players (ranked has no bots)');
    const noTicket = rankedStartGate([p('a'), p('b', { hasTicket: false }), p('c'), p('d', { hasTicket: false })]);
    expect(noTicket).toEqual({ canStart: false, warn: true, hint: 'no ticket yet: B, D' });
    const away = rankedStartGate([p('a'), p('b'), p('c'), p('d', { disconnected: true })]);
    expect(away).toEqual({ canStart: false, warn: true, hint: 'waiting for D to reconnect' });
    const ready = rankedStartGate([p('a'), p('b'), p('c'), p('d')]);
    expect(ready.canStart).toBe(true);
    expect(ready.hint).toBe('4 players ready · START uses 1 ticket each');
  });

  it('shortens long lists of names', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => p(id, { hasTicket: false }));
    expect(rankedStartGate(many).hint).toBe('no ticket yet: A, B, C +2');
  });
});

describe('weekly reset countdown', () => {
  it('finds the next Monday 00:00 UTC', () => {
    const wed = Date.UTC(2026, 9, 14, 15, 30); // Wednesday 2026-10-14
    expect(new Date(nextWeekStartUtc(wed)).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    const mondayMidnight = Date.UTC(2026, 9, 19);
    expect(new Date(nextWeekStartUtc(mondayMidnight)).toISOString()).toBe('2026-10-26T00:00:00.000Z');
    const sundayLate = Date.UTC(2026, 9, 18, 23, 59, 59);
    expect(new Date(nextWeekStartUtc(sundayLate)).toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('formats the time left', () => {
    expect(resetCountdown(3 * 86_400_000 + 4 * 3_600_000 + 5 * 60_000)).toBe('3d 4h');
    expect(resetCountdown(4 * 3_600_000 + 12 * 60_000)).toBe('4h 12m');
    expect(resetCountdown(12 * 60_000 + 9_000)).toBe('12m 09s');
    expect(resetCountdown(-5)).toBe('0m 00s');
  });

  it('says how long ago a burn was', () => {
    expect(timeAgo(1_000, 10_000)).toBe('just now');
    expect(timeAgo(0, 5 * 60_000)).toBe('5m ago');
    expect(timeAgo(0, 3 * 3_600_000)).toBe('3h ago');
    expect(timeAgo(0, 3 * 86_400_000)).toBe('3d ago');
  });
});

describe('name effects in the DOM', () => {
  it('maps every name-effect item to a class, and nothing else', () => {
    const names = COSMETICS.filter((c) => c.slot === 'name').map((c) => c.id).sort();
    expect(Object.keys(NAME_FX_CLASS).sort()).toEqual(names);
    expect(nameFxClass({ name: 'name_gold' }, false)).toBe('nfx-gold');
    expect(nameFxClass({ name: 'skin_gold' }, false)).toBeNull();
    expect(nameFxClass({ name: 'name_unknown' }, false)).toBeNull();
    expect(nameFxClass({ skin: 'skin_gold' }, false)).toBeNull();
    expect(nameFxClass(undefined, false)).toBeNull();
  });

  it('lets the red ally styling win over any effect', () => {
    for (const id of Object.keys(NAME_FX_CLASS)) expect(nameFxClass({ name: id }, true)).toBeNull();
    expect(isAllyRed('rugger', true)).toBe(true);
    expect(isAllyRed('rugger', false)).toBe(false);
    expect(isAllyRed('holder', true)).toBe(false);
    expect(isAllyRed(undefined, true)).toBe(false);
  });

  it('never uses a red for a name effect in styles.css', () => {
    const css = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');
    const hue = (r: number, g: number, b: number): { h: number; s: number; l: number } => {
      const [R, G, B] = [r / 255, g / 255, b / 255];
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) return { h: 0, s: 0, l };
      const s = d / (1 - Math.abs(2 * l - 1));
      let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      return { h, s, l };
    };
    let checked = 0;
    for (const cls of Object.values(NAME_FX_CLASS)) {
      const blocks = [...css.matchAll(new RegExp(`\\.${cls}[^{]*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
      expect(blocks.length, `${cls} has CSS`).toBeGreaterThan(0);
      const keyframes = [...css.matchAll(/@keyframes (nfx-[a-z]+)\s*\{([\s\S]*?)\n\}/g)].filter((m) => blocks.some((b) => b.includes(m[1]))).map((m) => m[2]);
      for (const text of [...blocks, ...keyframes]) {
        const colors: Array<[number, number, number]> = [];
        for (const m of text.matchAll(/#([0-9a-f]{6})\b/gi)) colors.push([0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number]);
        for (const m of text.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) colors.push([Number(m[1]), Number(m[2]), Number(m[3])]);
        for (const [r, g, b] of colors) {
          const { h, s } = hue(r, g, b);
          checked++;
          const red = s > 0.3 && (h < 22 || h > 325);
          expect(red, `${cls}: rgb(${r},${g},${b}) is in the red family`).toBe(false);
        }
        expect(text).not.toMatch(/var\(--red/);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
