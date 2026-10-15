import { describe, expect, it } from 'vitest';
import {
  BASE_SPEED,
  BASE_VISION,
  GHOST_SPEED_MULT,
  CHAT_RATE_LIMIT_MS,
  DEFAULT_SETTINGS,
  DEV_DUMP_DURATION_MS,
  EJECTION_MS,
  EMERGENCY_RANGE,
  FUD_VISION_MULT,
  KILL_RANGE,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MEETING_RESULTS_MS,
  PLAYER_RADIUS,
  POST_MEETING_COOLDOWN_MS,
  RECONNECT_GRACE_MS,
  ROLE_REVEAL_MS,
  SABOTAGE_COOLDOWN_MS,
  TILE,
  USE_RANGE,
  maxRuggersFor,
  type GameSettings,
} from '../shared/constants';
import { circleFree, lineOfSight, moveWithCollision } from '../shared/geometry';
import { EMERGENCY_BUTTON, SPAWN_POINTS, TASK_MIN_MS, sabotageStationById, stationById, ventById } from '../shared/map';
import type { C2S, ChatMessage, ErrorCode, GameEvent, S2C, Snapshot } from '../shared/protocol';
import {
  INTEREST_HOLD_MS,
  INTEREST_PROBE_PX,
  Room,
  type BotBrainInit,
  type BotBrainLike,
  type GameResultRecordLike,
  type RemoveReason,
} from '../server/game';
import { mulberry32 } from '../server/game/rng';
import { clampSettings, sanitizeChat, sanitizeName } from '../server/game/sanitize';
import { tallyVotes } from '../server/game/tally';
import { parseC2S } from '../server/game/validate';
import { RoomManager, type Conn } from '../server/rooms';
import { bridgePops, ventsInSight } from '../client/src/game/bridgeSight';

const at = (tx: number, ty: number) => ({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });

interface HarnessOptions {
  players?: number;
  seed?: number;
  settings?: Partial<GameSettings>;
  wallets?: boolean;
  brains?: (init: BotBrainInit) => BotBrainLike;
}

/** A Room with a fake clock, a seeded rng and an in-memory outbox per player. */
class Harness {
  t = 1_000_000;
  readonly sent = new Map<string, S2C[]>();
  readonly records: GameResultRecordLike[][] = [];
  readonly removed: Array<{ id: string; reason: RemoveReason }> = [];
  readonly room: Room;
  readonly ids: string[] = [];

  constructor(opts: HarnessOptions = {}) {
    this.room = new Room({
      code: 'TEST',
      now: () => this.t,
      rng: mulberry32(opts.seed ?? 7),
      send: (id, m) => {
        const list = this.sent.get(id) ?? [];
        list.push(m);
        this.sent.set(id, list);
      },
      settings: opts.settings,
      recordResults: (r) => this.records.push(r),
      onPlayerRemoved: (id, reason) => this.removed.push({ id, reason }),
      createBotBrain: opts.brains,
      log: () => {},
    });
    for (let i = 0; i < (opts.players ?? 5); i++) {
      const wallet = opts.wallets ? { name: `W${i}`, address: `Wallet${i}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` } : null;
      const r = this.room.addHuman({ name: `p${i}`, wallet });
      if (!r.ok) throw new Error(r.message);
      this.ids.push(r.player.id);
    }
  }

  get host(): string {
    return this.room.host;
  }
  p(id: string) {
    const p = this.room.getPlayer(id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  }
  send(id: string, msg: C2S): void {
    this.room.handle(id, msg);
  }
  advance(ms: number): void {
    this.t += ms;
    this.room.tick();
  }
  /** Let interest management catch up after `place` teleports: holds from earlier positions run out. */
  settle(): void {
    this.advance(INTEREST_HOLD_MS + 50);
  }
  /** Walk `id` with real `move` messages at 20 Hz, `steps` times by (dx, dy). */
  walk(id: string, dx: number, dy: number, steps: number): void {
    for (let i = 0; i < steps; i++) {
      this.t += 50;
      const p = this.p(id);
      this.send(id, { t: 'move', x: p.x + dx, y: p.y + dy, facing: dx < 0 ? -1 : 1, moving: true });
      this.room.tick();
    }
  }
  start(): void {
    this.send(this.host, { t: 'start' });
    expect(this.room.phase).toBe('roleReveal');
    this.advance(ROLE_REVEAL_MS);
    expect(this.room.phase).toBe('playing');
  }
  ruggers(): string[] {
    return this.room.playerIds().filter((id) => this.p(id).role === 'rugger');
  }
  holders(): string[] {
    return this.room.playerIds().filter((id) => this.p(id).role === 'holder');
  }
  place(id: string, pos: { x: number; y: number }): void {
    const p = this.p(id);
    p.x = pos.x;
    p.y = pos.y;
  }
  snap(id: string): Snapshot {
    const s = this.room.buildSnapshot(id);
    if (!s) throw new Error('no snapshot');
    return s;
  }
  outbox(id: string): S2C[] {
    return this.sent.get(id) ?? [];
  }
  events(id: string): GameEvent[] {
    return this.outbox(id).flatMap((m) => (m.t === 'event' ? [m.event] : []));
  }
  errors(id: string): ErrorCode[] {
    return this.outbox(id).flatMap((m) => (m.t === 'error' ? [m.code] : []));
  }
  chats(id: string): ChatMessage[] {
    return this.outbox(id).flatMap((m) => (m.t === 'chat' ? [m] : []));
  }
  clearOutbox(): void {
    this.sent.clear();
  }
  /** Kill `victim` with `killer` standing next to them (kill must be off cooldown). */
  kill(killer: string, victim: string): void {
    const v = this.p(victim);
    this.place(killer, { x: v.x - 30, y: v.y });
    this.send(killer, { t: 'kill', targetId: victim });
  }
  /** Complete one task for a holder (alive or ghost): walk there, open, wait, done. */
  doTask(id: string, stationId: string): void {
    const st = stationById(stationId)!;
    this.place(id, st);
    this.send(id, { t: 'taskOpen', stationId });
    this.advance(TASK_MIN_MS[st.kind]);
    this.send(id, { t: 'taskDone', stationId });
  }
}

/** Put every player on a free launchpad tile, spaced apart, so range checks are explicit in each test. */
function scatter(h: Harness): void {
  h.room.playerIds().forEach((id, i) => h.place(id, at(25 + (i % 5) * 3, i < 5 ? 3 : 10)));
}

describe('helpers', () => {
  it('tally: majority, tie, skip, non-voters', () => {
    expect(tallyVotes([['a', 'x'], ['b', 'x'], ['c', 'y']]).ejectedId).toBe('x');
    const tie = tallyVotes([['a', 'x'], ['b', 'y']]);
    expect(tie).toMatchObject({ ejectedId: null, tie: true });
    const skip = tallyVotes([['a', 'skip'], ['b', 'skip'], ['c', 'x']]);
    expect(skip).toMatchObject({ ejectedId: null, tie: false });
    const skipTie = tallyVotes([['a', 'skip'], ['b', 'x']]);
    expect(skipTie).toMatchObject({ ejectedId: null, tie: true });
    expect(tallyVotes([])).toMatchObject({ ejectedId: null, tie: false });
    // Votes for invalid targets (e.g. a player who left) are ignored.
    expect(tallyVotes([['a', 'gone'], ['b', 'gone'], ['c', 'x']], (t) => t !== 'gone').ejectedId).toBe('x');
  });

  it('sanitizes names and chat', () => {
    expect(sanitizeName('   ')).toBe('anon');
    expect(sanitizeName('\u0000\u0007')).toBe('anon');
    expect(sanitizeName('  dev\u200B\u202E is  sus  ')).toBe('dev is sus');
    expect(Array.from(sanitizeName('x'.repeat(100))).length).toBe(MAX_NAME_LENGTH);
    expect(sanitizeChat('   ')).toBeNull();
    expect(sanitizeChat('gm\n\tser')).toBe('gm ser');
    expect(sanitizeChat('y'.repeat(500))!.length).toBe(MAX_CHAT_LENGTH);
  });

  it('clamps settings to SETTINGS_BOUNDS', () => {
    const s = clampSettings(DEFAULT_SETTINGS, { killCooldown: 999, playerSpeed: 0.1, tasksPerPlayer: 3.4, ruggers: -2, isPublic: false });
    expect(s).toMatchObject({ killCooldown: 60, playerSpeed: 0.5, tasksPerPlayer: 3, ruggers: 1, isPublic: false });
    expect(clampSettings(DEFAULT_SETTINGS, { votingTime: Number.NaN }).votingTime).toBe(DEFAULT_SETTINGS.votingTime);
  });

  it('validates client messages', () => {
    expect(parseC2S({ t: 'move', x: 1, y: 2, facing: 1, moving: true })).toEqual({ t: 'move', x: 1, y: 2, facing: 1, moving: true });
    expect(parseC2S({ t: 'move', x: Number.POSITIVE_INFINITY, y: 2, facing: 1, moving: true })).toBeNull();
    expect(parseC2S({ t: 'move', x: 1, y: 2, facing: 0, moving: true })).toBeNull();
    expect(parseC2S({ t: 'setColor', color: 99 })).toBeNull();
    expect(parseC2S({ t: 'sabotage', kind: 'nuke' })).toBeNull();
    expect(parseC2S({ t: 'vent', action: 'exit', extra: 1 })).toEqual({ t: 'vent', action: 'exit' });
    expect(parseC2S({ t: 'settings', settings: { ruggers: 2, isPublic: 'yes', bogus: 1 } })).toEqual({ t: 'settings', settings: { ruggers: 2 } });
    expect(parseC2S('nope')).toBeNull();
    expect(parseC2S({ t: 'wat' })).toBeNull();
  });
});

describe('lobby', () => {
  it('first player hosts, colors are unique, setColor rejects taken colors', () => {
    const h = new Harness({ players: 3 });
    expect(h.host).toBe(h.ids[0]);
    expect(h.ids.map((id) => h.p(id).color)).toEqual([0, 1, 2]);
    h.send(h.ids[1], { t: 'setColor', color: 0 });
    expect(h.p(h.ids[1]).color).toBe(1);
    expect(h.errors(h.ids[1])).toContain('INVALID_ACTION');
    h.send(h.ids[1], { t: 'setColor', color: 5 });
    expect(h.p(h.ids[1]).color).toBe(5);
    const r = h.room.addHuman({ name: 'late' });
    expect(r.ok && r.player.color).toBe(1); // first free color
  });

  it('only the host changes settings, and they are clamped', () => {
    const h = new Harness({ players: 2 });
    h.send(h.ids[1], { t: 'settings', settings: { killCooldown: 10 } });
    expect(h.errors(h.ids[1])).toContain('NOT_HOST');
    h.send(h.host, { t: 'settings', settings: { killCooldown: 1, votingTime: 9999, crewVision: 1.6 } });
    expect(h.room.settings).toMatchObject({ killCooldown: 10, votingTime: 180, crewVision: 1.5 });
  });

  it('start needs MIN_PLAYERS including bots', () => {
    const h = new Harness({ players: 3 });
    h.send(h.host, { t: 'start' });
    expect(h.room.phase).toBe('lobby');
    expect(h.errors(h.host)).toContain('NOT_ENOUGH_PLAYERS');
    h.send(h.host, { t: 'addBot' });
    expect(h.room.playerCount).toBe(4);
    h.send(h.host, { t: 'start' });
    expect(h.room.phase).toBe('roleReveal');
  });

  it('room is capped at 10 including bots; joins after start are refused', () => {
    const h = new Harness({ players: 6 });
    for (let i = 0; i < 6; i++) h.send(h.host, { t: 'addBot' });
    expect(h.room.playerCount).toBe(10);
    expect(h.errors(h.host)).toContain('ROOM_FULL');
    const full = h.room.addHuman({ name: 'x' });
    expect(full.ok || full.code).toBe('ROOM_FULL');
    h.send(h.host, { t: 'removeBot' });
    expect(h.room.playerCount).toBe(9);
    h.send(h.host, { t: 'start' });
    const late = h.room.addHuman({ name: 'y' });
    expect(late.ok || late.code).toBe('GAME_IN_PROGRESS');
  });

  it('kick removes the player and tells them; host migrates to the oldest human, never a bot', () => {
    const h = new Harness({ players: 3 });
    h.send(h.host, { t: 'addBot' });
    h.send(h.ids[1], { t: 'kick', playerId: h.ids[2] });
    expect(h.errors(h.ids[1])).toContain('NOT_HOST');
    h.send(h.host, { t: 'kick', playerId: h.ids[2] });
    expect(h.room.getPlayer(h.ids[2])).toBeUndefined();
    expect(h.events(h.ids[2])).toContainEqual({ kind: 'kicked' });
    expect(h.removed).toContainEqual({ id: h.ids[2], reason: 'kicked' });

    h.send(h.ids[0], { t: 'leave' });
    expect(h.room.getPlayer(h.ids[0])).toBeUndefined();
    expect(h.host).toBe(h.ids[1]);
    h.send(h.ids[1], { t: 'leave' });
    expect(h.room.playerCount).toBe(1); // the bot
    expect(h.host).toBe('');
    expect(h.room.shouldDestroy()).toBe(true);
  });

  it('wallet profile sets name and short wallet; one seat per wallet', () => {
    const h = new Harness({ players: 0 });
    const a = h.room.addHuman({ name: 'typed', wallet: { name: 'Whale', address: '7xKqAAAAAAAAAAAAAAAAAAAAAAAAAAAA3fQa' } });
    expect(a.ok && a.player.name).toBe('Whale');
    expect(a.ok && a.player.wallet).toBe('7xKq…3fQa');
    const b = h.room.addHuman({ name: 'second', wallet: { name: 'Whale', address: '7xKqAAAAAAAAAAAAAAAAAAAAAAAAAAAA3fQa' } });
    expect(b.ok && b.player.name).toBe('second');
    expect(b.ok && b.player.wallet).toBeUndefined();
  });
});

describe('start and roles', () => {
  it('assigns min(settings.ruggers, maxRuggersFor(n)) ruggers and distinct tasks', () => {
    for (let n = 4; n <= 10; n++) {
      const h = new Harness({ players: n, seed: n, settings: { ruggers: 3, tasksPerPlayer: 6 } });
      h.send(h.host, { t: 'start' });
      expect(h.ruggers().length, `n=${n}`).toBe(Math.min(3, maxRuggersFor(n)));
      h.room.playerIds().forEach((id, slot) => {
        const p = h.p(id);
        expect(p.tasks.length).toBe(6);
        expect(new Set(p.tasks.map((t) => t.stationId)).size).toBe(6);
        expect(p.tasks.every((t) => !t.done && stationById(t.stationId)?.kind === t.kind)).toBe(true);
        expect({ x: p.x, y: p.y }).toEqual(SPAWN_POINTS[slot]);
        expect(p.teleportSeq).toBe(1);
      });
    }
  });

  it('settings.ruggers below the cap is respected, and roles are spread uniformly', () => {
    const counts = new Map<number, number>();
    for (let seed = 1; seed <= 400; seed++) {
      const h = new Harness({ players: 4, seed, settings: { ruggers: 1 } });
      h.send(h.host, { t: 'start' });
      const r = h.ruggers();
      expect(r.length).toBe(1);
      const idx = h.ids.indexOf(r[0]);
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    for (let i = 0; i < 4; i++) expect(counts.get(i) ?? 0).toBeGreaterThan(60);
  });

  it('roleReveal lasts ROLE_REVEAL_MS, then playing starts with post-meeting cooldowns', () => {
    const h = new Harness({ players: 4 });
    h.send(h.host, { t: 'start' });
    expect(h.events(h.ids[1])).toContainEqual({ kind: 'gameStarted' });
    h.advance(ROLE_REVEAL_MS - 1);
    expect(h.room.phase).toBe('roleReveal');
    h.advance(1);
    expect(h.room.phase).toBe('playing');
    const r = h.ruggers()[0];
    const me = h.snap(r).me!;
    expect(me.killReadyAt).toBe(h.t + POST_MEETING_COOLDOWN_MS);
    expect(me.sabotageReadyAt).toBe(h.t + POST_MEETING_COOLDOWN_MS);
    // Holders never get rugger-only fields.
    expect(h.snap(h.holders()[0]).me!.killReadyAt).toBeUndefined();
  });

  it('role reveal shows fellow ruggers to ruggers only', () => {
    const h = new Harness({ players: 8, settings: { ruggers: 2 } });
    h.send(h.host, { t: 'start' });
    const [r1, r2] = h.ruggers();
    expect(h.snap(r1).players.find((p) => p.id === r2)?.isRugger).toBe(true);
    const holder = h.holders()[0];
    expect(h.snap(holder).players.some((p) => p.isRugger)).toBe(false);
  });
});

describe('movement', () => {
  it('accepts a legal move and rejects moves into walls, through walls and too fast', () => {
    const h = new Harness({ players: 4 });
    h.start();
    const id = h.holders()[0];
    const p = h.p(id);
    // Start next to the launchpad's north wall.
    h.place(id, at(27, 2));
    h.advance(500);
    const seq0 = p.teleportSeq;

    // Legal step.
    h.send(id, { t: 'move', x: p.x + 20, y: p.y, facing: 1, moving: true });
    expect(p.x).toBe(at(27, 2).x + 20);
    expect(p.teleportSeq).toBe(seq0);

    // Into the wall (endpoint overlaps the wall row): rejected, position kept, snap requested.
    h.advance(500);
    const before = { x: p.x, y: p.y };
    h.send(id, { t: 'move', x: p.x, y: p.y - 25, facing: 1, moving: true });
    expect({ x: p.x, y: p.y }).toEqual(before);
    expect(p.teleportSeq).toBe(seq0 + 1);

    // Through the wall band between the launchpad and the liquidity pool: the endpoint is free floor
    // and within the speed allowance, but the straight path crosses solid tiles.
    const lp = at(27, 11);
    const pool = at(27, 16);
    expect(circleFree(lp.x, lp.y)).toBe(true);
    expect(circleFree(pool.x, pool.y)).toBe(true);
    h.place(id, lp);
    h.advance(1000);
    h.send(id, { t: 'move', x: pool.x, y: pool.y, facing: 1, moving: true });
    expect({ x: p.x, y: p.y }).toEqual(lp);
    expect(p.teleportSeq).toBe(seq0 + 2);

    // Too fast: right after a snap (here a reconnect) the budget is only the slack, so 100 px 50 ms later is refused.
    h.room.setDisconnected(id);
    expect(h.room.rejoin(id, p.sessionKey)).toBe(p);
    const seq1 = p.teleportSeq;
    h.advance(50);
    h.send(id, { t: 'move', x: lp.x + 100, y: lp.y, facing: 1, moving: true });
    expect(p.x).toBe(lp.x);
    expect(p.teleportSeq).toBe(seq1 + 1);
    // After a pause the same hop fits the refilled budget (a client catching up after a stall).
    h.advance(1000);
    h.send(id, { t: 'move', x: lp.x + 100, y: lp.y, facing: 1, moving: true });
    expect(p.x).toBe(lp.x + 100);
    expect(p.teleportSeq).toBe(seq1 + 1);
  });

  it('caps sustained speed at 1.5x however often moves are sent, without rejecting honest or jittery movement', () => {
    const h = new Harness({ players: 4 });
    h.start();
    const id = h.holders()[0];
    const p = h.p(id);
    const home = at(27, 9);
    h.place(id, home);
    h.advance(1000);
    // Hop back and forth between two free points so no corridor is needed.
    const hop = (dx: number) => {
      const dir = p.x > home.x ? -1 : 1;
      h.send(id, { t: 'move', x: p.x + dir * dx, y: p.y, facing: dir, moving: true });
    };
    expect(circleFree(home.x + 39, home.y)).toBe(true);

    // Speed hack: 39 px every 25 ms (about 7.8x speed) for a second.
    const seq0 = p.teleportSeq;
    const t0 = h.t;
    let travelled = 0;
    for (let i = 0; i < 40; i++) {
      h.t += 25;
      const x0 = p.x;
      hop(39);
      travelled += Math.abs(p.x - x0);
    }
    const elapsedS = (h.t - t0) / 1000;
    expect(p.teleportSeq).toBeGreaterThan(seq0);
    // Never more than the full budget (1 s at 1.5x plus slack) plus what refilled meanwhile.
    expect(travelled).toBeLessThanOrEqual(BASE_SPEED * 1.5 * (1 + elapsedS) + 24);
    expect(travelled).toBeLessThan(40 * 39 * 0.5);

    // Honest walking at 20 Hz, then with uplink jitter (30/70 ms gaps), is never refused.
    h.place(id, home);
    h.advance(1000);
    const seq1 = p.teleportSeq;
    for (let i = 0; i < 100; i++) {
      h.t += 50;
      hop(BASE_SPEED * 0.05);
    }
    for (let i = 0; i < 100; i++) {
      const gap = i % 2 ? 70 : 30;
      h.t += gap;
      hop(BASE_SPEED * (gap / 1000));
    }
    expect(p.teleportSeq).toBe(seq1);
  });

  it('the budget reset scales with speed, so a fast ghost\'s first step after a round restart is accepted', () => {
    const h = new Harness({ players: 6, settings: { playerSpeed: 2, discussionTime: 0 } });
    h.start();
    scatter(h);
    const [r] = h.ruggers();
    const [ghost, caller] = h.holders();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r, ghost);
    expect(h.p(ghost).alive).toBe(false);
    h.place(caller, { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(caller, { t: 'emergency' });
    for (const id of h.room.playerIds()) if (h.p(id).alive) h.send(id, { t: 'vote', target: 'skip' });
    h.advance(MEETING_RESULTS_MS);
    expect(h.room.phase).toBe('ejection');
    h.advance(EJECTION_MS);
    expect(h.room.phase).toBe('playing');
    // One 50 ms tick of ghost movement at playerSpeed 2 (200 * 2 * 1.25 * 0.05 = 25 px), sent in the very
    // tick play resumed, as bots do: nothing has refilled yet, so this is the reset budget alone.
    const g = h.p(ghost);
    const seq = g.teleportSeq;
    const step = BASE_SPEED * 2 * GHOST_SPEED_MULT * 0.05;
    expect(step).toBe(25);
    h.send(ghost, { t: 'move', x: g.x + step, y: g.y, facing: 1, moving: true });
    expect(g.teleportSeq).toBe(seq);
    // A living player at that speed after a slow (80 ms) first tick, too.
    const live = h.p(caller);
    const liveSeq = live.teleportSeq;
    const liveX = live.x;
    h.send(caller, { t: 'move', x: live.x + BASE_SPEED * 2 * 0.08, y: live.y, facing: 1, moving: true });
    expect(live.teleportSeq).toBe(liveSeq);
    expect(live.x).toBe(liveX + 32);
    // Still a budget: right after a restart a ghost can't jump 250 px.
    h.t += 50;
    h.send(ghost, { t: 'move', x: g.x + 250, y: g.y, facing: 1, moving: true });
    expect(g.teleportSeq).toBe(seq + 1);
  });

  it('ignores moves faster than every 25 ms and moves outside playing', () => {
    const h = new Harness({ players: 4 });
    const id = h.ids[1];
    const lobbyPos = { x: h.p(id).x, y: h.p(id).y };
    h.send(id, { t: 'move', x: lobbyPos.x + 5, y: lobbyPos.y, facing: 1, moving: true });
    expect(h.p(id).x).toBe(lobbyPos.x);
    h.start();
    const p = h.p(id);
    h.place(id, at(27, 9));
    h.advance(200);
    h.send(id, { t: 'move', x: p.x + 5, y: p.y, facing: 1, moving: true });
    h.t += 10;
    const seq = p.teleportSeq;
    h.send(id, { t: 'move', x: p.x + 9999, y: p.y, facing: 1, moving: true });
    expect(p.x).toBe(at(27, 9).x + 5);
    expect(p.teleportSeq).toBe(seq); // ignored, not rejected
  });

  it('ghosts move through walls but stay inside the world', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const [r] = h.ruggers();
    const victim = h.holders()[0];
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.place(victim, at(27, 11));
    h.kill(r, victim);
    const g = h.p(victim);
    expect(g.alive).toBe(false);
    h.advance(1000);
    h.send(victim, { t: 'move', x: g.x, y: g.y + 120, facing: 1, moving: true }); // into the solid band
    expect(g.y).toBe(at(27, 11).y + 120);
    h.place(victim, { x: 10, y: 10 });
    h.advance(1000);
    h.send(victim, { t: 'move', x: -20, y: 10, facing: -1, moving: true });
    expect(g.x).toBe(10);
  });
});

describe('tasks', () => {
  it('requires the station in range, an open task and TASK_MIN_MS before done', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const id = h.holders()[0];
    const p = h.p(id);
    const task = p.tasks[0];
    const st = stationById(task.stationId)!;

    // Out of range.
    h.place(id, { x: st.x + USE_RANGE + 30, y: st.y });
    h.send(id, { t: 'taskOpen', stationId: st.id });
    expect(p.activeStationId).toBeNull();

    // Not one of my tasks.
    const other = ['tf_verify', 'tf_swap', 'tf_snipe', 'lp_snipe', 'lp_socials', 'ml_shill'].find((s) => !p.tasks.some((t) => t.stationId === s))!;
    h.place(id, stationById(other)!);
    h.send(id, { t: 'taskOpen', stationId: other });
    expect(p.activeStationId).toBeNull();

    h.place(id, st);
    h.send(id, { t: 'taskOpen', stationId: st.id });
    expect(p.activeStationId).toBe(st.id);
    h.advance(TASK_MIN_MS[st.kind] - 1);
    h.send(id, { t: 'taskDone', stationId: st.id });
    expect(task.done).toBe(false);
    expect(p.activeStationId).toBe(st.id); // still open, can retry
    h.clearOutbox();
    h.advance(1);
    h.send(id, { t: 'taskDone', stationId: st.id });
    expect(task.done).toBe(true);
    expect(p.activeStationId).toBeNull();
    expect(h.events(id)).toContainEqual({ kind: 'taskCompleted', stationId: st.id });
    for (const other of h.ids.filter((x) => x !== id)) expect(h.events(other).some((e) => e.kind === 'taskCompleted')).toBe(false);
    const total = h.holders().length * DEFAULT_SETTINGS.tasksPerPlayer;
    expect(h.snap(id).taskProgress).toBeCloseTo(1 / total);
    // Done tasks can't be reopened.
    h.send(id, { t: 'taskOpen', stationId: st.id });
    expect(p.activeStationId).toBeNull();
  });

  it('taskDone fails when the player walked away; taskClose clears the open task', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const id = h.holders()[0];
    const p = h.p(id);
    const st = stationById(p.tasks[0].stationId)!;
    h.place(id, st);
    h.send(id, { t: 'taskOpen', stationId: st.id });
    h.advance(TASK_MIN_MS[st.kind]);
    h.place(id, { x: st.x + USE_RANGE * 1.5 + 5, y: st.y });
    h.send(id, { t: 'taskDone', stationId: st.id });
    expect(p.tasks[0].done).toBe(false);
    h.send(id, { t: 'taskClose' });
    expect(p.activeStationId).toBeNull();
  });

  it("ruggers' fake tasks never complete or move the curve", () => {
    const h = new Harness({ players: 5 });
    h.start();
    const r = h.ruggers()[0];
    const p = h.p(r);
    h.doTask(r, p.tasks[0].stationId);
    expect(p.tasks[0].done).toBe(false);
    expect(h.room.taskProgress()).toBe(0);
    expect(h.snap(r).me!.tasks.every((t) => !t.done)).toBe(true);
  });
});

describe('rugging', () => {
  it('enforces kill range and cooldown, leaves a body and notifies only killer, victim and ruggers', () => {
    const h = new Harness({ players: 8, settings: { ruggers: 2, killCooldown: 20 } });
    h.start();
    const [r1, r2] = h.ruggers();
    const [a, b, c] = h.holders();
    scatter(h);
    h.place(r1, at(26, 9));
    h.place(a, { x: at(26, 9).x + KILL_RANGE - 1, y: at(26, 9).y });
    h.place(b, { x: at(26, 9).x, y: at(26, 9).y - KILL_RANGE - 2 });

    // Still on the start cooldown.
    h.send(r1, { t: 'kill', targetId: a });
    expect(h.p(a).alive).toBe(true);
    h.advance(POST_MEETING_COOLDOWN_MS);

    // Out of range.
    h.send(r1, { t: 'kill', targetId: b });
    expect(h.p(b).alive).toBe(true);
    // Can't rug a fellow rugger.
    h.place(r2, { x: at(26, 9).x - 20, y: at(26, 9).y });
    h.send(r1, { t: 'kill', targetId: r2 });
    expect(h.p(r2).alive).toBe(true);

    h.clearOutbox();
    h.send(r1, { t: 'kill', targetId: a });
    expect(h.p(a).alive).toBe(false);
    expect(h.snap(c).bodies).toEqual([{ id: a, color: h.p(a).color, x: at(26, 9).x + KILL_RANGE - 1, y: at(26, 9).y }]);
    const ev = { kind: 'rugged', victimId: a, killerId: r1 };
    expect(h.events(r1)).toContainEqual(ev);
    expect(h.events(a)).toContainEqual(ev);
    expect(h.events(r2)).toContainEqual(ev);
    expect(h.events(c).some((e) => e.kind === 'rugged')).toBe(false);
    expect(h.p(r1).killReadyAt).toBe(h.t + 20_000);

    // Cooldown after a kill.
    h.place(b, { x: h.p(r1).x + 10, y: h.p(r1).y });
    h.send(r1, { t: 'kill', targetId: b });
    expect(h.p(b).alive).toBe(true);
    h.advance(20_000);
    h.place(b, { x: h.p(r1).x + 10, y: h.p(r1).y });
    h.send(r1, { t: 'kill', targetId: b });
    expect(h.p(b).alive).toBe(false);
  });

  it("closes the victim's open task", () => {
    const h = new Harness({ players: 5 });
    h.start();
    const [r] = h.ruggers();
    const v = h.holders()[0];
    const st = stationById(h.p(v).tasks[0].stationId)!;
    h.place(v, st);
    h.send(v, { t: 'taskOpen', stationId: st.id });
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r, v);
    expect(h.p(v).activeStationId).toBeNull();
  });
});

describe('meetings', () => {
  function reportSetup(players = 6, settings: Partial<GameSettings> = {}) {
    const h = new Harness({ players, settings: { discussionTime: 15, votingTime: 30, ...settings } });
    h.start();
    scatter(h);
    const [r] = h.ruggers();
    const [victim, reporter, ...rest] = h.holders();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r, victim);
    const body = h.snap(reporter).bodies[0];
    h.place(reporter, { x: body.x + 60, y: body.y });
    return { h, r, victim, reporter, rest };
  }

  it('report -> discussion -> voting -> results -> ejection -> playing', () => {
    const { h, r, victim, reporter, rest } = reportSetup();
    const seqBefore = h.p(reporter).teleportSeq;
    h.clearOutbox();
    h.send(reporter, { t: 'report', bodyId: victim });
    expect(h.room.phase).toBe('meeting');
    const s = h.snap(reporter);
    expect(s.meeting).toMatchObject({ callerId: reporter, reason: 'report', stage: 'discussion', bodyColor: h.p(victim).color });
    expect(s.phaseEndsAt).toBe(h.t + 15_000);
    expect(s.bodies).toEqual([]);
    expect(h.p(reporter).teleportSeq).toBe(seqBefore + 1);
    expect({ x: h.p(reporter).x, y: h.p(reporter).y }).toEqual(SPAWN_POINTS[h.p(reporter).slot]);
    for (const id of h.ids) expect(h.events(id)).toContainEqual({ kind: 'bodyReported', reporterId: reporter, bodyColor: h.p(victim).color });

    // No voting during discussion; ghosts never vote.
    h.send(reporter, { t: 'vote', target: 'skip' });
    expect(h.snap(reporter).meeting!.votedIds).toEqual([]);
    h.advance(15_000);
    expect(h.snap(reporter).meeting!.stage).toBe('voting');
    expect(h.events(rest[0])).toContainEqual({ kind: 'votingOpened' });
    h.send(victim, { t: 'vote', target: r });
    expect(h.snap(reporter).meeting!.votedIds).toEqual([]);

    // A vote for a dead player is refused; a second vote is ignored.
    h.send(reporter, { t: 'vote', target: victim });
    expect(h.snap(reporter).meeting!.votedIds).toEqual([]);
    h.send(reporter, { t: 'vote', target: r });
    h.send(reporter, { t: 'vote', target: 'skip' });
    const ms = h.snap(reporter).meeting!;
    expect(ms.votedIds).toEqual([reporter]);
    expect(ms.myVote).toBe(r);
    expect(ms.votes).toBeUndefined();
    expect(h.snap(rest[0]).meeting!.myVote).toBeUndefined();

    // Everyone living votes -> results right away.
    for (const id of rest) h.send(id, { t: 'vote', target: r });
    expect(h.snap(reporter).meeting!.stage).toBe('voting'); // rugger has not voted yet
    h.send(r, { t: 'vote', target: 'skip' });
    const res = h.snap(reporter);
    expect(res.meeting).toMatchObject({ stage: 'results', ejectedId: r, tie: false });
    expect(res.meeting!.votes![reporter]).toBe(r);
    expect(res.meeting!.votes![r]).toBe('skip');
    expect(res.phaseEndsAt).toBe(h.t + MEETING_RESULTS_MS);

    h.advance(MEETING_RESULTS_MS);
    expect(h.room.phase).toBe('ejection');
    const ej = h.snap(reporter).ejection!;
    expect(ej).toMatchObject({ ejectedId: r, wasRugger: true, tie: false, ruggersLeft: 0, ejectedName: h.p(r).name });
    expect(h.p(r).alive).toBe(false);
    expect(h.snap(reporter).bodies).toEqual([]);

    h.advance(EJECTION_MS);
    expect(h.room.phase).toBe('gameOver');
    expect(h.snap(reporter).gameOver).toMatchObject({ winner: 'holders', reason: 'ruggersEjected' });
  });

  it('a tie or a skip majority ejects nobody, then play resumes with fresh cooldowns', () => {
    const { h, r, victim, reporter, rest } = reportSetup(6, { killCooldown: 30 });
    h.send(reporter, { t: 'report', bodyId: victim });
    h.advance(15_000);
    // living: r, reporter, rest[0..2] -> 2 vs 2 tie plus one non-voter
    h.send(reporter, { t: 'vote', target: rest[0] });
    h.send(rest[1], { t: 'vote', target: rest[0] });
    h.send(rest[0], { t: 'vote', target: r });
    h.send(rest[2], { t: 'vote', target: r });
    h.advance(30_000); // rugger never votes: the timer ends voting
    expect(h.snap(reporter).meeting).toMatchObject({ stage: 'results', ejectedId: null, tie: true });
    h.advance(MEETING_RESULTS_MS);
    expect(h.snap(reporter).ejection).toMatchObject({ ejectedId: null, tie: true, ruggersLeft: 1 });
    h.advance(EJECTION_MS);
    expect(h.room.phase).toBe('playing');
    expect(h.p(r).killReadyAt).toBe(h.t + 30_000);
    expect(h.snap(r).me!.sabotageReadyAt).toBe(h.t + POST_MEETING_COOLDOWN_MS);

    // Second meeting via the SPACES button: skip wins.
    h.place(reporter, { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(reporter, { t: 'emergency' });
    expect(h.room.phase).toBe('meeting');
    expect(h.p(reporter).emergencyLeft).toBe(0);
    h.advance(15_000);
    h.send(reporter, { t: 'vote', target: 'skip' });
    h.send(rest[0], { t: 'vote', target: 'skip' });
    h.send(rest[1], { t: 'vote', target: r });
    h.send(rest[2], { t: 'vote', target: 'skip' });
    h.send(r, { t: 'vote', target: rest[1] });
    expect(h.snap(reporter).meeting).toMatchObject({ stage: 'results', ejectedId: null, tie: false });
    h.advance(MEETING_RESULTS_MS);
    h.advance(EJECTION_MS);
    expect(h.room.phase).toBe('playing');

    // Out of emergency meetings.
    h.place(reporter, { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(reporter, { t: 'emergency' });
    expect(h.room.phase).toBe('playing');
  });

  it('discussionTime 0 goes straight to voting; ejecting a holder hides the role without confirmEjects', () => {
    const { h, victim, reporter, rest } = reportSetup(6, { discussionTime: 0, confirmEjects: false });
    h.send(reporter, { t: 'report', bodyId: victim });
    expect(h.snap(reporter).meeting!.stage).toBe('voting');
    for (const id of h.room.playerIds()) if (h.p(id).alive) h.send(id, { t: 'vote', target: rest[0] });
    h.advance(MEETING_RESULTS_MS);
    const ej = h.snap(reporter).ejection!;
    expect(ej.ejectedId).toBe(rest[0]);
    expect(ej.wasRugger).toBeUndefined();
    expect(h.p(rest[0]).alive).toBe(false);
    expect(h.snap(reporter).bodies).toEqual([]);
  });

  it('a meeting clears sabotage, closes tasks and ejects ruggers from bridges', () => {
    const h = new Harness({ players: 8, settings: { ruggers: 2 } });
    h.start();
    scatter(h);
    const [r1, r2] = h.ruggers();
    const holder = h.holders()[0];
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.send(r1, { t: 'sabotage', kind: 'fud' });
    expect(h.snap(holder).sabotage?.kind).toBe('fud');
    const vent = ventById('v_launch')!;
    h.place(r2, { x: vent.x + 10, y: vent.y });
    h.send(r2, { t: 'vent', action: 'enter', ventId: vent.id });
    expect(h.p(r2).ventId).toBe(vent.id);
    const st = stationById(h.p(holder).tasks[0].stationId)!;
    h.place(holder, st);
    h.send(holder, { t: 'taskOpen', stationId: st.id });
    h.place(holder, { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(holder, { t: 'emergency' });
    expect(h.room.phase).toBe('meeting');
    expect(h.snap(holder).sabotage).toBeNull();
    expect(h.p(r2).ventId).toBeNull();
    expect(h.p(holder).activeStationId).toBeNull();
    for (const id of h.ids) expect(h.events(id)).toContainEqual({ kind: 'emergencyCalled', callerId: holder });
  });
});

describe('sabotage', () => {
  it('shared cooldown, one at a time, holders only see -1 progress during rpcDown, fix by a living player in range', () => {
    const h = new Harness({ players: 8, settings: { ruggers: 2 } });
    h.start();
    const [r1, r2] = h.ruggers();
    const holder = h.holders()[0];
    h.send(r1, { t: 'sabotage', kind: 'rpcDown' });
    expect(h.snap(holder).sabotage).toBeNull(); // on cooldown at game start
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.send(holder, { t: 'sabotage', kind: 'rpcDown' });
    expect(h.snap(holder).sabotage).toBeNull(); // holders can't sabotage
    h.send(r1, { t: 'sabotage', kind: 'rpcDown' });
    expect(h.snap(holder).sabotage).toMatchObject({ kind: 'rpcDown', stations: [{ id: 'rpc_fix', fixed: false }] });
    for (const id of h.ids) expect(h.events(id)).toContainEqual({ kind: 'sabotageStarted', sabotage: 'rpcDown' });
    expect(h.snap(holder).taskProgress).toBe(-1);
    expect(h.snap(r1).taskProgress).toBe(0);
    h.send(r2, { t: 'sabotage', kind: 'fud' });
    expect(h.snap(holder).sabotage?.kind).toBe('rpcDown');

    const st = sabotageStationById('rpc_fix')!;
    h.place(holder, { x: st.x + USE_RANGE * 1.5 + 10, y: st.y });
    h.send(holder, { t: 'fix', stationId: 'rpc_fix', action: 'done' });
    expect(h.snap(holder).sabotage).not.toBeNull();
    h.place(holder, st);
    h.send(holder, { t: 'fix', stationId: 'rpc_fix', action: 'done' });
    expect(h.snap(holder).sabotage).toBeNull();
    for (const id of h.ids) expect(h.events(id)).toContainEqual({ kind: 'sabotageFixed', sabotage: 'rpcDown' });
    expect(h.snap(r2).me!.sabotageReadyAt).toBe(h.t + SABOTAGE_COOLDOWN_MS);
    h.send(r2, { t: 'sabotage', kind: 'fud' });
    expect(h.snap(holder).sabotage).toBeNull();
    h.advance(SABOTAGE_COOLDOWN_MS);
    h.send(r2, { t: 'sabotage', kind: 'fud' });
    expect(h.snap(holder).sabotage?.kind).toBe('fud');
  });

  it('devDump needs both BUY WALLs held at the same tick; walking away drops the hold', () => {
    const h = new Harness({ players: 6 });
    h.start();
    const [r] = h.ruggers();
    const [a, b, c] = h.holders();
    const dumpA = sabotageStationById('dump_a')!;
    const dumpB = sabotageStationById('dump_b')!;
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.send(r, { t: 'sabotage', kind: 'devDump' });
    const sab = h.snap(a).sabotage!;
    expect(sab.kind).toBe('devDump');
    expect(sab.endsAt).toBe(h.t + DEV_DUMP_DURATION_MS);
    expect(sab.stations.map((s) => s.id).sort()).toEqual(['dump_a', 'dump_b']);

    // Emergency is blocked during devDump.
    h.place(c, { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(c, { t: 'emergency' });
    expect(h.room.phase).toBe('playing');

    h.place(a, dumpA);
    h.place(b, dumpB);
    // Too far to hold.
    h.place(c, { x: dumpA.x + USE_RANGE + 10, y: dumpA.y });
    h.send(c, { t: 'fix', stationId: 'dump_a', action: 'holdStart' });
    h.advance(50);
    expect(h.snap(a).sabotage!.stations.find((s) => s.id === 'dump_a')!.holders).toBe(0);

    // One at a time is not enough.
    h.send(a, { t: 'fix', stationId: 'dump_a', action: 'holdStart' });
    h.advance(50);
    expect(h.snap(a).sabotage!.stations.find((s) => s.id === 'dump_a')!.holders).toBe(1);
    h.send(a, { t: 'fix', stationId: 'dump_a', action: 'holdEnd' });
    h.send(b, { t: 'fix', stationId: 'dump_b', action: 'holdStart' });
    h.advance(50);
    expect(h.snap(a).sabotage).not.toBeNull();

    // Walking away drops the hold.
    h.place(b, { x: dumpB.x - USE_RANGE * 1.5 - 5, y: dumpB.y });
    h.advance(50);
    expect(h.snap(a).sabotage!.stations.find((s) => s.id === 'dump_b')!.holders).toBe(0);

    // Both at once fixes it.
    h.place(b, dumpB);
    h.send(b, { t: 'fix', stationId: 'dump_b', action: 'holdStart' });
    h.send(a, { t: 'fix', stationId: 'dump_a', action: 'holdStart' });
    h.advance(50);
    expect(h.snap(a).sabotage).toBeNull();
    expect(h.events(c)).toContainEqual({ kind: 'sabotageFixed', sabotage: 'devDump' });
    expect(h.room.phase).toBe('playing');
  });

  it('a holder who dies or disconnects is dropped from the BUY WALL', () => {
    const h = new Harness({ players: 6 });
    h.start();
    const [r] = h.ruggers();
    const [a, b] = h.holders();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.send(r, { t: 'sabotage', kind: 'devDump' });
    h.place(a, sabotageStationById('dump_a')!);
    h.place(b, sabotageStationById('dump_b')!);
    h.send(a, { t: 'fix', stationId: 'dump_a', action: 'holdStart' });
    h.room.setDisconnected(a);
    h.send(b, { t: 'fix', stationId: 'dump_b', action: 'holdStart' });
    h.advance(50);
    expect(h.snap(b).sabotage).not.toBeNull();
    h.kill(r, b);
    h.advance(50);
    expect(h.snap(r).sabotage!.stations.every((s) => s.holders === 0)).toBe(true);
  });
});

describe('bridges', () => {
  it('only living ruggers in range enter; moves follow links; no kills or tasks inside', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const [r] = h.ruggers();
    const holder = h.holders()[0];
    const v = ventById('v_launch')!;
    h.place(holder, { x: v.x + 10, y: v.y });
    h.send(holder, { t: 'vent', action: 'enter', ventId: v.id });
    expect(h.p(holder).ventId).toBeNull();

    h.place(r, { x: v.x + 70, y: v.y });
    h.send(r, { t: 'vent', action: 'enter', ventId: v.id });
    expect(h.p(r).ventId).toBeNull();
    h.place(r, { x: v.x + 40, y: v.y });
    const seq = h.p(r).teleportSeq;
    h.send(r, { t: 'vent', action: 'enter', ventId: v.id });
    expect(h.p(r).ventId).toBe(v.id);
    expect({ x: h.p(r).x, y: h.p(r).y }).toEqual({ x: v.x, y: v.y });
    expect(h.p(r).teleportSeq).toBe(seq + 1);
    expect(h.snap(r).me!.ventId).toBe(v.id);

    // Movement is ignored while inside.
    h.advance(500);
    h.send(r, { t: 'move', x: v.x + 10, y: v.y, facing: 1, moving: true });
    expect(h.p(r).x).toBe(v.x);

    // Unlinked bridge refused; linked one works.
    h.send(r, { t: 'vent', action: 'move', ventId: 'v_kol' });
    expect(h.p(r).ventId).toBe(v.id);
    h.send(r, { t: 'vent', action: 'move', ventId: 'v_pool_n' });
    const pool = ventById('v_pool_n')!;
    expect(h.p(r).ventId).toBe('v_pool_n');
    expect({ x: h.p(r).x, y: h.p(r).y }).toEqual({ x: pool.x, y: pool.y });
    expect(h.p(r).teleportSeq).toBe(seq + 2);

    // No kill from inside.
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.place(holder, { x: pool.x + 20, y: pool.y });
    h.send(r, { t: 'kill', targetId: holder });
    expect(h.p(holder).alive).toBe(true);

    h.send(r, { t: 'vent', action: 'exit' });
    expect(h.p(r).ventId).toBeNull();
    expect({ x: h.p(r).x, y: h.p(r).y }).toEqual({ x: pool.x, y: pool.y });
    h.send(r, { t: 'kill', targetId: holder });
    expect(h.p(holder).alive).toBe(false);
  });
});

describe('snapshot visibility', () => {
  it('holders never receive ghosts or vented ruggers; ruggers see vented fellows; ghosts see everything', () => {
    const h = new Harness({ players: 8, settings: { ruggers: 2 } });
    h.start();
    scatter(h);
    const [r1, r2] = h.ruggers();
    const [victim, holder] = h.holders();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r1, victim);
    const v = ventById('v_launch')!;
    h.place(r2, { x: v.x + 10, y: v.y });
    h.send(r2, { t: 'vent', action: 'enter', ventId: v.id });

    const hs = h.snap(holder);
    const hIds = hs.players.map((p) => p.id);
    expect(hIds).not.toContain(victim);
    expect(hIds).not.toContain(r2);
    expect(hIds).toContain(r1);
    expect(hs.players.some((p) => p.isRugger !== undefined || p.inVent !== undefined)).toBe(false);
    expect(hs.players.every((p) => p.alive)).toBe(true);
    expect(hs.bodies.map((b) => b.id)).toEqual([victim]);
    expect(hs.me!.role).toBe('holder');

    const rs = h.snap(r1);
    expect(rs.players.map((p) => p.id)).not.toContain(victim);
    const fellow = rs.players.find((p) => p.id === r2)!;
    expect(fellow).toMatchObject({ isRugger: true, inVent: true });
    expect(rs.players.find((p) => p.id === r1)!.isRugger).toBe(true);
    expect(rs.players.filter((p) => p.isRugger).length).toBe(2);
    expect(rs.bodies.map((b) => b.id)).toEqual([victim]);

    const gs = h.snap(victim);
    expect(gs.players.length).toBe(8);
    expect(gs.players.find((p) => p.id === victim)!.alive).toBe(false);
    expect(gs.players.filter((p) => p.isRugger).map((p) => p.id).sort()).toEqual([r1, r2].sort());
    expect(gs.players.find((p) => p.id === r2)!.inVent).toBe(true);

    // The broadcast path uses the same per-client view.
    h.clearOutbox();
    h.advance(50);
    const sentSnap = h.outbox(holder).find((m): m is Snapshot => m.t === 'snap')!;
    expect(sentSnap.players.map((p) => p.id)).not.toContain(r2);
    expect(sentSnap.players.map((p) => p.id)).not.toContain(victim);
  });

  it('meeting cards include the dead; game over reveals everyone with roles', () => {
    const h = new Harness({ players: 4 });
    h.start();
    scatter(h);
    const [r] = h.ruggers();
    const [a, b, c] = h.holders();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r, a);
    h.place(b, { x: h.p(r).x + 50, y: h.p(r).y + 20 });
    h.send(b, { t: 'report', bodyId: a });
    const ms = h.snap(c);
    expect(ms.players.find((p) => p.id === a)).toMatchObject({ alive: false });
    expect(ms.players.some((p) => p.isRugger)).toBe(false);
    h.advance(DEFAULT_SETTINGS.discussionTime * 1000);
    h.send(b, { t: 'vote', target: c });
    h.send(c, { t: 'vote', target: b });
    h.send(r, { t: 'vote', target: b });
    h.advance(MEETING_RESULTS_MS);
    h.advance(EJECTION_MS);
    expect(h.room.phase).toBe('gameOver'); // 1 rugger vs 1 holder
    const go = h.snap(c);
    expect(go.gameOver).toMatchObject({ winner: 'ruggers', reason: 'parity' });
    expect(go.players.length).toBe(4);
    expect(go.players.find((p) => p.id === r)!.isRugger).toBe(true);
    expect(go.gameOver!.roles[r]).toBe('rugger');
    expect(go.gameOver!.roles[a]).toBe('holder');
  });

  it('sends snapshots every tick while playing, otherwise on change and at least every 500 ms', () => {
    const h = new Harness({ players: 4 });
    const id = h.ids[1];
    const snaps = () => h.outbox(id).filter((m) => m.t === 'snap').length;
    h.advance(0);
    expect(snaps()).toBe(1);
    for (let i = 0; i < 9; i++) h.advance(50);
    expect(snaps()).toBe(1);
    h.advance(50);
    expect(snaps()).toBe(2);
    h.send(h.ids[2], { t: 'setColor', color: 7 });
    h.advance(50);
    expect(snaps()).toBe(3);
    h.start();
    const base = snaps();
    for (let i = 0; i < 10; i++) h.advance(50);
    expect(snaps()).toBe(base + 10);
  });
});

describe('win conditions', () => {
  it('holders win on tasks, ghosts included, and results are recorded for wallets', () => {
    const h = new Harness({ players: 4, wallets: true, settings: { tasksPerPlayer: 2 } });
    h.start();
    scatter(h);
    const [r] = h.ruggers();
    const [a, b, c] = h.holders();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r, a);
    expect(h.room.phase).toBe('playing');
    for (const id of [a, b, c]) {
      for (const t of [...h.p(id).tasks]) {
        expect(h.room.phase).toBe('playing');
        h.doTask(id, t.stationId);
      }
    }
    expect(h.room.phase).toBe('gameOver');
    expect(h.snap(b).gameOver).toMatchObject({ winner: 'holders', reason: 'tasks' });
    expect(h.records.length).toBe(1);
    const rec = h.records[0];
    expect(rec.length).toBe(4);
    const byAddr = (id: string) => rec.find((x) => x.address === h.p(id).address)!;
    expect(byAddr(r)).toMatchObject({ role: 'rugger', won: false, rugs: 1, tasksDone: 0, wasRugged: false });
    expect(byAddr(a)).toMatchObject({ role: 'holder', won: true, tasksDone: 2, wasRugged: true });
    expect(byAddr(b)).toMatchObject({ role: 'holder', won: true, tasksDone: 2, wasRugged: false });
  });

  it('holders win when the last rugger is voted out, with correctVotes recorded', () => {
    const h = new Harness({ players: 5, wallets: true });
    h.start();
    const [r] = h.ruggers();
    const hs = h.holders();
    h.place(hs[0], { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(hs[0], { t: 'emergency' });
    h.advance(DEFAULT_SETTINGS.discussionTime * 1000);
    h.send(hs[0], { t: 'vote', target: r });
    h.send(hs[1], { t: 'vote', target: r });
    h.send(hs[2], { t: 'vote', target: r });
    h.send(hs[3], { t: 'vote', target: 'skip' });
    h.send(r, { t: 'vote', target: hs[0] });
    h.advance(MEETING_RESULTS_MS);
    expect(h.room.phase).toBe('ejection');
    h.advance(EJECTION_MS);
    expect(h.snap(hs[0]).gameOver).toMatchObject({ winner: 'holders', reason: 'ruggersEjected' });
    const rec = h.records[0];
    const cv = (id: string) => rec.find((x) => x.address === h.p(id).address)!.correctVotes;
    expect([cv(hs[0]), cv(hs[1]), cv(hs[2]), cv(hs[3]), cv(r)]).toEqual([1, 1, 1, 0, 0]);
  });

  it('ruggers win on parity right after a kill', () => {
    const h = new Harness({ players: 4, settings: { killCooldown: 10 } });
    h.start();
    scatter(h);
    const [r] = h.ruggers();
    const [a, b] = h.holders();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r, a);
    expect(h.room.phase).toBe('playing');
    h.advance(10_000);
    h.kill(r, b);
    expect(h.room.phase).toBe('gameOver');
    expect(h.snap(r).gameOver).toMatchObject({ winner: 'ruggers', reason: 'parity' });
    expect(h.records.length).toBe(0); // no wallets linked: nothing recorded
  });

  it('ruggers win when the DEV DUMP timer runs out', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const [r] = h.ruggers();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.send(r, { t: 'sabotage', kind: 'devDump' });
    h.advance(DEV_DUMP_DURATION_MS - 50);
    expect(h.room.phase).toBe('playing');
    h.advance(50);
    expect(h.room.phase).toBe('gameOver');
    expect(h.snap(r).gameOver).toMatchObject({ winner: 'ruggers', reason: 'devDump' });
    expect(h.snap(r).sabotage).toBeNull();
  });

  it('backToLobby (host only) resets the round, keeps colors and drops disconnected players', () => {
    const h = new Harness({ players: 5 });
    h.send(h.ids[3], { t: 'setColor', color: 9 });
    h.start();
    const [r] = h.ruggers();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.send(r, { t: 'sabotage', kind: 'devDump' });
    h.advance(DEV_DUMP_DURATION_MS);
    expect(h.room.phase).toBe('gameOver');
    const gone = h.ids.find((id) => id !== h.host && id !== h.ids[3])!;
    h.room.setDisconnected(gone);
    h.send(h.ids[3], { t: 'backToLobby' });
    expect(h.room.phase).toBe('gameOver');
    h.send(h.host, { t: 'backToLobby' });
    expect(h.room.phase).toBe('lobby');
    expect(h.room.getPlayer(gone)).toBeUndefined();
    expect(h.room.playerCount).toBe(4);
    expect(h.p(h.ids[3]).color).toBe(9);
    for (const id of h.room.playerIds()) expect(h.p(id)).toMatchObject({ alive: true, role: 'holder', tasks: [] });
    const s = h.snap(h.host);
    expect(s.me).toBeUndefined();
    expect(s.gameOver).toBeUndefined();
    expect(s.players.some((p) => p.isRugger)).toBe(false);
  });
});

describe('disconnects', () => {
  it('keeps the seat during the grace window and restores it on rejoin with the right key', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const id = h.holders()[0];
    const other = h.holders()[1];
    h.room.setDisconnected(id);
    expect(h.snap(other).players.find((p) => p.id === id)!.disconnected).toBe(true);
    h.advance(RECONNECT_GRACE_MS - 1000);
    expect(h.room.getPlayer(id)).toBeDefined();
    expect(h.room.rejoin(id, 'wrong-key')).toBeNull();
    const seq = h.p(id).teleportSeq;
    const back = h.room.rejoin(id, h.p(id).sessionKey);
    expect(back?.id).toBe(id);
    expect(h.p(id).connected).toBe(true);
    expect(h.p(id).teleportSeq).toBe(seq + 1);
    h.advance(RECONNECT_GRACE_MS);
    expect(h.room.getPlayer(id)).toBeDefined();
  });

  it('removes the player after the grace window, drops their tasks from the curve and runs the win check', () => {
    const h = new Harness({ players: 5, settings: { tasksPerPlayer: 2 } });
    h.start();
    const [r] = h.ruggers();
    const [a, b] = h.holders();
    h.doTask(a, h.p(a).tasks[0].stationId);
    h.doTask(b, h.p(b).tasks[0].stationId);
    expect(h.room.taskProgress()).toBeCloseTo(2 / 8);
    h.room.setDisconnected(a);
    h.advance(RECONNECT_GRACE_MS - 1);
    expect(h.room.getPlayer(a)).toBeDefined();
    h.advance(1);
    expect(h.room.getPlayer(a)).toBeUndefined();
    expect(h.removed).toContainEqual({ id: a, reason: 'timeout' });
    expect(h.room.taskProgress()).toBeCloseTo(1 / 6);
    expect(h.room.rejoin(a, 'anything')).toBeNull();
    expect(h.room.phase).toBe('playing');
    for (const id of h.ids) if (h.room.getPlayer(id)) expect(h.events(id)).toContainEqual({ kind: 'playerLeft', playerId: a, name: 'p' + h.ids.indexOf(a) });

    // The rugger leaving for good ends the game.
    h.room.setDisconnected(r);
    h.advance(RECONNECT_GRACE_MS);
    expect(h.room.phase).toBe('gameOver');
    expect(h.snap(b).gameOver).toMatchObject({ winner: 'holders', reason: 'ruggersEjected' });
  });

  it('host migration skips disconnected humans and bots', () => {
    const h = new Harness({ players: 3 });
    h.send(h.host, { t: 'addBot' });
    h.room.setDisconnected(h.ids[1]);
    h.send(h.ids[0], { t: 'leave' });
    expect(h.host).toBe(h.ids[2]);
  });

  it('a player leaving mid-vote lets the meeting finish early', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const [r] = h.ruggers();
    const hs = h.holders();
    h.place(hs[0], { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(hs[0], { t: 'emergency' });
    h.advance(DEFAULT_SETTINGS.discussionTime * 1000);
    for (const id of [hs[0], hs[1], hs[2], r]) h.send(id, { t: 'vote', target: 'skip' });
    expect(h.snap(hs[0]).meeting!.stage).toBe('voting');
    h.send(hs[3], { t: 'leave' });
    expect(h.snap(hs[0]).meeting!.stage).toBe('results');
  });
});

describe('chat', () => {
  it('routes channels by phase and liveness, rate-limits and sanitizes', () => {
    const h = new Harness({ players: 5 });
    const [p0, p1] = h.ids;
    h.send(p0, { t: 'chat', text: '  gm \u0007 frens  ' });
    const lobbyMsg = h.chats(p1).find((m) => m.channel === 'lobby')!;
    expect(lobbyMsg).toMatchObject({ fromId: p0, text: 'gm frens', color: h.p(p0).color });
    h.send(p0, { t: 'chat', text: 'spam' });
    expect(h.errors(p0)).toContain('RATE_LIMITED');
    h.t += CHAT_RATE_LIMIT_MS;
    h.send(p0, { t: 'chat', text: '   ' });
    expect(h.chats(p1).filter((m) => m.channel === 'lobby').length).toBe(1);

    h.start();
    scatter(h);
    const [r] = h.ruggers();
    const [ghost, alive] = h.holders();
    h.clearOutbox();
    h.t += CHAT_RATE_LIMIT_MS;
    h.send(alive, { t: 'chat', text: 'living cannot talk in playing' });
    expect(h.chats(ghost).length).toBe(0);
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r, ghost);
    h.send(ghost, { t: 'chat', text: 'boo' });
    expect(h.chats(alive).length).toBe(0);
    expect(h.chats(ghost).map((m) => m.channel)).toEqual(['ghost']);

    h.place(alive, { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(alive, { t: 'emergency' });
    h.clearOutbox();
    h.t += CHAT_RATE_LIMIT_MS;
    h.send(alive, { t: 'chat', text: 'dev is sus' });
    h.send(ghost, { t: 'chat', text: 'it was red' });
    expect(h.chats(r).map((m) => [m.channel, m.text])).toEqual([['meeting', 'dev is sus']]);
    expect(h.chats(ghost).map((m) => [m.channel, m.text])).toEqual([
      ['meeting', 'dev is sus'],
      ['ghost', 'it was red'],
    ]);
  });
});

describe('bots', () => {
  class FakeBrain implements BotBrainLike {
    snaps: Snapshot[] = [];
    ticks: number[] = [];
    chats: ChatMessage[] = [];
    events: GameEvent[] = [];
    explode = false;
    constructor(readonly init: BotBrainInit) {}
    onSnapshot(snap: Snapshot): void {
      if (this.explode) throw new Error('boom');
      this.snaps.push(snap);
    }
    onChat(msg: ChatMessage): void {
      this.chats.push(msg);
    }
    onEvent(event: GameEvent): void {
      this.events.push(event);
    }
    tick(now: number): void {
      if (this.explode) throw new Error('boom');
      this.ticks.push(now);
    }
  }

  it('bots get their own snapshot, chat and events every tick, act through the protocol and never crash the room', () => {
    const brains: FakeBrain[] = [];
    const h = new Harness({
      players: 1,
      brains: (init) => {
        const b = new FakeBrain(init);
        brains.push(b);
        return b;
      },
    });
    for (let i = 0; i < 3; i++) h.send(h.host, { t: 'addBot' });
    expect(brains.length).toBe(3);
    expect(new Set(brains.map((b) => b.init.seed)).size).toBe(3);
    const botIds = brains.map((b) => b.init.id);
    expect(botIds.every((id) => h.p(id).isBot)).toBe(true);
    expect(new Set(botIds.map((id) => h.p(id).name)).size).toBe(3);

    h.send(h.host, { t: 'chat', text: 'gm bots' });
    h.advance(50);
    for (const b of brains) {
      expect(b.snaps.at(-1)!.me).toBeUndefined(); // lobby
      expect(b.ticks).toEqual([h.t]);
      expect(b.chats.some((c) => c.text === 'gm bots')).toBe(true);
    }
    // A bot can act through the protocol (here: chat).
    brains[0].init.send({ t: 'chat', text: 'trust me bro' });
    expect(h.chats(h.host).some((c) => c.fromId === botIds[0] && c.text === 'trust me bro')).toBe(true);

    h.start();
    h.advance(50);
    for (const b of brains) {
      expect(b.events).toContainEqual({ kind: 'gameStarted' });
      const last = b.snaps.at(-1)!;
      expect(last.phase).toBe('playing');
      expect(last.me!.id).toBe(b.init.id);
    }
    brains[1].explode = true;
    expect(() => h.advance(50)).not.toThrow();
    expect(h.room.phase).toBe('playing');
    expect(brains[2].ticks.length).toBeGreaterThan(2);

    // Bots never host: when the only human leaves, the room is marked for destruction.
    h.send(h.host, { t: 'leave' });
    expect(h.room.shouldDestroy()).toBe(true);
  });
});

describe('interest management (snapshots while playing)', () => {
  const row = (dx: number) => ({ x: at(24, 3).x + dx, y: at(24, 3).y });

  it('a living holder only receives players within vision + margin and in line of sight', () => {
    const h = new Harness({ players: 6, settings: { crewVision: 1 } });
    h.start();
    const [r] = h.ruggers();
    const [holder, near, far, walled] = h.holders();
    const reach = BASE_VISION + 120;
    h.place(holder, row(0));
    h.place(near, row(reach - 20)); // outside drawn vision but inside the margin
    h.place(far, row(reach + 20));
    h.place(r, { x: 2300, y: 300 }); // far across the map
    // Close but behind the wall band between the launchpad and the liquidity pool.
    h.place(holder, at(27, 11));
    h.place(walled, at(27, 16));
    expect(lineOfSight(at(27, 11), at(27, 16))).toBe(false);
    h.settle();
    let ids = h.snap(holder).players.map((p) => p.id);
    expect(ids).toContain(holder);
    expect(ids).not.toContain(walled);
    expect(ids).not.toContain(r);

    h.place(holder, row(0));
    ids = h.snap(holder).players.map((p) => p.id);
    expect(ids).toContain(near);
    expect(ids).not.toContain(far);
    expect(ids).not.toContain(r);
    expect(ids).not.toContain(walled);
    // Bodies stay visible to everyone wherever they are.
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r, far);
    h.place(r, { x: 2300, y: 300 });
    expect(h.snap(holder).bodies.map((b) => b.id)).toEqual([far]);
    // The broadcast path is filtered the same way.
    h.clearOutbox();
    h.advance(50);
    const sent = h.outbox(holder).find((m): m is Snapshot => m.t === 'snap')!;
    expect(sent.players.map((p) => p.id)).not.toContain(r);
    expect(sent.players.map((p) => p.id)).toContain(near);
  });

  it('is lenient at wall edges: a player whose edge is in sight is sent', () => {
    const h = new Harness({ players: 4 });
    h.start();
    const [a, b] = h.holders();
    const viewer = at(27, 11);
    h.place(a, viewer);
    // Find a point straight below the wall band edge whose center is hidden but whose side is not.
    let edge: { x: number; y: number } | null = null;
    for (let x = viewer.x - 400; x < viewer.x + 400 && !edge; x += 2) {
      for (let y = viewer.y + 40; y < viewer.y + 260 && !edge; y += 2) {
        if (!circleFree(x, y) || lineOfSight(viewer, { x, y })) continue;
        const sides = [{ x: x + PLAYER_RADIUS, y }, { x: x - PLAYER_RADIUS, y }, { x, y: y + PLAYER_RADIUS }, { x, y: y - PLAYER_RADIUS }];
        if (sides.some((q) => lineOfSight(viewer, q)) && Math.hypot(x - viewer.x, y - viewer.y) < BASE_VISION) edge = { x, y };
      }
    }
    expect(edge).not.toBeNull();
    h.place(b, edge!);
    expect(h.snap(a).players.map((p) => p.id)).toContain(b);
  });

  it('a vented rugger and an out-of-view player look the same to a holder; ruggers always see fellow ruggers', () => {
    const h = new Harness({ players: 8, settings: { ruggers: 2 } });
    h.start();
    const [r1, r2] = h.ruggers();
    const [holder, other] = h.holders();
    const v = ventById('v_launch')!;
    h.place(holder, { x: v.x + 60, y: v.y });
    h.place(other, { x: 2300, y: 300 });
    h.place(r1, { x: 2380, y: 1300 });
    h.place(r2, { x: v.x + 10, y: v.y });
    h.settle();
    expect(h.snap(holder).players.map((p) => p.id)).toContain(r2);
    // In plain view: gone at once (no hold for bridges), as the holder's client shows it.
    h.send(r2, { t: 'vent', action: 'enter', ventId: v.id });
    const hs = h.snap(holder);
    const ids = hs.players.map((p) => p.id);
    expect(ids).not.toContain(r2);
    expect(ids).not.toContain(other);
    expect(ids).not.toContain(r1);
    expect(hs.players.some((p) => p.isRugger !== undefined || p.inVent !== undefined)).toBe(false);
    // Fellow ruggers: across the map and inside a bridge.
    const rs = h.snap(r1);
    expect(rs.players.find((p) => p.id === r2)).toMatchObject({ isRugger: true, inVent: true });
    expect(rs.players.map((p) => p.id)).not.toContain(holder); // a holder far from r1 is filtered for ruggers too
    expect(h.snap(r2).players.find((p) => p.id === r1)).toMatchObject({ isRugger: true });
    expect(h.snap(r2).players.map((p) => p.id)).toContain(holder);
  });

  it('uses each role\'s vision setting, and FUD shrinks holders\' radius once the fog has closed in', () => {
    const h = new Harness({ players: 5, settings: { crewVision: 1, ruggerVision: 1.5 } });
    h.start();
    const [r] = h.ruggers();
    const [holder, other] = h.holders();
    h.place(holder, row(0));
    h.place(other, row(250));
    h.place(r, row(500));
    h.settle();
    expect(h.snap(holder).players.map((p) => p.id)).toContain(other);
    expect(h.snap(holder).players.map((p) => p.id)).not.toContain(r); // 500 > 300 + 120
    expect(h.snap(r).players.map((p) => p.id)).toContain(holder); // 500 <= 450 + 120
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.send(r, { t: 'sabotage', kind: 'fud' });
    expect(h.snap(holder).players.map((p) => p.id)).toContain(other); // fog is still closing in
    h.advance(450);
    expect(h.snap(holder).players.map((p) => p.id)).toContain(other); // still closing in
    h.advance(150);
    expect(BASE_VISION * FUD_VISION_MULT + 120).toBeLessThan(250);
    expect(h.snap(holder).players.map((p) => p.id)).toContain(other); // held a little longer
    h.advance(INTEREST_HOLD_MS);
    expect(h.snap(holder).players.map((p) => p.id)).not.toContain(other);
    expect(h.snap(r).players.map((p) => p.id)).toContain(holder); // ruggers are not affected
    h.place(holder, sabotageStationById('fud_fix')!);
    h.send(holder, { t: 'fix', stationId: 'fud_fix', action: 'done' });
    h.place(holder, row(0));
    expect(h.snap(holder).players.map((p) => p.id)).toContain(other);
  });

  it('keeps sending a player for INTEREST_HOLD_MS after it last qualified, then drops it', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const [a, b] = h.holders();
    h.place(a, at(27, 11));
    h.place(b, at(27, 9));
    h.settle();
    expect(h.snap(a).players.map((p) => p.id)).toContain(b);
    h.place(b, at(27, 16)); // behind the wall band
    h.advance(INTEREST_HOLD_MS - 50);
    expect(h.snap(a).players.find((p) => p.id === b)).toMatchObject({ x: at(27, 16).x, y: at(27, 16).y }); // live position
    h.advance(100);
    expect(h.snap(a).players.map((p) => p.id)).not.toContain(b);
    // Back in sight: sent again at once.
    h.place(b, at(27, 9));
    expect(h.snap(a).players.map((p) => p.id)).toContain(b);
  });

  it('tests line of sight from ahead along the viewer\'s velocity, so a walking viewer sees round corners in time', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const [a, b] = h.holders();
    const target = at(31, 17); // in the liquidity pool, seen through the door from far enough east
    const hidden = (e: { x: number; y: number }) =>
      [[0, 0], [PLAYER_RADIUS, 0], [-PLAYER_RADIUS, 0], [0, PLAYER_RADIUS], [0, -PLAYER_RADIUS]].every(
        ([ox, oy]) => !lineOfSight(e, { x: target.x + ox, y: target.y + oy }),
      );
    // Find a spot on row 11 where neither the viewer nor any probe sees the target, but a point 72 px
    // ahead (360 ms at 200 px/s) does: only the lookahead can include it there.
    const P = INTEREST_PROBE_PX;
    let eye: { x: number; y: number } | null = null;
    for (let x = at(26, 11).x; x <= at(31, 11).x && !eye; x++) {
      const e = { x, y: at(28, 11).y };
      const probes = [[0, 0], [P, 0], [-P, 0], [0, P], [0, -P]].map(([dx, dy]) => moveWithCollision(e.x, e.y, dx, dy));
      if (probes.every(hidden) && !hidden({ x: e.x + 72, y: e.y })) eye = e;
    }
    expect(eye).not.toBeNull();
    if (!eye) return;
    h.place(b, target);
    h.place(a, { x: eye.x - 30, y: eye.y });
    h.settle();
    expect(h.snap(a).players.map((p) => p.id)).not.toContain(b);
    h.walk(a, 10, 0, 3); // 200 px/s east, arriving at `eye`
    expect(h.p(a).x).toBe(eye.x);
    expect(h.snap(a).players.map((p) => p.id)).toContain(b);
    // Standing still at the same spot, nothing is ahead of the server's copy: dropped after the hold.
    h.t += 50;
    h.send(a, { t: 'move', x: eye.x, y: eye.y, facing: 1, moving: false });
    h.settle();
    expect(h.snap(a).players.map((p) => p.id)).not.toContain(b);
  });

  it('also tests from probes around the viewer, stopped by walls', () => {
    const h = new Harness({ players: 5 });
    h.start();
    const [a, b, c] = h.holders();
    const eye = at(29, 11);
    const target = at(30, 16); // in the door corridor, hidden from `eye` but seen from a probe east of it
    expect(lineOfSight(eye, target)).toBe(false);
    expect(lineOfSight({ x: eye.x + 64, y: eye.y }, target)).toBe(true);
    h.place(a, eye);
    h.place(b, target);
    h.place(c, at(27, 16)); // behind the thick wall band: no probe reaches past the wall
    h.settle();
    const ids = h.snap(a).players.map((p) => p.id);
    expect(ids).toContain(b);
    expect(ids).not.toContain(c);
  });

  describe('a rugger entering a bridge', () => {
    // Launchpad: the bridge at tile (25, 7) and open floor east of it along row 7.
    function setup() {
      const h = new Harness({ players: 8, settings: { ruggers: 2 } });
      h.start();
      const [r, r2] = h.ruggers();
      const [far, near, other] = h.holders();
      const v = ventById('v_launch')!;
      h.place(r, { x: v.x + 20, y: v.y });
      h.place(far, { x: v.x + 20 + 360, y: v.y }); // in reach (300 + 120), outside drawn vision (300)
      h.place(near, { x: v.x + 120, y: v.y }); // plainly sees r
      h.place(other, { x: 2300, y: 300 });
      h.place(r2, { x: 2380, y: 1300 });
      for (const id of h.room.playerIds()) if (![r, far, near].includes(id)) h.place(id, { x: 2300 + (id === r2 ? 80 : 0), y: 300 });
      h.settle();
      expect(h.snap(far).players.map((p) => p.id)).toContain(r);
      expect(h.snap(near).players.map((p) => p.id)).toContain(r);
      const pre = { x: h.p(r).x, y: h.p(r).y };
      h.send(r, { t: 'vent', action: 'enter', ventId: v.id });
      expect(h.p(r).ventId).toBe(v.id);
      return { h, r, r2, far, near, v, pre };
    }

    /** The last snapshot the room broadcast to `id`. */
    function lastSent(h: Harness, id: string): Snapshot {
      const snaps = h.outbox(id).filter((m): m is Snapshot => m.t === 'snap');
      expect(snaps.length).toBeGreaterThan(0);
      return snaps[snaps.length - 1];
    }

    it('vanishes at once for every holder, in plain view or not; fellow ruggers see the truth', () => {
      const { h, r, r2, far, near } = setup();
      expect(h.snap(near).players.map((p) => p.id)).not.toContain(r);
      expect(h.snap(far).players.map((p) => p.id)).not.toContain(r);
      expect(h.snap(r2).players.find((p) => p.id === r)).toMatchObject({ inVent: true, isRugger: true });
    });

    it('is absent from the very next snapshot of a holder who had it in interest but out of plain view', () => {
      const { h, r, far, pre } = setup();
      // `far` was receiving r through interest only: beyond its drawn vision, inside the margin.
      expect(Math.hypot(pre.x - h.p(far).x, pre.y - h.p(far).y)).toBeGreaterThan(BASE_VISION);
      expect(Math.hypot(pre.x - h.p(far).x, pre.y - h.p(far).y)).toBeLessThanOrEqual(BASE_VISION + 120);
      const before = h.outbox(far).length;
      h.advance(50);
      const next = h.outbox(far).slice(before).filter((m): m is Snapshot => m.t === 'snap');
      expect(next.length).toBe(1);
      expect(next[0].players.map((p) => p.id)).not.toContain(r);
      // Nothing takes its place, and no hold brings it back while it stays inside.
      for (let i = 0; i < 20; i++) {
        h.advance(50);
        expect(lastSent(h, far).players.map((p) => p.id)).not.toContain(r);
      }
    });

    it('is sent again at once when it comes out in interest, and not through any hold when it comes out far away', () => {
      const { h, r, far, v } = setup();
      h.advance(500);
      h.send(r, { t: 'vent', action: 'exit' });
      const real = h.snap(far).players.find((p) => p.id === r)!;
      expect({ x: real.x, y: real.y, moving: real.moving, inVent: real.inVent }).toEqual({ x: v.x, y: v.y, moving: false, inVent: undefined });
      // A rugger coming out far away is not sent through any hold.
      h.send(r, { t: 'vent', action: 'enter', ventId: v.id });
      expect(h.snap(far).players.map((p) => p.id)).not.toContain(r);
      h.send(r, { t: 'vent', action: 'move', ventId: 'v_pool_n' });
      h.send(r, { t: 'vent', action: 'exit' });
      h.place(far, { x: 2300, y: 340 });
      h.settle();
      expect(h.snap(far).players.map((p) => p.id)).not.toContain(r);
    });

    it('pops the hatch it comes out of for a holder who had it in interest out of plain view (client bridgePops)', () => {
      const h = new Harness({ players: 5, settings: { ruggers: 1 } });
      h.start();
      const [r] = h.ruggers();
      const [holder, ...rest] = h.holders();
      const a = ventById('v_launch')!;
      const b = ventById('v_pool_n')!;
      expect(a.links).toContain(b.id);
      const eye = { x: 1340, y: 515 };
      const rpos = { x: a.x + 20, y: a.y };
      const canSee = (x: number, y: number) => Math.hypot(x - eye.x, y - eye.y) <= BASE_VISION && lineOfSight(eye, { x, y });
      expect(canSee(b.x, b.y)).toBe(true); // the holder watches the hatch the rugger will come out of...
      expect(canSee(rpos.x, rpos.y)).toBe(false); // ...but not the spot where it goes in,
      expect(Math.hypot(rpos.x - eye.x, rpos.y - eye.y)).toBeLessThanOrEqual(BASE_VISION + 120);
      expect(lineOfSight(eye, rpos)).toBe(true); // which is still in its interest.
      for (const id of rest) h.place(id, { x: 2300, y: 300 });
      h.place(holder, eye);
      h.place(r, rpos);
      h.settle();
      const snaps: Snapshot[] = [];
      const tick = () => {
        h.advance(50);
        snaps.push(lastSent(h, holder));
      };
      tick();
      expect(snaps[0].players.map((p) => p.id)).toContain(r);
      h.send(r, { t: 'vent', action: 'enter', ventId: a.id });
      tick();
      expect(snaps[1].players.map((p) => p.id)).not.toContain(r);
      tick();
      h.send(r, { t: 'vent', action: 'move', ventId: b.id });
      tick();
      tick();
      expect(snaps.slice(1).every((s) => !s.players.some((p) => p.id === r))).toBe(true);
      h.send(r, { t: 'vent', action: 'exit' });
      tick();
      expect(snaps[snaps.length - 1].players.find((p) => p.id === r)).toMatchObject({ x: b.x, y: b.y, moving: false });
      const pops: string[] = [];
      for (let i = 1; i < snaps.length; i++) {
        const vents = bridgePops({
          prevPrev: snaps[i - 2] ?? null,
          prev: snaps[i - 1],
          snap: snaps[i],
          me: snaps[i].me!,
          canSee,
          ventsSeenBefore: ventsInSight(canSee),
          departed: new Set(),
        });
        pops.push(...vents.map((v) => v.id));
      }
      // The exit pops; the entry, out of the holder's view, does not.
      expect(pops).toEqual([b.id]);
    });
  });

  it('ghosts, bots, and non-playing phases', () => {
    const brains: Array<{ id: string; snaps: Snapshot[] }> = [];
    const h = new Harness({
      players: 4,
      brains: (init) => {
        const b = { id: init.id, snaps: [] as Snapshot[] };
        brains.push(b);
        return { onSnapshot: (s) => b.snaps.push(s), onChat: () => {}, onEvent: () => {}, tick: () => {} };
      },
    });
    h.send(h.host, { t: 'addBot' });
    h.start();
    const [r] = h.ruggers();
    const holders = h.holders();
    const bot = brains[0].id;
    const ghost = holders.find((id) => id !== bot)!;
    // Role reveal and the first snapshot are unfiltered; spread everyone out once playing.
    h.room.playerIds().forEach((id, i) => h.place(id, { x: 300 + i * 500, y: i % 2 ? 300 : 1300 }));
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.kill(r, ghost);
    h.place(r, { x: 2380, y: 140 });
    // A ghost still sees everyone, wherever they are.
    expect(h.snap(ghost).players.length).toBe(5);
    // A bot gets the same filtered view as a human.
    h.place(bot, { x: 300, y: 1300 });
    h.advance(50);
    const botSnap = brains[0].snaps.at(-1)!;
    expect(botSnap.phase).toBe('playing');
    expect(botSnap.players.map((p) => p.id)).toEqual([bot]);
    // Meetings send every card (positions are scrubbed for ghosts).
    const reporter = holders.find((id) => id !== ghost)!;
    const body = h.snap(reporter).bodies[0];
    h.place(reporter, { x: body.x + 30, y: body.y });
    h.send(reporter, { t: 'report', bodyId: body.id });
    expect(h.room.phase).toBe('meeting');
    expect(h.snap(reporter).players.length).toBe(5);
  });
});

describe('review fixes', () => {
  it('confirmEjects=false: the ejection view carries neither wasRugger nor ruggersLeft, for anyone', () => {
    const h = new Harness({ players: 7, settings: { ruggers: 2, discussionTime: 0, confirmEjects: false, emergencyMeetings: 2 } });
    h.start();
    const [r1] = h.ruggers();
    const [a] = h.holders();
    h.place(a, { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(a, { t: 'emergency' });
    for (const id of h.room.playerIds()) h.send(id, { t: 'vote', target: r1 });
    h.advance(MEETING_RESULTS_MS);
    expect(h.room.phase).toBe('ejection');
    for (const id of h.room.playerIds()) {
      const e = h.snap(id).ejection!;
      expect(e.ejectedId).toBe(r1);
      expect('ruggersLeft' in e).toBe(false);
      expect('wasRugger' in e).toBe(false);
    }
    // No-ejection results don't carry the count either.
    h.advance(EJECTION_MS);
    h.place(a, { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 85 });
    h.send(a, { t: 'emergency' });
    for (const id of h.room.playerIds()) if (h.p(id).alive) h.send(id, { t: 'vote', target: 'skip' });
    h.advance(MEETING_RESULTS_MS);
    expect(h.snap(a).ejection).toEqual({ ejectedId: null, tie: false });
  });

  it('the SPACES button can be pressed from every side of the Launchpad table', () => {
    const reach = 80 + PLAYER_RADIUS;
    const spots = [
      { x: EMERGENCY_BUTTON.x - reach, y: EMERGENCY_BUTTON.y },
      { x: EMERGENCY_BUTTON.x + reach, y: EMERGENCY_BUTTON.y },
      { x: 1200 - 10, y: 200 - 10 }, // table corner
    ];
    expect(EMERGENCY_RANGE).toBeGreaterThanOrEqual(Math.hypot(80 + 10, 60 + 10));
    for (const spot of spots) {
      expect(circleFree(spot.x, spot.y)).toBe(true);
      const h = new Harness({ players: 4 });
      h.start();
      const id = h.holders()[0];
      h.place(id, spot);
      h.send(id, { t: 'emergency' });
      expect(h.room.phase).toBe('meeting');
    }
  });

  it('meeting cards never give living players a ghost\'s live position', () => {
    const h = new Harness({ players: 6 });
    h.start();
    scatter(h);
    h.advance(POST_MEETING_COOLDOWN_MS);
    const [r] = h.ruggers();
    const [a, b] = h.holders();
    h.kill(r, a);
    h.place(a, at(10, 30)); // the ghost floats off
    const body = h.snap(b).bodies[0];
    h.place(b, { x: body.x + 30, y: body.y });
    h.send(b, { t: 'report', bodyId: a });
    expect(h.room.phase).toBe('meeting');
    const sp = SPAWN_POINTS[h.p(a).slot];
    for (const viewer of [b, r]) {
      const card = h.snap(viewer).players.find((p) => p.id === a)!;
      expect(card).toMatchObject({ alive: false, x: sp.x, y: sp.y, moving: false });
    }
    // Ghosts themselves keep the full view.
    expect(h.snap(a).players.find((p) => p.id === a)).toMatchObject({ x: at(10, 30).x, y: at(10, 30).y });
  });

  describe('DEV DUMP timer vs actions that arrive after endsAt but before the next tick', () => {
    function devDump() {
      const h = new Harness({ players: 6, settings: { tasksPerPlayer: 2 } });
      h.start();
      scatter(h);
      h.advance(POST_MEETING_COOLDOWN_MS);
      const [r] = h.ruggers();
      h.send(r, { t: 'sabotage', kind: 'devDump' });
      return { h, r, endsAt: h.snap(r).sabotage!.endsAt! };
    }

    it('a late report does not cancel the ruggers\' win', () => {
      const { h, r, endsAt } = devDump();
      const [a, b] = h.holders();
      h.kill(r, a);
      h.t = endsAt - 10;
      h.room.tick();
      h.t += 30;
      h.place(b, { x: h.p(a).x + 30, y: h.p(a).y });
      h.send(b, { t: 'report', bodyId: a });
      expect(h.room.phase).toBe('gameOver');
      expect(h.snap(b).gameOver).toMatchObject({ winner: 'ruggers', reason: 'devDump' });
    });

    it('late holds and a late last task do not count; holds made in time fix it at once', () => {
      const { h, endsAt } = devDump();
      const [a, b] = h.holders();
      h.place(a, sabotageStationById('dump_a')!);
      h.place(b, sabotageStationById('dump_b')!);
      h.t = endsAt - 10;
      h.room.tick();
      h.t += 30;
      h.send(a, { t: 'fix', stationId: 'dump_a', action: 'holdStart' });
      h.send(b, { t: 'fix', stationId: 'dump_b', action: 'holdStart' });
      expect(h.snap(a).gameOver).toMatchObject({ winner: 'ruggers', reason: 'devDump' });

      // In time: the second hold fixes it immediately, so the next tick past endsAt changes nothing.
      const g = devDump();
      const [c, d] = g.h.holders();
      g.h.place(c, sabotageStationById('dump_a')!);
      g.h.place(d, sabotageStationById('dump_b')!);
      g.h.t = g.endsAt - 20;
      g.h.send(c, { t: 'fix', stationId: 'dump_a', action: 'holdStart' });
      g.h.send(d, { t: 'fix', stationId: 'dump_b', action: 'holdStart' });
      expect(g.h.snap(c).sabotage).toBeNull();
      g.h.t = g.endsAt + 30;
      g.h.room.tick();
      expect(g.h.room.phase).toBe('playing');

      // The last task done after endsAt is too late.
      const t = devDump();
      const holders = t.h.holders();
      const last = { id: holders[0], st: t.h.p(holders[0]).tasks[1].stationId };
      for (const id of holders) for (const task of t.h.p(id).tasks) {
        if (id === last.id && task.stationId === last.st) continue;
        t.h.doTask(id, task.stationId);
      }
      expect(t.h.room.phase).toBe('playing');
      const st = stationById(last.st)!;
      t.h.place(last.id, st);
      t.h.send(last.id, { t: 'taskOpen', stationId: last.st });
      t.h.t = t.endsAt + 20;
      t.h.send(last.id, { t: 'taskDone', stationId: last.st });
      expect(t.h.snap(last.id).gameOver).toMatchObject({ winner: 'ruggers', reason: 'devDump' });
    });
  });

  it('a rejoining player gets the visible chat backlog: meeting and system for all, ghost chat for the dead only', () => {
    const h = new Harness({ players: 6, settings: { discussionTime: 30 } });
    h.send(h.ids[0], { t: 'chat', text: 'lobby gm' });
    h.start();
    scatter(h);
    h.advance(POST_MEETING_COOLDOWN_MS);
    const [r] = h.ruggers();
    const [victim, reporter, eve] = h.holders();
    h.kill(r, victim);
    h.send(victim, { t: 'chat', text: 'ghost before the meeting' });
    const body = h.snap(reporter).bodies[0];
    h.place(reporter, { x: body.x + 30, y: body.y });
    h.send(reporter, { t: 'report', bodyId: victim });
    h.t += CHAT_RATE_LIMIT_MS;
    h.send(reporter, { t: 'chat', text: 'before eve left' });
    h.room.setDisconnected(eve);
    h.clearOutbox();
    h.t += CHAT_RATE_LIMIT_MS;
    h.send(reporter, { t: 'chat', text: 'eve check this' });
    h.send(victim, { t: 'chat', text: 'ghost whisper' });
    expect(h.chats(eve)).toEqual([]); // an offline seat gets nothing live
    h.room.rejoin(eve, h.p(eve).sessionKey);
    h.room.sendChatBacklogTo(eve);
    const texts = h.chats(eve).map((c) => c.text);
    // A reloaded client starts empty: the earlier lines come back too (the client drops duplicates).
    expect(texts).toEqual(expect.arrayContaining(['before eve left', 'eve check this']));
    expect(texts.some((t) => t.startsWith('Game started'))).toBe(true);
    expect(texts.some((t) => t.includes('found a rugged bag'))).toBe(true);
    expect(texts).not.toContain('ghost whisper');
    expect(texts).not.toContain('ghost before the meeting');
    // The log was cleared at game start.
    expect(texts).not.toContain('lobby gm');
    // Same lines, same order and fields as sent live, so duplicates can be dropped by (ts, fromId, channel, text).
    const live = h.chats(reporter);
    h.clearOutbox();
    h.room.sendChatBacklogTo(reporter);
    const replay = h.chats(reporter);
    for (const m of live.filter((c) => c.channel !== 'ghost')) expect(replay).toContainEqual(m);
    // The dead get ghost lines as well.
    h.clearOutbox();
    h.room.sendChatBacklogTo(victim);
    expect(h.chats(victim).map((c) => c.text)).toEqual(expect.arrayContaining(['ghost before the meeting', 'ghost whisper', 'eve check this']));
  });

  it('the chat log keeps the last 100 lines and only lobby lines survive back to lobby', () => {
    const h = new Harness({ players: 4 });
    const [a, b] = h.ids;
    for (let i = 0; i < 120; i++) {
      h.t += CHAT_RATE_LIMIT_MS;
      h.send(i % 2 ? a : b, { t: 'chat', text: `line ${i}` });
    }
    h.clearOutbox();
    h.room.sendChatBacklogTo(a);
    const texts = h.chats(a).map((c) => c.text);
    expect(texts.length).toBe(100);
    expect(texts[0]).toBe('line 20');
    expect(texts.at(-1)).toBe('line 119');

    h.start();
    const [r] = h.ruggers();
    h.advance(POST_MEETING_COOLDOWN_MS);
    h.send(r, { t: 'sabotage', kind: 'devDump' });
    h.advance(DEV_DUMP_DURATION_MS);
    expect(h.room.phase).toBe('gameOver');
    h.t += CHAT_RATE_LIMIT_MS;
    h.send(a, { t: 'chat', text: 'gg' });
    h.send(h.host, { t: 'backToLobby' });
    expect(h.room.phase).toBe('lobby');
    h.clearOutbox();
    h.room.sendChatBacklogTo(b);
    expect(h.chats(b).map((c) => [c.channel, c.text])).toEqual([['lobby', 'gg']]);
    // A new player joining the lobby gets the lobby backlog, their own join line included.
    const c = h.room.addHuman({ name: 'late' });
    if (!c.ok) throw new Error(c.message);
    h.clearOutbox(); // (the live join line goes nowhere in production: the seat isn't bound yet)
    h.room.sendChatBacklogTo(c.player.id);
    expect(h.chats(c.player.id).map((m) => m.text)).toEqual(['gg', 'late joined']);
  });
});

describe('RoomManager room lookups', () => {
  class FakeConn implements Conn {
    binding: Conn['binding'] = null;
    lastJoinAt = -Infinity;
    msgs: S2C[] = [];
    constructor(readonly ip = 'test') {}
    send(m: S2C): void {
      this.msgs.push(m);
    }
    welcome() {
      return this.msgs.filter((m): m is Extract<S2C, { t: 'welcome' }> => m.t === 'welcome').at(-1);
    }
    lastError() {
      return this.msgs.filter((m): m is Extract<S2C, { t: 'error' }> => m.t === 'error').at(-1);
    }
  }

  function setup() {
    let t = 5_000_000;
    const mgr = new RoomManager({ now: () => t, log: () => {} });
    const conn = (ip?: string) => {
      const c = new FakeConn(ip);
      mgr.connect(c);
      return c;
    };
    const host = conn('host-ip');
    mgr.handleMessage(host, { t: 'create', name: 'host' });
    const w = host.welcome()!;
    mgr.handleMessage(host, { t: 'settings', settings: { isPublic: false } });
    return { mgr, conn, w, clock: (ms: number) => (t += ms) };
  }

  it('a failed rejoin looks the same whether or not the room exists', () => {
    const { mgr, conn, w } = setup();
    const atk = conn();
    const other = w.code === 'ZZZZ' ? 'ZZZY' : 'ZZZZ';
    mgr.handleMessage(atk, { t: 'rejoin', code: other, playerId: 'p_x', sessionKey: 'x' });
    const missing = atk.lastError()!;
    mgr.handleMessage(atk, { t: 'rejoin', code: w.code, playerId: 'p_x', sessionKey: 'x' });
    const existing = atk.lastError()!;
    mgr.handleMessage(atk, { t: 'rejoin', code: w.code, playerId: w.playerId, sessionKey: 'wrong' });
    const wrongKey = atk.lastError()!;
    expect(missing).toEqual({ t: 'error', code: 'REJOIN_FAILED', message: 'Could not restore your seat' });
    expect(existing).toEqual(missing);
    expect(wrongKey).toEqual(missing);
  });

  it('limits failed joins per IP to 30 a minute; a failed rejoin is always REJOIN_FAILED and never counts', () => {
    const { mgr, conn, w, clock } = setup();
    const socks = [conn(), conn(), conn()]; // several sockets from one IP share the budget
    // Stale sessions (e.g. after a deploy) must always hear REJOIN_FAILED so the client drops them.
    for (let i = 0; i < 50; i++) {
      const s = socks[i % socks.length];
      mgr.handleMessage(s, { t: 'rejoin', code: 'ZZZZ', playerId: 'p_x', sessionKey: 'x' });
      expect(s.lastError()!.code).toBe('REJOIN_FAILED');
    }
    for (let i = 0; i < 30; i++) {
      const s = socks[i % socks.length];
      clock(300); // past the per-socket join cooldown
      mgr.handleMessage(s, { t: 'join', code: 'ZZZZ', name: 'x' });
      expect(s.lastError()!.code).toBe('ROOM_NOT_FOUND');
    }
    const s = socks[0];
    clock(300);
    mgr.handleMessage(s, { t: 'join', code: 'ZZZY', name: 'x' });
    expect(s.lastError()!.code).toBe('RATE_LIMITED');
    // Blocked: a join to the real code gets the same answer, so join can't probe.
    clock(300);
    mgr.handleMessage(s, { t: 'join', code: w.code, name: 'intruder' });
    expect(s.lastError()!.code).toBe('RATE_LIMITED');
    expect(s.welcome()).toBeUndefined();
    // Rejoin still answers REJOIN_FAILED for a missing room and for the real one alike.
    mgr.handleMessage(s, { t: 'rejoin', code: 'ZZZZ', playerId: 'p_x', sessionKey: 'x' });
    const missing = s.lastError()!;
    mgr.handleMessage(s, { t: 'rejoin', code: w.code, playerId: w.playerId, sessionKey: 'wrong' });
    expect(s.lastError()).toEqual(missing);
    expect(missing).toEqual({ t: 'error', code: 'REJOIN_FAILED', message: 'Could not restore your seat' });
    // Another IP is unaffected; the block lifts after the window.
    const fresh = conn('other-ip');
    mgr.handleMessage(fresh, { t: 'join', code: 'ZZZZ', name: 'x' });
    expect(fresh.lastError()!.code).toBe('ROOM_NOT_FOUND');
    clock(60_000);
    mgr.handleMessage(s, { t: 'join', code: w.code, name: 'late' });
    expect(s.welcome()?.code).toBe(w.code);
  });

  it('welcome, then the chat backlog, then the snapshot: a reload mid-meeting gets the meeting chat back', () => {
    const { mgr, conn, w } = setup();
    const host = conn('host-ip');
    mgr.handleMessage(host, { t: 'rejoin', code: w.code, playerId: w.playerId, sessionKey: w.sessionKey });
    const room = mgr.getRoom(w.code)!;
    const eve = conn('eve-ip');
    mgr.handleMessage(eve, { t: 'join', code: w.code, name: 'eve' });
    const ew = eve.welcome()!;
    for (let i = 0; i < 2; i++) mgr.handleMessage(host, { t: 'addBot' });
    mgr.handleMessage(host, { t: 'chat', text: 'lobby line' });
    expect(eve.msgs.some((m) => m.t === 'chat' && m.text === 'lobby line')).toBe(true);
    // Eve reloads: a fresh socket rejoins and gets welcome, the backlog, then a snapshot.
    mgr.disconnect(eve);
    const eve2 = conn('eve-ip');
    mgr.handleMessage(eve2, { t: 'rejoin', code: w.code, playerId: ew.playerId, sessionKey: ew.sessionKey });
    const kinds = eve2.msgs.map((m) => m.t);
    expect(kinds[0]).toBe('welcome');
    expect(kinds.indexOf('snap')).toBeGreaterThan(kinds.lastIndexOf('chat'));
    const texts = eve2.msgs.flatMap((m) => (m.t === 'chat' ? [m.text] : []));
    expect(texts).toEqual(expect.arrayContaining(['host joined', 'eve joined', 'lobby line']));
    expect(room.phase).toBe('lobby');
    // A rejoin loop on the same socket gets welcome and snapshot again, but not the backlog again.
    eve2.msgs = [];
    for (let i = 0; i < 3; i++) mgr.handleMessage(eve2, { t: 'rejoin', code: w.code, playerId: ew.playerId, sessionKey: ew.sessionKey });
    expect(eve2.msgs.filter((m) => m.t === 'welcome').length).toBe(3);
    expect(eve2.msgs.filter((m) => m.t === 'chat').length).toBe(0);
    // The seat moving to another socket and back (another tab) replays it again.
    const tab = conn('eve-ip');
    mgr.handleMessage(tab, { t: 'rejoin', code: w.code, playerId: ew.playerId, sessionKey: ew.sessionKey });
    expect(tab.msgs.some((m) => m.t === 'chat' && m.text === 'lobby line')).toBe(true);
    eve2.msgs = [];
    mgr.handleMessage(eve2, { t: 'rejoin', code: w.code, playerId: ew.playerId, sessionKey: ew.sessionKey });
    expect(eve2.msgs.some((m) => m.t === 'chat' && m.text === 'lobby line')).toBe(true);
  });

  it('join failures count too, and a real seat key still rejoins from a blocked IP', () => {
    const { mgr, conn, w, clock } = setup();
    const atk = conn('shared-nat');
    for (let i = 0; i < 31; i++) {
      clock(300); // past the per-socket join cooldown
      mgr.handleMessage(atk, { t: 'join', code: 'ZZZZ', name: 'x' });
    }
    expect(atk.lastError()!.code).toBe('RATE_LIMITED');
    // The host reconnects from the same blocked network: the valid key works.
    const host2 = conn('shared-nat');
    mgr.handleMessage(host2, { t: 'rejoin', code: w.code, playerId: w.playerId, sessionKey: w.sessionKey });
    expect(host2.welcome()?.playerId).toBe(w.playerId);
  });
});
