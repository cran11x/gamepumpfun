import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotBrain, botName } from '../server/bots';
import {
  BASE_SPEED,
  CHAT_RATE_LIMIT_MS,
  DEFAULT_SETTINGS,
  EMERGENCY_RANGE,
  GHOST_SPEED_MULT,
  KILL_RANGE,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  PLAYER_RADIUS,
  REPORT_RANGE,
  USE_RANGE,
  VENT_RANGE,
  type GameSettings,
} from '../shared/constants';
import { circleFree, dist, type Vec } from '../shared/geometry';
import {
  EMERGENCY_BUTTON,
  SABOTAGE_STATIONS,
  SPAWN_POINTS,
  TASK_MIN_MS,
  TASK_STATIONS,
  sabotageStationById,
  stationById,
  ventById,
} from '../shared/map';
import type {
  BodyView,
  C2S,
  ChatMessage,
  GameEvent,
  MeetingView,
  MeView,
  Phase,
  PlayerView,
  SabotageView,
  Snapshot,
  TaskAssignment,
} from '../shared/protocol';

const TICK_MS = 50;
const T0 = 1_700_000_000_000;
const BOT_ID = 'bot1';

// ---------- A tiny fake room that validates every message like the real server would ----------

interface PlayerSpec {
  id: string;
  name?: string;
  color?: number;
  x: number;
  y: number;
  alive?: boolean;
  isRugger?: boolean;
}

interface SimInit {
  role: 'holder' | 'rugger';
  pos: Vec;
  alive?: boolean;
  tasks?: TaskAssignment[];
  others?: PlayerSpec[];
  phase?: Phase;
  bodies?: BodyView[];
  meeting?: MeetingView;
  phaseEndsAt?: number;
  sabotage?: SabotageView | null;
  settings?: Partial<GameSettings>;
  killReadyAt?: number;
  sabotageReadyAt?: number;
  emergencyLeft?: number;
  seed?: number;
  name?: string;
}

type Sent = { at: number; msg: C2S };
type MsgOf<T extends C2S['t']> = Extract<C2S, { t: T }> & { at: number };

function tasks(...ids: string[]): TaskAssignment[] {
  return ids.map((id) => {
    const st = stationById(id);
    if (!st) throw new Error(`unknown station ${id}`);
    return { stationId: id, kind: st.kind, done: false };
  });
}

function view(p: PlayerSpec, i: number): PlayerView {
  return {
    id: p.id,
    name: p.name ?? p.id,
    color: p.color ?? i + 1,
    x: p.x,
    y: p.y,
    facing: 1,
    moving: false,
    alive: p.alive ?? true,
    isBot: false,
    ...(p.isRugger ? { isRugger: true } : {}),
  };
}

/** Mirrors the server's own sweep check (half-radius circle every 4 px). */
function sweepClear(a: Vec, b: Vec): boolean {
  const len = dist(a, b);
  const steps = Math.ceil(len / 4);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!circleFree(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, PLAYER_RADIUS / 2)) return false;
  }
  return true;
}

class Sim {
  now = T0;
  readonly sent: Sent[] = [];
  readonly problems: string[] = [];
  readonly snap: Snapshot;
  readonly bot: BotBrain;
  private readonly inbox: ({ chat: ChatMessage } | { event: GameEvent })[] = [];
  private lastAcceptedMoveAt = T0;
  private lastMoveMsgAt = -Infinity;
  /** Capped time since the last move message: the bot's own speed guarantee. */
  private budgetMs = 0;
  private openedAt = 0;
  private lastChatAt = -Infinity;
  private readonly holds = new Map<string, Set<string>>();

  constructor(init: SimInit) {
    const settings: GameSettings = { ...DEFAULT_SETTINGS, ...init.settings };
    const alive = init.alive ?? true;
    const me: MeView = {
      id: BOT_ID,
      role: init.role,
      alive,
      x: init.pos.x,
      y: init.pos.y,
      teleportSeq: 1,
      tasks: init.tasks ?? [],
      activeStationId: null,
      emergencyLeft: init.emergencyLeft ?? 1,
      ...(init.role === 'rugger'
        ? { killReadyAt: init.killReadyAt ?? T0 + 60_000, sabotageReadyAt: init.sabotageReadyAt ?? T0 + 600_000, ventId: null }
        : {}),
    };
    const self: PlayerSpec = { id: BOT_ID, name: init.name ?? 'anon_bot', color: 0, x: init.pos.x, y: init.pos.y, alive, isRugger: init.role === 'rugger' };
    this.snap = {
      t: 'snap',
      now: T0,
      phase: init.phase ?? 'playing',
      ...(init.phaseEndsAt !== undefined ? { phaseEndsAt: init.phaseEndsAt } : {}),
      room: { code: 'TEST', hostId: 'p_host', settings, ticker: '$RUGS' },
      players: [self, ...(init.others ?? [])].map(view),
      bodies: init.bodies ?? [],
      taskProgress: 0,
      sabotage: init.sabotage ?? null,
      me,
      ...(init.meeting ? { meeting: init.meeting } : {}),
    };
    if (init.sabotage?.kind === 'devDump') for (const s of init.sabotage.stations) this.holds.set(s.id, new Set());
    this.bot = new BotBrain({ id: BOT_ID, seed: init.seed ?? 1, send: (m) => this.receive(m) });
  }

  get me(): MeView {
    const me = this.snap.me;
    if (!me) throw new Error('no me');
    return me;
  }

  get pos(): Vec {
    return { x: this.me.x, y: this.me.y };
  }

  playerById(id: string): PlayerView | undefined {
    return this.snap.players.find((p) => p.id === id);
  }

  movePlayer(id: string, x: number, y: number): void {
    const p = this.playerById(id);
    if (!p) throw new Error(`no player ${id}`);
    p.x = x;
    p.y = y;
  }

  chat(fromId: string, text: string, channel: ChatMessage['channel'] = 'meeting'): void {
    const from = this.playerById(fromId);
    this.inbox.push({ chat: { t: 'chat', channel, fromId, fromName: from?.name ?? fromId, color: from?.color ?? 0, text, ts: this.now } });
  }

  event(event: GameEvent): void {
    this.inbox.push({ event });
  }

  /** Server-side teleport (meeting start, rejected move, vents). */
  teleport(x: number, y: number): void {
    this.me.x = x;
    this.me.y = y;
    this.me.teleportSeq++;
    this.lastAcceptedMoveAt = this.now;
  }

  step(ms = TICK_MS): void {
    this.now += ms;
    this.budgetMs += Math.min(ms, 100);
    this.snap.now = this.now;
    // Same order as the room: queued chat/events, then the snapshot, then tick.
    for (const item of this.inbox.splice(0)) {
      if ('chat' in item) this.bot.onChat(item.chat);
      else this.bot.onEvent(item.event);
    }
    this.syncHolds();
    this.bot.onSnapshot(structuredClone(this.snap));
    this.bot.tick(this.now);
  }

  run(ms: number, stepMs = TICK_MS): void {
    const end = this.now + ms;
    while (this.now < end) this.step(stepMs);
  }

  /** Runs until `pred` holds; returns whether it did within `maxMs`. */
  runUntil(pred: () => boolean, maxMs: number, stepMs = TICK_MS): boolean {
    const end = this.now + maxMs;
    while (this.now < end) {
      this.step(stepMs);
      if (pred()) return true;
    }
    return false;
  }

  messages<T extends C2S['t']>(t: T): MsgOf<T>[] {
    return this.sent.filter((s) => s.msg.t === t).map((s) => ({ ...(s.msg as Extract<C2S, { t: T }>), at: s.at }));
  }

  private syncHolds(): void {
    const sab = this.snap.sabotage;
    if (!sab || sab.kind !== 'devDump') return;
    for (const s of sab.stations) s.holders = this.holds.get(s.id)?.size ?? 0;
  }

  private problem(text: string): void {
    this.problems.push(`${this.now - T0}ms: ${text}`);
  }

  private receive(msg: C2S): void {
    this.sent.push({ at: this.now, msg });
    const me = this.me;
    const playing = this.snap.phase === 'playing';
    switch (msg.t) {
      case 'move': {
        if (!playing) return this.problem('move outside playing');
        if (me.ventId) return this.problem('move while in a bridge');
        if (this.now - this.lastMoveMsgAt < 40) this.problem(`moves ${this.now - this.lastMoveMsgAt}ms apart`);
        this.lastMoveMsgAt = this.now;
        const speed = BASE_SPEED * this.snap.room.settings.playerSpeed * (me.alive ? 1 : GHOST_SPEED_MULT);
        const d = dist(this.pos, msg);
        const budget = (speed * this.budgetMs) / 1000 + 1e-6;
        this.budgetMs = 0;
        if (d > budget) this.problem(`moved ${d.toFixed(2)}px with a budget of ${budget.toFixed(2)}px`);
        const dt = Math.min(1000, Math.max(50, this.now - this.lastAcceptedMoveAt)) / 1000;
        if (d > speed * dt * 1.5 + 24) return this.problem('server speed clamp would reject');
        if (me.alive && (!circleFree(msg.x, msg.y) || !sweepClear(this.pos, msg))) return this.problem('move into a wall');
        me.x = msg.x;
        me.y = msg.y;
        const self = this.playerById(BOT_ID);
        if (self) {
          self.x = msg.x;
          self.y = msg.y;
          self.facing = msg.facing;
          self.moving = msg.moving;
        }
        this.lastAcceptedMoveAt = this.now;
        return;
      }
      case 'taskOpen': {
        const task = me.tasks.find((t) => t.stationId === msg.stationId);
        const st = stationById(msg.stationId);
        if (!playing || !task || task.done || !st || me.ventId) return this.problem(`bad taskOpen ${msg.stationId}`);
        if (dist(this.pos, st) > USE_RANGE) return this.problem('taskOpen out of range');
        me.activeStationId = st.id;
        this.openedAt = this.now;
        return;
      }
      case 'taskClose':
        me.activeStationId = null;
        return;
      case 'taskDone': {
        const st = stationById(msg.stationId);
        const task = me.tasks.find((t) => t.stationId === msg.stationId);
        if (!st || !task || me.activeStationId !== msg.stationId) return this.problem('taskDone without an open task');
        if (this.now - this.openedAt < TASK_MIN_MS[st.kind]) return this.problem('taskDone too fast');
        if (dist(this.pos, st) > USE_RANGE * 1.5) return this.problem('taskDone too far');
        me.activeStationId = null;
        if (me.role === 'holder') {
          task.done = true;
          this.event({ kind: 'taskCompleted', stationId: st.id });
        }
        return;
      }
      case 'report': {
        const body = this.snap.bodies.find((b) => b.id === msg.bodyId);
        if (!playing || !me.alive || !body) return this.problem('bad report');
        if (dist(this.pos, body) > REPORT_RANGE) return this.problem('report out of range');
        return;
      }
      case 'emergency':
        if (!playing || !me.alive || me.emergencyLeft <= 0) return this.problem('bad emergency');
        if (dist(this.pos, EMERGENCY_BUTTON) > EMERGENCY_RANGE) return this.problem('emergency out of range');
        return;
      case 'kill': {
        const target = this.playerById(msg.targetId);
        if (!playing || me.role !== 'rugger' || !me.alive || me.ventId) return this.problem('bad kill');
        if (me.killReadyAt === undefined || this.now < me.killReadyAt) return this.problem('kill on cooldown');
        if (!target || !target.alive || target.isRugger) return this.problem('kill on invalid target');
        if (dist(this.pos, target) > KILL_RANGE) return this.problem('kill out of range');
        this.snap.players = this.snap.players.filter((p) => p.id !== target.id);
        this.snap.bodies.push({ id: target.id, color: target.color, x: target.x, y: target.y });
        me.killReadyAt = this.now + this.snap.room.settings.killCooldown * 1000;
        this.event({ kind: 'rugged', victimId: target.id, killerId: BOT_ID });
        return;
      }
      case 'vent': {
        if (!playing || me.role !== 'rugger' || !me.alive) return this.problem('bad vent');
        if (msg.action === 'enter') {
          const v = ventById(msg.ventId);
          if (me.ventId || !v || dist(this.pos, v) > VENT_RANGE) return this.problem('bad vent enter');
          me.ventId = v.id;
          me.activeStationId = null;
          this.teleport(v.x, v.y);
        } else if (msg.action === 'move') {
          const cur = me.ventId ? ventById(me.ventId) : undefined;
          const next = ventById(msg.ventId);
          if (!cur || !next || !cur.links.includes(next.id)) return this.problem('bad vent move');
          me.ventId = next.id;
          this.teleport(next.x, next.y);
        } else {
          if (!me.ventId) return this.problem('vent exit while not in a bridge');
          me.ventId = null;
          this.lastAcceptedMoveAt = this.now;
        }
        return;
      }
      case 'sabotage':
        if (!playing || me.role !== 'rugger' || this.snap.sabotage) return this.problem('bad sabotage');
        if (me.sabotageReadyAt === undefined || this.now < me.sabotageReadyAt) return this.problem('sabotage on cooldown');
        return;
      case 'fix': {
        const st = sabotageStationById(msg.stationId);
        const sab = this.snap.sabotage;
        if (!playing || !st || !sab || st.sabotage !== sab.kind) return this.problem('bad fix');
        if (msg.action === 'holdStart') {
          if (!me.alive || dist(this.pos, st) > USE_RANGE) return this.problem('holdStart out of range');
          for (const set of this.holds.values()) set.delete(BOT_ID);
          this.holds.get(st.id)?.add(BOT_ID);
        } else if (msg.action === 'holdEnd') {
          this.holds.get(st.id)?.delete(BOT_ID);
        } else if (dist(this.pos, st) > USE_RANGE * 1.5) {
          return this.problem('fix done out of range');
        }
        return;
      }
      case 'vote': {
        const m = this.snap.meeting;
        if (this.snap.phase !== 'meeting' || !m || m.stage !== 'voting' || !me.alive) return this.problem('vote outside voting');
        if (m.myVote !== undefined) return this.problem('voted twice');
        if (msg.target !== 'skip' && !this.snap.players.some((p) => p.id === msg.target && p.alive)) return this.problem('vote for a non-living player');
        if (msg.target === BOT_ID) this.problem('voted for itself');
        m.myVote = msg.target;
        m.votedIds = [...m.votedIds, BOT_ID];
        return;
      }
      case 'chat': {
        const ok = this.snap.phase === 'meeting' || ((this.snap.phase === 'playing' || this.snap.phase === 'ejection') && !me.alive);
        if (!ok) return this.problem(`chat not allowed now: "${msg.text}"`);
        if (this.now - this.lastChatAt < CHAT_RATE_LIMIT_MS) this.problem('chat rate limited');
        if (msg.text.length === 0 || msg.text.length > MAX_CHAT_LENGTH) this.problem('bad chat length');
        this.lastChatAt = this.now;
        return;
      }
      default:
        return this.problem(`unexpected message ${msg.t}`);
    }
  }
}

/** Long enough for any bot to have cast its vote after voting opens. */
const VOTE_WAIT_MS = 17000;

function meetingView(stage: MeetingView['stage'], extra: Partial<MeetingView> = {}): MeetingView {
  return { callerId: 'p2', reason: 'emergency', stage, votedIds: [], ...extra };
}

// Launchpad floor spots with clear line of sight between them (south of the SPACES table).
const LP_A = { x: 1040, y: 400 };
const LP_B = { x: 1080, y: 400 };
const LP_C = { x: 1200, y: 400 };
const TRADING_FLOOR = { x: 300, y: 300 };

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  // A bot swallows its own exceptions so it can't crash a room; in tests they must not happen.
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

// ---------- Movement ----------

describe('BotBrain movement', () => {
  it('moves toward a task without exceeding the speed limit', () => {
    const station = stationById('lp_snipe')!;
    const sim = new Sim({ role: 'holder', pos: SPAWN_POINTS[0], tasks: tasks('lp_snipe') });
    const start = dist(sim.pos, station);
    sim.run(1000);
    expect(sim.messages('move').length).toBeGreaterThanOrEqual(15);
    expect(dist(sim.pos, station)).toBeLessThan(start - 80);
    expect(sim.runUntil(() => sim.messages('taskOpen').length > 0, 6000)).toBe(true);
    expect(dist(sim.pos, station)).toBeLessThanOrEqual(USE_RANGE);
    expect(sim.problems).toEqual([]);
  });

  it('caps each step under irregular tick timing and never sends moves closer than 40 ms', () => {
    const sim = new Sim({ role: 'holder', pos: SPAWN_POINTS[3], tasks: tasks('burn_lp'), settings: { playerSpeed: 2 } });
    const gaps = [50, 50, 700, 50, 20, 20, 20, 20, 70, 130, 45, 55, 300, 10, 10, 80];
    for (let i = 0; i < 400; i++) sim.step(gaps[i % gaps.length]);
    const moves = sim.messages('move');
    expect(moves.length).toBeGreaterThan(50);
    for (let i = 1; i < moves.length; i++) expect(moves[i].at - moves[i - 1].at).toBeGreaterThanOrEqual(40);
    expect(sim.problems).toEqual([]);
  });

  it('sends a move on every tick when the 20 Hz timer jitters (no skipped ticks, no stutter)', () => {
    const sim = new Sim({ role: 'holder', pos: SPAWN_POINTS[3], tasks: tasks('burn_lp') });
    const gaps = [49, 51, 48, 52, 50];
    sim.step(50);
    const first = sim.messages('move').length;
    for (let i = 0; i < 40; i++) sim.step(gaps[i % gaps.length]);
    // Walking the whole time toward a far station: one move per tick.
    expect(sim.messages('move').length - first).toBe(40);
    expect(sim.problems).toEqual([]);
  });

  it('reaches every task station on the map', () => {
    for (const [i, station] of TASK_STATIONS.entries()) {
      const sim = new Sim({ role: 'holder', pos: SPAWN_POINTS[i % SPAWN_POINTS.length], tasks: tasks(station.id), seed: i + 1 });
      const ok = sim.runUntil(() => sim.messages('taskOpen').length > 0, 25000);
      expect(ok, `never opened ${station.id}`).toBe(true);
      expect(sim.problems, station.id).toEqual([]);
    }
  });

  it('ghosts move at ghost speed and keep doing tasks', () => {
    const sim = new Sim({ role: 'holder', alive: false, pos: SPAWN_POINTS[5], tasks: tasks('pool_add_e') });
    expect(sim.runUntil(() => sim.me.tasks[0].done, 15000)).toBe(true);
    expect(sim.problems).toEqual([]);
  });

  it('re-syncs to the server position when teleportSeq changes', () => {
    const sim = new Sim({ role: 'holder', pos: SPAWN_POINTS[0], tasks: tasks('ml_shill') });
    sim.run(1000);
    const spot = SPAWN_POINTS[6];
    const teleportedAt = sim.now;
    sim.teleport(spot.x, spot.y);
    sim.run(500);
    const after = sim.messages('move').filter((m) => m.at > teleportedAt);
    expect(after.length).toBeGreaterThan(0);
    // The first move continues from the snapped position (one 50 ms step at most).
    expect(dist(after[0], spot)).toBeLessThanOrEqual((BASE_SPEED * TICK_MS) / 1000 + 0.5);
    expect(sim.problems).toEqual([]);
  });
});

// ---------- Tasks ----------

describe('BotBrain tasks', () => {
  it('opens and completes a task after the min time', () => {
    const station = stationById('rpc_sync')!;
    const sim = new Sim({ role: 'holder', pos: station, tasks: tasks('rpc_sync') });
    sim.run(200);
    const opens = sim.messages('taskOpen');
    expect(opens).toHaveLength(1);
    const minMs = TASK_MIN_MS[station.kind];
    sim.run(minMs + 3500);
    const dones = sim.messages('taskDone');
    expect(dones).toHaveLength(1);
    const took = dones[0].at - opens[0].at;
    expect(took).toBeGreaterThanOrEqual(minMs + 1000);
    expect(took).toBeLessThanOrEqual(minMs + 3000 + TICK_MS);
    expect(sim.me.tasks[0].done).toBe(true);
    expect(sim.problems).toEqual([]);
  });

  it('re-opens a task that got interrupted', () => {
    const station = stationById('tf_verify')!;
    const sim = new Sim({ role: 'holder', pos: station, tasks: tasks('tf_verify') });
    sim.run(1000);
    expect(sim.messages('taskOpen')).toHaveLength(1);
    sim.me.activeStationId = null; // the server closed it
    sim.run(1500);
    const opens = sim.messages('taskOpen');
    expect(opens).toHaveLength(2);
    sim.run(TASK_MIN_MS[station.kind] + 3500);
    const dones = sim.messages('taskDone');
    expect(dones).toHaveLength(1);
    expect(dones[0].at - opens[1].at).toBeGreaterThanOrEqual(TASK_MIN_MS[station.kind] + 1000);
    expect(sim.me.tasks[0].done).toBe(true);
    expect(sim.problems).toEqual([]);
  });

  it('does every assigned task, nearest first', () => {
    const sim = new Sim({ role: 'holder', pos: SPAWN_POINTS[0], tasks: tasks('tg_bots', 'lp_socials', 'lp_snipe') });
    expect(sim.runUntil(() => sim.me.tasks.every((t) => t.done), 60000)).toBe(true);
    const order = sim.messages('taskDone').map((m) => m.stationId);
    expect(order[order.length - 1]).toBe('tg_bots');
    expect(sim.problems).toEqual([]);
  });
});

// ---------- Bodies ----------

describe('BotBrain reports', () => {
  it('reports a visible body after a human reaction delay', () => {
    const station = stationById('lp_snipe')!;
    const sim = new Sim({ role: 'holder', pos: station, tasks: tasks('lp_snipe'), others: [{ id: 'p2', x: 1500, y: 150 }] });
    sim.run(300);
    const appearedAt = sim.now;
    sim.snap.bodies.push({ id: 'p9', color: 3, x: station.x + 60, y: station.y });
    expect(sim.runUntil(() => sim.messages('report').length > 0, 3000)).toBe(true);
    const report = sim.messages('report')[0];
    expect(report.bodyId).toBe('p9');
    expect(report.at - appearedAt).toBeGreaterThanOrEqual(500);
    expect(report.at - appearedAt).toBeLessThanOrEqual(2000 + 2 * TICK_MS);
    expect(sim.problems).toEqual([]);
  });

  it('walks over to a body it sees across the room before reporting', () => {
    const sim = new Sim({ role: 'holder', pos: LP_A, tasks: tasks('lp_snipe') });
    sim.run(200);
    sim.snap.bodies.push({ id: 'p9', color: 3, x: LP_A.x + 220, y: LP_A.y });
    expect(sim.runUntil(() => sim.messages('report').length > 0, 6000)).toBe(true);
    expect(sim.problems).toEqual([]);
  });

  it('does not see bodies through walls', () => {
    const station = stationById('rpc_sync')!; // RPC Node; the body is in the Trading Floor, 290 px away
    const sim = new Sim({ role: 'holder', pos: station, tasks: tasks('rpc_sync') });
    sim.run(200);
    sim.snap.bodies.push({ id: 'p9', color: 3, x: 460, y: 420 });
    sim.run(4000);
    expect(sim.messages('report')).toHaveLength(0);
    expect(sim.problems).toEqual([]);
  });

  it('does not see far bodies during FUD', () => {
    const sim = new Sim({
      role: 'holder',
      pos: LP_A,
      tasks: tasks('lp_snipe'),
      sabotage: { kind: 'fud', stations: [{ id: 'fud_fix', fixed: false }] },
      seed: 7,
    });
    sim.snap.bodies.push({ id: 'p9', color: 3, x: LP_A.x + 220, y: LP_A.y });
    sim.run(300);
    expect(sim.messages('report')).toHaveLength(0);
  });
});

// ---------- Rugger ----------

describe('BotBrain rugger', () => {
  const ruggerInit = (extra: Partial<SimInit> = {}): SimInit => ({
    role: 'rugger',
    pos: LP_A,
    tasks: tasks('ml_shill', 'tg_bots', 'kol_shill'),
    killReadyAt: T0 - 10000,
    others: [
      { id: 'h1', name: 'alice', x: LP_B.x, y: LP_B.y },
      { id: 'h2', name: 'bob', x: LP_C.x, y: LP_C.y },
    ],
    ...extra,
  });

  it("doesn't rug while a witness can see, and rugs once the target is isolated", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const sim = new Sim(ruggerInit({ seed }));
      sim.run(3000);
      expect(sim.messages('kill'), `seed ${seed}`).toHaveLength(0);
      // The witness walks off to another room.
      sim.movePlayer('h2', TRADING_FLOOR.x, TRADING_FLOOR.y);
      const goneAt = sim.now;
      expect(sim.runUntil(() => sim.messages('kill').length > 0, 5000), `seed ${seed}`).toBe(true);
      const kill = sim.messages('kill')[0];
      expect(kill.targetId).toBe('h1');
      expect(kill.at).toBeGreaterThan(goneAt);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
  });

  it('waits for the kill cooldown', () => {
    const sim = new Sim(ruggerInit({ killReadyAt: T0 + 1500, others: [{ id: 'h1', name: 'alice', x: LP_B.x, y: LP_B.y }] }));
    sim.run(1400);
    expect(sim.messages('kill')).toHaveLength(0);
    expect(sim.runUntil(() => sim.messages('kill').length > 0, 1500)).toBe(true);
    expect(sim.messages('kill')[0].at).toBeGreaterThanOrEqual(T0 + 1500);
    expect(sim.problems).toEqual([]);
  });

  it('never rugs a fellow rugger', () => {
    const sim = new Sim(ruggerInit({ others: [{ id: 'r2', name: 'carl', x: LP_B.x, y: LP_B.y, isRugger: true }] }));
    sim.run(4000);
    expect(sim.messages('kill')).toHaveLength(0);
    expect(sim.problems).toEqual([]);
  });

  it('gets away after a rug (bridge or walking off)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new Sim(ruggerInit({ seed, others: [{ id: 'h1', name: 'alice', x: LP_B.x, y: LP_B.y }] }));
      expect(sim.runUntil(() => sim.messages('kill').length > 0, 2000)).toBe(true);
      sim.run(8000);
      const usedVent = sim.messages('vent').some((m) => m.action === 'enter');
      const walkedOff = dist(sim.pos, LP_B) > 200;
      expect(usedVent || walkedOff, `seed ${seed}`).toBe(true);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
      if (usedVent) {
        sim.run(10000);
        expect(sim.me.ventId, `seed ${seed} stuck in a bridge`).toBeNull();
      }
    }
  });

  it('fakes tasks: opens and closes its fake stations without ever sending taskDone', () => {
    const sim = new Sim(ruggerInit({ others: [], killReadyAt: T0 + 600_000 }));
    sim.run(40000);
    expect(sim.messages('taskOpen').length).toBeGreaterThan(0);
    expect(sim.messages('taskClose').length).toBeGreaterThan(0);
    expect(sim.messages('taskDone')).toHaveLength(0);
    expect(sim.problems).toEqual([]);
  });

  it('sabotages once the cooldown is ready, only while none is active', () => {
    const sim = new Sim(ruggerInit({ others: [], killReadyAt: T0 + 600_000, sabotageReadyAt: T0 + 1000 }));
    expect(sim.runUntil(() => sim.messages('sabotage').length > 0, 120000)).toBe(true);
    expect(sim.messages('sabotage')[0].at).toBeGreaterThanOrEqual(T0 + 1000);
    expect(sim.problems).toEqual([]);
  });

  it('holds off after a fellow rugger rugs, so the team never rugs all at once', () => {
    for (let seed = 1; seed <= 5; seed++) {
      // 'r2' sorts after this bot, so this bot has the first turn of the round.
      const sim = new Sim(
        ruggerInit({
          seed,
          killReadyAt: T0 + 500,
          others: [{ id: 'h1', name: 'alice', x: LP_B.x, y: LP_B.y }, { id: 'r2', name: 'carl', x: TRADING_FLOOR.x, y: TRADING_FLOOR.y, isRugger: true }],
        }),
      );
      sim.run(100);
      sim.event({ kind: 'rugged', victimId: 'hx', killerId: 'r2' });
      const heardAt = sim.now;
      expect(sim.runUntil(() => sim.messages('kill').length > 0, 30000), `seed ${seed}`).toBe(true);
      expect(sim.messages('kill')[0].at - heardAt, `seed ${seed}`).toBeGreaterThanOrEqual(15000);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
  });

  it('takes turns at round start: a later rugger waits even with a lone holder in reach', () => {
    for (let seed = 1; seed <= 5; seed++) {
      // 'a0' sorts before this bot, so this bot goes second.
      const sim = new Sim(
        ruggerInit({
          seed,
          killReadyAt: T0 + 1000,
          others: [{ id: 'h1', name: 'alice', x: LP_B.x, y: LP_B.y }, { id: 'a0', name: 'carl', x: TRADING_FLOOR.x, y: TRADING_FLOOR.y, isRugger: true }],
        }),
      );
      expect(sim.runUntil(() => sim.messages('kill').length > 0, 30000), `seed ${seed}`).toBe(true);
      expect(sim.messages('kill')[0].at - (T0 + 1000), `seed ${seed}`).toBeGreaterThanOrEqual(7000);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
    // Alone, the rugger is up first.
    const solo = new Sim(ruggerInit({ killReadyAt: T0 + 1000, others: [{ id: 'h1', name: 'alice', x: LP_B.x, y: LP_B.y }] }));
    expect(solo.runUntil(() => solo.messages('kill').length > 0, 3000)).toBe(true);
  });

  it('keeps after a holder who walks out of view (the server stops sending them)', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const sim = new Sim(ruggerInit({ seed, others: [{ id: 'h1', name: 'alice', x: LP_C.x, y: LP_C.y }] }));
      sim.run(300);
      // Interest management: out of view simply means not listed. They are still alive.
      sim.snap.players = sim.snap.players.filter((p) => p.id !== 'h1');
      let closest = Infinity;
      for (let i = 0; i < 160; i++) {
        sim.step();
        closest = Math.min(closest, dist(sim.pos, LP_C));
      }
      expect(closest, `seed ${seed}`).toBeLessThanOrEqual(45);
      expect(sim.messages('kill'), `seed ${seed}`).toHaveLength(0);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
  });
});

// ---------- Sabotage fixing ----------

describe('BotBrain sabotage response', () => {
  it('holds the nearer BUY WALL during a DEV DUMP', () => {
    const sim = new Sim({
      role: 'holder',
      pos: SPAWN_POINTS[0],
      tasks: tasks('lp_snipe'),
      sabotage: { kind: 'devDump', endsAt: T0 + 40000, stations: [{ id: 'dump_a', fixed: false, holders: 0 }, { id: 'dump_b', fixed: false, holders: 0 }] },
    });
    expect(sim.runUntil(() => sim.messages('fix').some((m) => m.action === 'holdStart'), 20000)).toBe(true);
    const hold = sim.messages('fix').find((m) => m.action === 'holdStart')!;
    expect(['dump_a', 'dump_b']).toContain(hold.stationId);
    // Keeps holding (no release, no wandering off) until fixed.
    const at = { ...sim.pos };
    sim.run(3000);
    expect(sim.messages('fix').filter((m) => m.action === 'holdEnd')).toHaveLength(0);
    expect(dist(sim.pos, at)).toBeLessThan(1);
    expect(sim.problems).toEqual([]);
  });

  it('sometimes goes to fix FUD and sends fix done at the console', () => {
    let fixed = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new Sim({
        role: 'holder',
        pos: SPAWN_POINTS[2],
        tasks: [],
        sabotage: { kind: 'fud', stations: [{ id: 'fud_fix', fixed: false }] },
        seed,
      });
      if (sim.runUntil(() => sim.messages('fix').some((m) => m.action === 'done'), 30000)) fixed++;
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
    expect(fixed).toBeGreaterThan(0);
    expect(SABOTAGE_STATIONS.some((s) => s.id === 'fud_fix')).toBe(true);
  });
});

// ---------- Meetings ----------

describe('BotBrain meetings', () => {
  const others: PlayerSpec[] = [
    { id: 'p2', name: 'alice', x: SPAWN_POINTS[1].x, y: SPAWN_POINTS[1].y },
    { id: 'p3', name: 'bob', x: SPAWN_POINTS[2].x, y: SPAWN_POINTS[2].y },
    { id: 'p4', name: 'carol', x: SPAWN_POINTS[3].x, y: SPAWN_POINTS[3].y },
  ];
  // Seven at the table: far from a must-win vote, so only the evidence decides.
  const table: PlayerSpec[] = [
    ...others,
    { id: 'p5', name: 'dave', x: SPAWN_POINTS[4].x, y: SPAWN_POINTS[4].y },
    { id: 'p6', name: 'erin', x: SPAWN_POINTS[5].x, y: SPAWN_POINTS[5].y },
    { id: 'p7', name: 'frank', x: SPAWN_POINTS[6].x, y: SPAWN_POINTS[6].y },
  ];

  it('votes skip with no info', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const sim = new Sim({
        role: 'holder',
        phase: 'meeting',
        meeting: meetingView('voting'),
        phaseEndsAt: T0 + 60000,
        pos: SPAWN_POINTS[0],
        others,
        seed,
      });
      sim.run(VOTE_WAIT_MS);
      const votes = sim.messages('vote');
      expect(votes, `seed ${seed}`).toHaveLength(1);
      expect(votes[0].target).toBe('skip');
      expect(votes[0].at - T0).toBeGreaterThanOrEqual(3000);
      expect(votes[0].at - T0).toBeLessThanOrEqual(16000 + 2 * TICK_MS);
      expect(sim.messages('chat').length).toBeLessThanOrEqual(2);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
  });

  it('does not vote during discussion', () => {
    const sim = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('discussion'), phaseEndsAt: T0 + 30000, pos: SPAWN_POINTS[0], others });
    sim.run(15000);
    expect(sim.messages('vote')).toHaveLength(0);
    expect(sim.problems).toEqual([]);
  });

  it('never votes for a fellow rugger, even when the crowd accuses them', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const sim = new Sim({
        role: 'rugger',
        phase: 'meeting',
        meeting: meetingView('voting'),
        phaseEndsAt: T0 + 60000,
        pos: SPAWN_POINTS[0],
        others: [...others, { id: 'r2', name: 'dev_dave', x: SPAWN_POINTS[4].x, y: SPAWN_POINTS[4].y, isRugger: true }],
        seed,
      });
      sim.chat('p2', 'dev_dave is sus');
      sim.chat('p3', 'vote dev_dave, saw him vent');
      sim.chat('p4', 'dev_dave rugged');
      sim.run(VOTE_WAIT_MS);
      const votes = sim.messages('vote');
      expect(votes).toHaveLength(1);
      expect(votes[0].target).not.toBe('r2');
      expect(votes[0].target).not.toBe(BOT_ID);
      expect(sim.problems).toEqual([]);
    }
  });

  it('a rugger votes with the crowd against a holder', () => {
    const sim = new Sim({
      role: 'rugger',
      phase: 'meeting',
      meeting: meetingView('voting'),
      phaseEndsAt: T0 + 60000,
      pos: SPAWN_POINTS[0],
      others: [...others, { id: 'r2', name: 'dev_dave', x: SPAWN_POINTS[4].x, y: SPAWN_POINTS[4].y, isRugger: true }],
    });
    sim.chat('p3', 'alice is sus');
    sim.chat('p4', 'its alice, vote her');
    sim.run(VOTE_WAIT_MS);
    expect(sim.messages('vote').map((v) => v.target)).toEqual(['p2']);
  });

  it('a holder follows corroborated claims, but not a bare accusation, its echoes or a vouched player', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const crowd = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('voting'), phaseEndsAt: T0 + 60000, pos: SPAWN_POINTS[0], others: table, seed });
      crowd.chat('p2', 'carol rugged in Meme Lab, I saw it');
      crowd.chat('p3', 'saw carol right by the body in the Meme Lab, sus');
      crowd.run(VOTE_WAIT_MS);
      expect(crowd.messages('vote').map((v) => v.target), `seed ${seed}`).toEqual(['p4']);

      // "yeah X is sus" agrees with an accusation; it is not a second source.
      const echoed = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('voting'), phaseEndsAt: T0 + 60000, pos: SPAWN_POINTS[0], others: table, seed });
      echoed.chat('p2', 'carol is sus');
      echoed.chat('p3', 'yeah carol is sus');
      echoed.chat('p5', 'agree, carol');
      echoed.run(VOTE_WAIT_MS);
      expect(echoed.messages('vote').map((v) => v.target), `seed ${seed}`).toEqual(['skip']);

      const vouched = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('voting'), phaseEndsAt: T0 + 60000, pos: SPAWN_POINTS[0], others: table, seed });
      vouched.chat('p2', 'carol is sus');
      vouched.chat('p3', 'nah carol is not sus, she was with me');
      vouched.run(VOTE_WAIT_MS);
      expect(vouched.messages('vote').map((v) => v.target), `seed ${seed}`).toEqual(['skip']);
    }
  });

  it('a witness reports, accuses the rugger by name in the meeting and votes them', () => {
    const others2: PlayerSpec[] = [
      { id: 'k', name: 'KOL_Kevin', x: LP_B.x + 40, y: LP_B.y },
      { id: 'v', name: 'victim', x: LP_C.x - 40, y: LP_C.y },
      { id: 'p3', name: 'bob', x: TRADING_FLOOR.x, y: TRADING_FLOOR.y },
    ];
    for (let seed = 1; seed <= 5; seed++) {
      const sim = new Sim({ role: 'holder', pos: LP_A, tasks: tasks('lp_snipe'), others: others2.map((p) => ({ ...p })), seed });
      sim.run(400);
      // The rug happens in plain sight: the victim turns into a body next to the killer.
      const victim = sim.playerById('v')!;
      sim.snap.players = sim.snap.players.filter((p) => p.id !== 'v');
      sim.snap.bodies.push({ id: 'v', color: victim.color, x: victim.x, y: victim.y });
      const called = sim.runUntil(() => sim.messages('report').length + sim.messages('emergency').length > 0, 15000);
      expect(called, `seed ${seed}`).toBe(true);

      // Meeting: bodies cleared, everyone teleported to spawn.
      sim.snap.phase = 'meeting';
      sim.snap.bodies = [];
      sim.snap.meeting = meetingView('discussion', { callerId: BOT_ID, reason: 'report', bodyColor: victim.color });
      sim.snap.phaseEndsAt = sim.now + 30000;
      sim.teleport(SPAWN_POINTS[0].x, SPAWN_POINTS[0].y);
      sim.run(20000);
      const lines = sim.messages('chat').map((c) => c.text);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(lines[0]).toBe('KOL_Kevin rugged in Launchpad, I saw it');

      sim.snap.meeting = meetingView('voting', { callerId: BOT_ID, reason: 'report', bodyColor: victim.color });
      sim.snap.phaseEndsAt = sim.now + 60000;
      sim.event({ kind: 'votingOpened' });
      sim.run(VOTE_WAIT_MS);
      expect(sim.messages('vote').map((v) => v.target)).toEqual(['k']);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
  });

  it('a holder that sees someone use a bridge calls them out and votes them', () => {
    const vent = ventById('v_launch')!;
    for (let seed = 1; seed <= 5; seed++) {
      const sim = new Sim({
        role: 'holder',
        pos: LP_A,
        tasks: tasks('lp_snipe'),
        others: [
          { id: 'r', name: 'cabal_carl', x: vent.x + 10, y: vent.y + 10 },
          { id: 'p3', name: 'bob', x: TRADING_FLOOR.x, y: TRADING_FLOOR.y },
        ],
        seed,
      });
      sim.run(300);
      // Non-ruggers stop receiving a rugger the moment they enter a bridge.
      sim.snap.players = sim.snap.players.filter((p) => p.id !== 'r');
      sim.run(3000);
      sim.snap.players.push(view({ id: 'r', name: 'cabal_carl', x: SPAWN_POINTS[4].x, y: SPAWN_POINTS[4].y }, 5));
      sim.snap.phase = 'meeting';
      sim.snap.meeting = meetingView('discussion');
      sim.snap.phaseEndsAt = sim.now + 30000;
      sim.teleport(SPAWN_POINTS[0].x, SPAWN_POINTS[0].y);
      sim.run(20000);
      expect(sim.messages('chat').map((c) => c.text)[0], `seed ${seed}`).toBe('cabal_carl vented in the Launchpad, I saw it');
      sim.snap.meeting = meetingView('voting');
      sim.snap.phaseEndsAt = sim.now + 60000;
      sim.run(VOTE_WAIT_MS);
      expect(sim.messages('vote').map((v) => v.target), `seed ${seed}`).toEqual(['r']);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
  });

  it('someone who just comes into view near a bridge did not use it', () => {
    const vent = ventById('v_launch')!;
    for (let seed = 1; seed <= 5; seed++) {
      const sim = new Sim({ role: 'holder', pos: LP_A, tasks: tasks('lp_snipe'), others: [{ id: 'p3', name: 'bob', x: TRADING_FLOOR.x, y: TRADING_FLOOR.y }], seed });
      sim.run(300);
      // With interest management a player walking in around a corner shows up out of nowhere too.
      sim.snap.players.push(view({ id: 'w', name: 'cabal_carl', x: vent.x + 40, y: vent.y }, 5));
      sim.run(3000);
      sim.snap.phase = 'meeting';
      sim.snap.meeting = meetingView('discussion');
      sim.snap.phaseEndsAt = sim.now + 30000;
      sim.teleport(SPAWN_POINTS[0].x, SPAWN_POINTS[0].y);
      sim.run(20000);
      for (const c of sim.messages('chat')) expect(c.text, `seed ${seed}`).not.toMatch(/vented/);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
  });

  it('a holder that found someone standing by a body says so and votes them', () => {
    const far = (id: string, name: string, i: number): PlayerSpec => ({ id, name, x: TRADING_FLOOR.x + 40 * i, y: TRADING_FLOOR.y });
    let voted = 0;
    let named = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const sim = new Sim({
        role: 'holder',
        pos: LP_A,
        tasks: tasks('lp_snipe'),
        // Bodies listed from the start are not fresh: we didn't watch the rug, we found them by it.
        bodies: [{ id: 'v', color: 9, x: LP_C.x, y: LP_C.y }],
        others: [{ id: 'k', name: 'KOL_Kevin', x: LP_C.x + 40, y: LP_C.y }, far('p3', 'bob', 0), far('p4', 'carol', 1), far('p5', 'dave', 2), { id: 'v', name: 'victim', color: 9, x: LP_C.x, y: LP_C.y, alive: false }],
        seed,
      });
      // A living viewer never receives the ghost itself.
      sim.snap.players = sim.snap.players.filter((p) => p.id !== 'v');
      expect(sim.runUntil(() => sim.messages('report').length > 0, 15000), `seed ${seed}`).toBe(true);
      sim.snap.phase = 'meeting';
      sim.snap.bodies = [];
      sim.snap.players.push(view({ id: 'v', name: 'victim', color: 9, x: SPAWN_POINTS[9].x, y: SPAWN_POINTS[9].y, alive: false }, 9));
      sim.snap.meeting = meetingView('discussion', { callerId: BOT_ID, reason: 'report', bodyColor: 9 });
      sim.snap.phaseEndsAt = sim.now + 30000;
      sim.teleport(SPAWN_POINTS[0].x, SPAWN_POINTS[0].y);
      sim.run(20000);
      const lines = sim.messages('chat').map((c) => c.text);
      expect(lines[0], `seed ${seed}`).toMatch(/^(body in the|found a rugged bag in the) Launchpad$/);
      if (lines.some((t) => t.includes('KOL_Kevin') && /by the body|near the body/.test(t))) named++;
      sim.snap.meeting = meetingView('voting', { callerId: BOT_ID, reason: 'report', bodyColor: 9 });
      sim.snap.phaseEndsAt = sim.now + 60000;
      sim.run(VOTE_WAIT_MS);
      const votes = sim.messages('vote').map((v) => v.target);
      expect(votes, `seed ${seed}`).toHaveLength(1);
      expect(['k', 'skip'], `seed ${seed}`).toContain(votes[0]);
      if (votes[0] === 'k') voted++;
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
    expect(voted).toBeGreaterThanOrEqual(8);
    expect(named).toBeGreaterThanOrEqual(5);
  });

  it("doesn't ask where the body was once the reporter said it, and doesn't repeat lines", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const meeting = meetingView('discussion', { callerId: 'p2', reason: 'report', bodyColor: 9 });
      const sim = new Sim({ role: 'holder', phase: 'meeting', meeting, phaseEndsAt: T0 + 30000, pos: SPAWN_POINTS[0], others, seed });
      sim.chat('p2', 'body in the Trading Floor');
      sim.chat('p3', 'dev is sus fr');
      sim.chat('p4', 'ngmi');
      sim.run(30000);
      for (const c of sim.messages('chat')) {
        expect(c.text, `seed ${seed}`).not.toMatch(/where was the body|who found it/);
        expect(['dev is sus fr', 'ngmi', 'body in the Trading Floor'], `seed ${seed}`).not.toContain(c.text);
      }
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
    // The bot that found the body never asks either.
    for (let seed = 1; seed <= 30; seed++) {
      const meeting = meetingView('discussion', { callerId: BOT_ID, reason: 'report', bodyColor: 9 });
      const sim = new Sim({ role: 'holder', phase: 'meeting', meeting, phaseEndsAt: T0 + 30000, pos: SPAWN_POINTS[0], others, seed });
      sim.run(30000);
      for (const c of sim.messages('chat')) expect(c.text, `seed ${seed}`).not.toMatch(/where was the body|who found it/);
    }
  });

  it('votes are spread out over the voting stage, not all in the same second', () => {
    const times: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const sim = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('voting'), phaseEndsAt: T0 + 60000, pos: SPAWN_POINTS[0], others: table, seed });
      sim.run(VOTE_WAIT_MS);
      times.push(sim.messages('vote')[0].at - T0);
    }
    times.sort((a, b) => a - b);
    expect(times[times.length - 1] - times[0]).toBeGreaterThan(8000);
    // No single second holds more than a quarter of the votes.
    for (const t of times) expect(times.filter((u) => u >= t && u < t + 1000).length).toBeLessThanOrEqual(5);
  });

  it('when one more rug loses the game, a holder picks someone instead of skipping and follows the table', () => {
    const three = [others[0], others[1]];
    for (let seed = 1; seed <= 10; seed++) {
      const sim = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('discussion'), phaseEndsAt: T0 + 30000, pos: SPAWN_POINTS[0], others: three, seed });
      sim.run(30000);
      const said = sim.messages('chat').map((c) => c.text);
      sim.snap.meeting = meetingView('voting');
      sim.snap.phaseEndsAt = sim.now + 60000;
      sim.run(VOTE_WAIT_MS);
      const [vote] = sim.messages('vote').map((v) => v.target);
      expect(['p2', 'p3'], `seed ${seed}`).toContain(vote);
      // It says who it is voting for, so the holders don't split.
      const name = vote === 'p2' ? 'alice' : 'bob';
      expect(said.some((t) => /vot/.test(t) && t.includes(name)), `seed ${seed}: ${said.join(' | ')}`).toBe(true);

      const follow = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('voting'), phaseEndsAt: T0 + 60000, pos: SPAWN_POINTS[0], others: three, seed });
      follow.chat('p2', 'voting bob, no skip this time');
      follow.run(VOTE_WAIT_MS);
      expect(follow.messages('vote').map((v) => v.target), `seed ${seed}`).toEqual(['p3']);
    }
    // With the curve about to finish, skipping is still fine.
    const done = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('voting'), phaseEndsAt: T0 + 60000, pos: SPAWN_POINTS[0], others: three });
    done.snap.taskProgress = 0.95;
    done.run(VOTE_WAIT_MS);
    expect(done.messages('vote').map((v) => v.target)).toEqual(['skip']);
  });

  it('weighs a lone eyewitness claim: some follow it, fewer once it is denied, and none when the room is wrong', () => {
    const followRate = (setup: (sim: Sim) => void, reason: 'emergency' | 'report' = 'emergency') => {
      let followed = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const meeting = meetingView('voting', reason === 'report' ? { reason, callerId: 'p2', bodyColor: 9 } : {});
        const sim = new Sim({ role: 'holder', phase: 'meeting', meeting, phaseEndsAt: T0 + 60000, pos: SPAWN_POINTS[0], others: table, seed });
        setup(sim);
        sim.run(VOTE_WAIT_MS);
        const votes = sim.messages('vote').map((v) => v.target);
        expect(votes).toHaveLength(1);
        if (votes[0] === 'p4') followed++;
        expect(sim.problems, `seed ${seed}`).toEqual([]);
      }
      return followed / 40;
    };
    const lone = followRate((sim) => sim.chat('p3', 'carol rugged in Meme Lab, I saw it'));
    expect(lone).toBeGreaterThan(0.1);
    expect(lone).toBeLessThan(0.7);
    const denied = followRate((sim) => {
      sim.chat('p3', 'carol rugged in Meme Lab, I saw it');
      sim.chat('p4', 'not me, I was in the Burn Room');
    });
    expect(denied).toBeLessThan(lone);
    // The reporter said the body was in the Trading Floor: one of the two is wrong, so the claim is doubted.
    const wrongRoom = followRate((sim) => {
      sim.chat('p2', 'body in the Trading Floor');
      sim.chat('p3', 'carol rugged in Meme Lab, I saw it');
    }, 'report');
    expect(wrongRoom).toBe(0);

    for (let seed = 1; seed <= 5; seed++) {
      const sim = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('voting'), phaseEndsAt: T0 + 60000, pos: SPAWN_POINTS[0], others, seed, name: 'sniper.sol' });
      sim.chat('p2', 'sniper.sol rugged in the Burn Room, I saw it');
      sim.run(VOTE_WAIT_MS);
      expect(sim.messages('vote').map((v) => v.target), `seed ${seed}`).toEqual(['p2']);
    }
  });

  // ---------- Where the body was: claims vs the reporter's word vs what the bot saw ----------

  const victim: PlayerSpec = { id: 'v', name: 'victim', color: 9, x: SPAWN_POINTS[7].x, y: SPAWN_POINTS[7].y, alive: false };
  // Inside the Meme Lab, and in the hallway between the Launchpad (110 px north) and the Liquidity
  // Pool (50 px south, so the body is labeled Liquidity Pool).
  const SEEN_IN_MEME_LAB = { body: { x: 2160, y: 300 }, bot: { x: 2080, y: 300 } };
  const SEEN_IN_HALLWAY = { body: { x: 1300, y: 590 }, bot: { x: 1240, y: 560 } };

  /** The bot's votes over 40 seeds in a meeting where p2 (alice) reported the victim's body. */
  const reportVotes = (setup: (sim: Sim) => void, opts: { seen?: { body: Vec; bot: Vec }; extraDead?: PlayerSpec[] } = {}) => {
    const tally: Record<string, number> = {};
    for (let seed = 1; seed <= 40; seed++) {
      let sim: Sim;
      if (opts.seen) {
        // The bot walks past the body first (already there, so not a rug it watched); everyone else is far away.
        const away = table.map((o, i) => ({ ...o, x: TRADING_FLOOR.x + 30 * i, y: TRADING_FLOOR.y + 60 }));
        sim = new Sim({ role: 'holder', pos: opts.seen.bot, tasks: tasks('lp_snipe'), others: away, bodies: [{ id: 'v', color: 9, ...opts.seen.body }], seed });
        sim.run(300);
        sim.snap.phase = 'meeting';
        sim.snap.bodies = [];
        for (const o of table) sim.movePlayer(o.id, o.x, o.y);
        sim.teleport(SPAWN_POINTS[0].x, SPAWN_POINTS[0].y);
        sim.snap.players.push(view(victim, 9), ...(opts.extraDead ?? []).map(view));
      } else {
        sim = new Sim({ role: 'holder', phase: 'meeting', pos: SPAWN_POINTS[0], others: [...table, victim, ...(opts.extraDead ?? [])], seed });
      }
      sim.snap.meeting = meetingView('discussion', { reason: 'report', callerId: 'p2', bodyColor: 9 });
      sim.snap.phaseEndsAt = sim.now + 30000;
      setup(sim);
      sim.run(20000);
      sim.snap.meeting = meetingView('voting', { reason: 'report', callerId: 'p2', bodyColor: 9 });
      sim.snap.phaseEndsAt = sim.now + 60000;
      sim.run(VOTE_WAIT_MS);
      const votes = sim.messages('vote').map((v) => v.target);
      expect(votes, `seed ${seed}`).toHaveLength(1);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
      tally[votes[0]] = (tally[votes[0]] ?? 0) + 1;
    }
    return tally;
  };

  it('reads the room a claim is tied to ("rugged in X", "body in the X"), not any other room in the line', () => {
    const control = reportVotes((sim) => {
      sim.chat('p2', 'body in the Meme Lab');
      sim.chat('p3', 'carol rugged in the Meme Lab, I saw it');
    });
    expect(control.p4 ?? 0).toBeGreaterThan(5);
    expect(control.p3 ?? 0).toBe(0);
    // An honest eyewitness who also says where the rugger went is still an honest eyewitness.
    const ranOff = reportVotes((sim) => {
      sim.chat('p2', 'body in the Meme Lab');
      sim.chat('p3', 'carol rugged in the Meme Lab, I saw it, then she ran to the Trading Floor');
    });
    expect(ranOff).toEqual(control);
    const reporterRanOff = reportVotes((sim) => {
      sim.chat('p2', 'body in Meme Lab, I came from the Trading Floor');
      sim.chat('p3', 'carol rugged in the Meme Lab, I saw it');
    });
    expect(reporterRanOff).toEqual(control);
    // "by the body in the X" is the room of a near-body claim.
    const near = reportVotes((sim) => {
      sim.chat('p2', 'body in the Meme Lab');
      sim.chat('p3', 'saw carol right by the body in the Meme Lab, then she went to the Trading Floor, sus');
    });
    expect(near.p4 ?? 0).toBeGreaterThan(3);
  });

  it("takes the reporter's room as their word only: a claim that contradicts it makes neither a liar", () => {
    // Either the reporter or the eyewitness is wrong (a rugger self-reporting with a fake room, or a
    // rugger framing someone): the bot doubts both a little and votes out neither.
    for (const accused of ['alice', 'carol']) {
      const t = reportVotes((sim) => {
        sim.chat('p2', 'body in the Trading Floor');
        sim.chat('p3', `${accused} rugged in Meme Lab, I saw it`);
      });
      expect(t, accused).toEqual({ skip: 40 });
    }
    // Neighboring rooms: the body may lie in the hallway between them. Doubted, but nobody lied.
    const neighbor = reportVotes((sim) => {
      sim.chat('p2', 'body in the Launchpad');
      sim.chat('p3', 'carol rugged in the Liquidity Pool, I saw it');
    });
    expect(neighbor.p3 ?? 0).toBe(0);
    expect(neighbor.p2 ?? 0).toBe(0);
  });

  it('trusts its own sighting of the body: catches a lying reporter or eyewitness, and allows for hallway bodies', () => {
    // A rugger self-reports with a fake room; the true eyewitness names the reporter.
    const lyingReporter = reportVotes((sim) => {
      sim.chat('p2', 'body in the Trading Floor');
      sim.chat('p3', 'alice rugged in Meme Lab, I saw it');
    }, { seen: SEEN_IN_MEME_LAB });
    expect(lyingReporter.p2 ?? 0).toBeGreaterThan(25);
    expect(lyingReporter.p3 ?? 0).toBe(0);
    // The reporter's word doesn't outweigh what the bot saw.
    const trueWitness = reportVotes((sim) => {
      sim.chat('p2', 'body in the Trading Floor');
      sim.chat('p3', 'carol rugged in Meme Lab, I saw it');
    }, { seen: SEEN_IN_MEME_LAB });
    expect(trueWitness.p4 ?? 0).toBeGreaterThan(5);
    expect(trueWitness.p3 ?? 0).toBe(0);
    // An eyewitness claim about a room the body was nowhere near is a lie.
    const lyingWitness = reportVotes((sim) => {
      sim.chat('p2', 'body in the Meme Lab');
      sim.chat('p3', 'carol rugged in Trading Floor, I saw it');
    }, { seen: SEEN_IN_MEME_LAB });
    expect(lyingWitness.p3 ?? 0).toBeGreaterThan(10);
    expect(lyingWitness.p4 ?? 0).toBe(0);
    // A hallway body fits both rooms next to it.
    const labeled = reportVotes((sim) => {
      sim.chat('p2', 'body in the Liquidity Pool');
      sim.chat('p3', 'carol rugged in the Liquidity Pool, I saw it');
    }, { seen: SEEN_IN_HALLWAY });
    const adjacent = reportVotes((sim) => {
      sim.chat('p2', 'body in the Liquidity Pool');
      sim.chat('p3', 'carol rugged in the Launchpad, I saw it');
    }, { seen: SEEN_IN_HALLWAY });
    expect(labeled.p4 ?? 0).toBeGreaterThan(5);
    expect(adjacent).toEqual(labeled);
  });

  it('a claim that may be about another body (a second death this round, or an earlier body) is no lie', () => {
    const wendy: PlayerSpec = { id: 'w', name: 'wendy', color: 8, x: SPAWN_POINTS[8].x, y: SPAWN_POINTS[8].y, alive: false };
    // Wendy's body was never reported: the claim may be about her, so it is doubted, not a lie,
    // even against what the bot saw itself.
    for (const seen of [undefined, SEEN_IN_MEME_LAB]) {
      const twoDead = reportVotes((sim) => {
        sim.chat('p2', seen ? 'body in the Meme Lab' : 'body in the Trading Floor');
        sim.chat('p3', `carol rugged in ${seen ? 'Trading Floor' : 'Meme Lab'}, I saw it`);
      }, { seen, extraDead: [wendy] });
      expect(twoDead.p3 ?? 0).toBe(0);
      expect(twoDead.p2 ?? 0).toBe(0);
    }

    // The Meme Lab body was reported in the meeting before; now wendy's body is in the Trading Floor.
    let followed = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const sim = new Sim({ role: 'holder', phase: 'meeting', pos: SPAWN_POINTS[0], others: [...table, victim, { ...wendy, alive: true }], seed });
      sim.snap.meeting = meetingView('discussion', { reason: 'report', callerId: 'p2', bodyColor: 9 });
      sim.snap.phaseEndsAt = sim.now + 30000;
      sim.chat('p2', 'body in the Meme Lab');
      sim.run(20000);
      sim.snap.phase = 'playing';
      delete sim.snap.meeting;
      delete sim.snap.phaseEndsAt;
      // Everyone else is out of sight this round, so nobody has an alibi or was seen elsewhere.
      sim.snap.players = sim.snap.players.filter((p) => p.alive);
      table.forEach((o, i) => sim.movePlayer(o.id, TRADING_FLOOR.x + 30 * i, TRADING_FLOOR.y + 60));
      sim.movePlayer('w', TRADING_FLOOR.x, TRADING_FLOOR.y);
      sim.run(2000);
      for (const o of table) sim.movePlayer(o.id, o.x, o.y);
      sim.snap.phase = 'meeting';
      sim.snap.players.push(view(victim, 9));
      const w = sim.playerById('w');
      if (w) w.alive = false;
      sim.teleport(SPAWN_POINTS[0].x, SPAWN_POINTS[0].y);
      sim.snap.meeting = meetingView('discussion', { reason: 'report', callerId: 'p2', bodyColor: 8 });
      sim.snap.phaseEndsAt = sim.now + 30000;
      sim.chat('p2', 'body in the Trading Floor');
      sim.chat('p3', 'carol rugged in Meme Lab, I saw it');
      sim.run(20000);
      sim.snap.meeting = meetingView('voting', { reason: 'report', callerId: 'p2', bodyColor: 8 });
      sim.snap.phaseEndsAt = sim.now + 60000;
      sim.run(VOTE_WAIT_MS);
      const votes = sim.messages('vote').map((v) => v.target);
      expect(votes, `seed ${seed}`).toHaveLength(1);
      expect(votes[0], `seed ${seed}`).not.toBe('p3');
      if (votes[0] === 'p4') followed++;
      expect(sim.problems, `seed ${seed}`).toEqual([]);
    }
    expect(followed).toBeGreaterThan(0);
  });

  it('ghosts banter rarely, and only where ghosts may talk', () => {
    let total = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new Sim({ role: 'holder', pos: LP_A, tasks: tasks('lp_snipe', 'ml_shill', 'tg_bots'), others: [{ id: 'r', name: 'rugpull_rick', x: LP_B.x, y: LP_B.y }], seed });
      sim.run(1000);
      expect(sim.messages('chat')).toHaveLength(0);
      // Rugged: the bot becomes a ghost where it stands.
      sim.me.alive = false;
      sim.playerById(BOT_ID)!.alive = false;
      sim.snap.bodies.push({ id: BOT_ID, color: 0, x: sim.me.x, y: sim.me.y });
      sim.event({ kind: 'rugged', victimId: BOT_ID, killerId: 'r' });
      sim.run(180000, 100);
      const chats = sim.messages('chat');
      expect(chats.length, `seed ${seed}`).toBeLessThanOrEqual(4);
      for (let i = 1; i < chats.length; i++) expect(chats[i].at - chats[i - 1].at).toBeGreaterThanOrEqual(CHAT_RATE_LIMIT_MS);
      expect(sim.me.tasks.every((t) => t.done), `seed ${seed} ghost kept doing tasks`).toBe(true);
      expect(sim.problems, `seed ${seed}`).toEqual([]);
      total += chats.length;
    }
    expect(total).toBeGreaterThan(0);
  });

  it('posts 0-2 short trench lines per meeting, spaced past the chat rate limit', () => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const sim = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('discussion'), phaseEndsAt: T0 + 30000, pos: SPAWN_POINTS[0], others, seed });
      sim.run(30000);
      const chats = sim.messages('chat');
      expect(chats.length).toBeLessThanOrEqual(2);
      for (let i = 1; i < chats.length; i++) expect(chats[i].at - chats[i - 1].at).toBeGreaterThanOrEqual(CHAT_RATE_LIMIT_MS);
      for (const c of chats) expect(c.text).not.toMatch(/jeet/i);
      total += chats.length;
      expect(sim.problems).toEqual([]);
    }
    expect(total).toBeGreaterThan(0);
  });

  it('defends itself when accused', () => {
    let defended = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const sim = new Sim({ role: 'holder', phase: 'meeting', meeting: meetingView('discussion'), phaseEndsAt: T0 + 30000, pos: SPAWN_POINTS[0], others, seed, name: 'sniper.sol' });
      sim.run(100);
      sim.chat('p2', 'sniper.sol is sus');
      sim.run(10000);
      if (sim.messages('chat').some((c) => /not me|trust me|wasn't me|why me/i.test(c.text))) defended++;
    }
    expect(defended).toBeGreaterThan(0);
  });

  it('living bots never chat while playing', () => {
    const sim = new Sim({ role: 'holder', pos: SPAWN_POINTS[0], tasks: tasks('lp_snipe', 'tf_swap'), others });
    sim.run(30000);
    expect(sim.messages('chat')).toHaveLength(0);
    expect(sim.problems).toEqual([]);
  });
});

// ---------- Determinism and names ----------

describe('BotBrain determinism', () => {
  it('the same seed produces the same messages', () => {
    const runOnce = () => {
      const sim = new Sim({ role: 'rugger', pos: LP_A, tasks: tasks('ml_shill', 'tg_bots'), killReadyAt: T0 + 3000, others: [{ id: 'h1', x: LP_C.x, y: LP_C.y }], seed: 42 });
      sim.run(15000);
      return JSON.stringify(sim.sent);
    };
    expect(runOnce()).toBe(runOnce());
  });
});

describe('botName', () => {
  it('returns fun, unique names that fit the name limit', () => {
    const names = Array.from({ length: 200 }, (_, i) => botName(i));
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n.length).toBeGreaterThan(0);
      expect(n.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    }
    expect(botName(0)).toBe('anon_bot');
    expect(names).toContain('sniper.sol');
    expect(names).toContain('KOL_Kevin');
  });

  it('handles odd indexes', () => {
    expect(botName(-3)).toBe(botName(0));
    expect(botName(Number.NaN)).toBe(botName(0));
    expect(botName(2.7)).toBe(botName(2));
  });
});
