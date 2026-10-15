// Authoritative game state machine for one room ("Room").
//
// No sockets in here: the RoomManager (or a unit test) injects a clock, an rng and a `send`
// function, then feeds client messages through `handle()` and calls `tick()` at SERVER_TICK_HZ.
// Bots are ordinary internal players whose messages come from a BotBrain instead of a socket.
// Rules follow docs/SPEC.md "Rules (server-authoritative)", "Snapshot visibility" and "Snapshots".

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BASE_SPEED,
  BASE_VISION,
  CHAT_RATE_LIMIT_MS,
  DEFAULT_SETTINGS,
  DEFAULT_TICKER,
  DEV_DUMP_DURATION_MS,
  EJECTION_MS,
  EMERGENCY_RANGE,
  FUD_VISION_MULT,
  GHOST_SPEED_MULT,
  KILL_RANGE,
  MAX_PLAYERS,
  MEETING_RESULTS_MS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  PLAYER_RADIUS,
  POST_MEETING_COOLDOWN_MS,
  RECONNECT_GRACE_MS,
  REPORT_RANGE,
  ROLE_REVEAL_MS,
  SABOTAGE_COOLDOWN_MS,
  USE_RANGE,
  VENT_RANGE,
  maxRuggersFor,
  type GameSettings,
} from '../shared/constants';
import { COSMETIC_SLOTS, isCosmeticForSlot } from '../shared/cosmetics';
import { circleFree, dist, lineOfSight, moveWithCollision, type Vec } from '../shared/geometry';
import {
  EMERGENCY_BUTTON,
  SABOTAGE_STATIONS,
  SPAWN_POINTS,
  TASK_MIN_MS,
  TASK_STATIONS,
  WORLD_H,
  WORLD_W,
  sabotageStationById,
  stationById,
  ventById,
} from '../shared/map';
import {
  shortAddress,
  type BodyView,
  type C2S,
  type ChatChannel,
  type ChatMessage,
  type EjectionView,
  type EquippedCosmetics,
  type ErrorCode,
  type GameEvent,
  type GameOverReason,
  type GameOverView,
  type MeView,
  type MeetingReason,
  type MeetingView,
  type Phase,
  type PlayerView,
  type Role,
  type S2C,
  type SabotageKind,
  type SabotageView,
  type Snapshot,
  type TaskAssignment,
  type Winner,
} from '../shared/protocol';
import { sample, shuffle } from './game/rng';
import { clampSettings, normalizeSettings, sanitizeChat, sanitizeName } from './game/sanitize';
import { SKIP, tallyVotes } from './game/tally';
import { parseC2S } from './game/validate';

// ---------- Tuning that is server-internal (the shared numbers live in shared/constants.ts) ----------

/** Moves that arrive faster than this after the previous one are ignored. */
const MOVE_MIN_INTERVAL_MS = 25;
/**
 * Movement budget (a token bucket in px): it refills at `speed * MOVE_SPEED_TOLERANCE` per second,
 * holds at most MOVE_BUDGET_WINDOW_MS worth of that plus MOVE_SLACK_PX, and every accepted move spends
 * the distance it covers. Sustained speed is capped at 1.5x however often moves are sent, while a
 * client that stalled for up to a second can still catch up in one message.
 */
const MOVE_BUDGET_WINDOW_MS = 1000;
const MOVE_SPEED_TOLERANCE = 1.5;
const MOVE_SLACK_PX = 24;
/**
 * After a teleport, a rejoin or a pause in play the budget restarts at this much refill time plus the
 * slack, so the first step after a round restart fits at any speed (a ghost at playerSpeed 2 covers
 * 25 px in one 50 ms tick).
 */
const MOVE_RESET_WINDOW_MS = 150;
/**
 * Anti wall-jump: besides `circleFree` at the destination (SPEC), the straight segment between the
 * last accepted position and the new one must stay clear for a circle of half the player radius.
 * Legit sliding around a convex corner keeps that chord >= ~9.9 px from the corner, so 7 px never
 * rejects honest movement, while a hop through any solid tile always fails.
 */
const SWEEP_RADIUS = PLAYER_RADIUS / 2;
const SWEEP_STEP_PX = 4;
/** A player that stops sending moves is shown standing still after this long. */
const MOVING_TIMEOUT_MS = 300;
/** Outside `playing`, snapshots go out on change and at least this often. */
const IDLE_SNAPSHOT_MS = 500;
/**
 * Interest management while playing: a living viewer only receives another player within its vision
 * radius plus this margin (covers position lag and the client's smoothed fog), and in line of sight.
 */
const INTEREST_MARGIN_PX = 120;
/** FUD shrinks holders' interest radius only after this long, while the client's fog closes in. */
const FUD_INTEREST_DELAY_MS = 500;
/**
 * The client draws from its predicted position, which leads the server's copy of the viewer by about
 * 2x one-way latency + 50..150 ms. Line of sight is therefore also tested from points this far ahead
 * along the viewer's recent velocity (walked with collision, as the client would), which covers up to
 * ~100 ms one-way latency...
 */
const INTEREST_LOOKAHEAD_MS: readonly number[] = [120, 240, 360];
/** ...and from four probes this far around it, cut short by walls so they never see through one. */
export const INTEREST_PROBE_PX = 64;
/**
 * Once sent, a player keeps being sent until this long after it last qualified, so nobody flickers.
 * Short, because a modified client can read everyone it is sent, around corners included.
 */
export const INTEREST_HOLD_MS = 300;
/** The viewer's velocity is measured over its accepted moves of about this long (capped at its speed). */
const VELOCITY_WINDOW_MS = 200;
/** Chat lines kept per room and replayed (by visibility) to a player who joins or rejoins. */
const CHAT_LOG_MAX = 100;
/** Color index used for system chat lines that are not about a specific player (Gold Bag). */
const SYSTEM_COLOR = 8;
const BOT_QUEUE_MAX = 256;
const BOT_ERROR_LOG_LIMIT = 5;
/** Gameplay messages; a DEV DUMP whose timer ran out ends the game before any of them is applied. */
const GAMEPLAY_MESSAGES: ReadonlySet<C2S['t']> = new Set<C2S['t']>([
  'move',
  'taskOpen',
  'taskClose',
  'taskDone',
  'kill',
  'report',
  'emergency',
  'vent',
  'sabotage',
  'fix',
]);

// ---------- Injected collaborators (structural, so tests need none of the other server modules) ----------

/** Structural twin of `BotBrain` from server/bots.ts. */
export interface BotBrainLike {
  onSnapshot(snap: Snapshot): void;
  onChat(msg: ChatMessage): void;
  onEvent(event: GameEvent): void;
  tick(now: number): void;
}

/** Structural twin of `BotBrainOptions` from server/bots.ts. */
export interface BotBrainInit {
  id: string;
  send: (msg: C2S) => void;
  seed: number;
}

/** Structural twin of `GameResultRecord` from server/store.ts. */
export interface GameResultRecordLike {
  address: string;
  role: Role;
  won: boolean;
  rugs: number;
  tasksDone: number;
  correctVotes: number;
  wasRugged: boolean;
}

/** Structural twin of `RankedResultRecord` from server/store.ts. */
export interface RankedResultRecordLike {
  address: string;
  role: Role;
  won: boolean;
  rugs: number;
  tasksDone: number;
  correctVotes: number;
  /** Alive at the end. The store pays RANKED_POINTS.survived only to a holder in a game the holders won. */
  survived: boolean;
  /** Removed (left, or reconnect grace expired) before the game ended. Replaces everything else. */
  leftEarly: boolean;
}

/** Structural twin of the result of `consumeRankedTickets` from server/store.ts. */
export type ConsumeTicketsResult = { ok: true } | { ok: false; missing: string[] };

/**
 * The parts of a stored Profile (server/store.ts `getProfile`) the room reads. Every field is optional
 * and re-validated here, because the room must never trust a malformed record.
 */
export interface RoomProfileLike {
  cosmetics?: { owned?: readonly string[]; equipped?: EquippedCosmetics } | null;
  rankedTickets?: number;
}

/** The parts of a wallet Profile the room needs. */
export interface WalletIdentity {
  name: string;
  address: string;
}

export type RemoveReason = 'left' | 'kicked' | 'timeout';

const NEED_WALLET_MSG = 'Ranked needs a Phantom sign-in';
const NEED_TICKET_MSG = 'Ranked needs a ticket. Burn one to enter.';

/** A profile's ranked ticket count, 0 for anything malformed. */
export function ticketsOf(profile: RoomProfileLike | null | undefined): number {
  const n = profile?.rankedTickets;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Whether a player may enter a ranked room at all (create, join or quick): signed in with a profile, and
 * holding at least one ranked ticket. Null when allowed; otherwise the error to send.
 */
export function rankedEntryError(
  wallet: WalletIdentity | null | undefined,
  profileOf: ((address: string) => RoomProfileLike | null) | undefined,
): { code: ErrorCode; message: string } | null {
  if (!wallet || typeof wallet.address !== 'string' || !wallet.address) return { code: 'NEED_WALLET', message: NEED_WALLET_MSG };
  let profile: RoomProfileLike | null = null;
  try {
    profile = profileOf ? profileOf(wallet.address) : null;
  } catch {
    profile = null;
  }
  if (!profile) return { code: 'NEED_WALLET', message: NEED_WALLET_MSG };
  if (ticketsOf(profile) < 1) return { code: 'NEED_TICKET', message: NEED_TICKET_MSG };
  return null;
}

/**
 * Equipped cosmetics re-validated from a stored profile: each id must exist in the catalog, belong to its
 * slot and (when the profile lists them) be owned. Undefined when nothing valid is equipped.
 */
export function equippedFrom(profile: RoomProfileLike | null | undefined): EquippedCosmetics | undefined {
  const c = profile?.cosmetics;
  if (!c || typeof c !== 'object') return undefined;
  const equipped: unknown = c.equipped;
  if (!equipped || typeof equipped !== 'object') return undefined;
  const owned = Array.isArray(c.owned) ? c.owned : null;
  const out: EquippedCosmetics = {};
  let any = false;
  for (const { slot } of COSMETIC_SLOTS) {
    const id = (equipped as Record<string, unknown>)[slot];
    if (typeof id !== 'string' || !isCosmeticForSlot(id, slot)) continue;
    if (owned && !owned.includes(id)) continue;
    out[slot] = id;
    any = true;
  }
  return any ? out : undefined;
}

export interface RoomOptions {
  code: string;
  /** Server clock in ms. */
  now: () => number;
  /** Uniform [0, 1). Defaults to Math.random. */
  rng?: () => number;
  /** Deliver a message to a human player's socket (dropped if the player is offline). */
  send: (playerId: string, msg: S2C) => void;
  /** Ticker for RoomView (from getPublicConfig()). */
  ticker?: string;
  /** Initial settings (clamped). */
  settings?: Partial<GameSettings>;
  /** Creates a bot's brain on `addBot`. Without it bots are idle seat-fillers. */
  createBotBrain?: (init: BotBrainInit) => BotBrainLike;
  /** Bot display names (server/bots.ts `botName`). */
  botName?: (index: number) => string;
  /** Called once per finished game with the wallet-linked players (server/store.ts `recordGameResults`). */
  recordResults?: (records: GameResultRecordLike[]) => void;
  /**
   * Ranked room (SPEC "Ranked rooms"): wallet + ticket to join, one seat per wallet, no bots, settings
   * locked to DEFAULT_SETTINGS except isPublic, tickets consumed at start, weekly results at game over.
   */
  ranked?: boolean;
  /**
   * Fresh stored profile by full wallet address (server/store.ts `getProfile`): equipped cosmetics and
   * ranked tickets. Read when snapshots are built in the lobby, so equipping or burning shows live.
   */
  profileOf?: (address: string) => RoomProfileLike | null;
  /** Ranked start: take one ticket from every address, all or nothing (server/store.ts). */
  consumeRankedTickets?: (addresses: string[]) => ConsumeTicketsResult;
  /** Ranked game over: weekly points (server/store.ts `recordRankedResults`). */
  recordRankedResults?: (records: RankedResultRecordLike[]) => void;
  /** Called after a player has been removed so the socket layer can unbind them. */
  onPlayerRemoved?: (playerId: string, reason: RemoveReason) => void;
  log?: (message: string, err?: unknown) => void;
}

// ---------- Internal state ----------

export interface PlayerStats {
  rugs: number;
  tasksDone: number;
  correctVotes: number;
  wasRugged: boolean;
}

/** Full server-side player record. Exposed (read-mostly) for the RoomManager and tests. */
export interface PlayerState {
  readonly id: string;
  readonly sessionKey: string;
  readonly isBot: boolean;
  /** Monotonic join order inside the room (host migration picks the oldest human). */
  readonly joinSeq: number;
  /** Bots only: index passed to botName(). -1 for humans. */
  botIndex: number;
  name: string;
  color: number;
  /** Short wallet address for display. */
  wallet?: string;
  /** Full wallet address (stats). Never sent to clients. */
  address?: string;
  connected: boolean;
  disconnectedAt: number | null;
  role: Role;
  alive: boolean;
  /** Spawn slot index into SPAWN_POINTS. */
  slot: number;
  x: number;
  y: number;
  facing: 1 | -1;
  moving: boolean;
  /** Server time of the last accepted move (or teleport). */
  lastMoveAt: number;
  /** Server time of the last move message that passed the rate limit. */
  lastMoveMsgAt: number;
  /** Movement budget in px (see MOVE_BUDGET_WINDOW_MS) and when it was last refilled. */
  moveBudget: number;
  budgetAt: number;
  /** Recent accepted positions (oldest first), for the viewer velocity used by interest management. */
  trail: Array<{ x: number; y: number; t: number }>;
  teleportSeq: number;
  tasks: TaskAssignment[];
  activeStationId: string | null;
  openedAt: number;
  killReadyAt: number;
  ventId: string | null;
  emergencyLeft: number;
  lastChatAt: number;
  stats: PlayerStats;
  /**
   * Cosmetics frozen at game start for the whole round (lobby snapshots read the store live instead).
   * Freezing them means nobody, a ghost included, can signal anything by re-equipping mid-game.
   */
  roundCosmetics: EquippedCosmetics | undefined;
}

interface ActiveSabotage {
  kind: SabotageKind;
  startedAt: number;
  /** devDump only. */
  endsAt?: number;
  stations: string[];
  /** devDump only: stationId -> ids of players currently holding it. */
  holds: Map<string, Set<string>>;
}

interface MeetingState {
  callerId: string;
  reason: MeetingReason;
  bodyColor?: number;
  stage: 'discussion' | 'voting' | 'results';
  stageEndsAt: number;
  /** voterId -> targetId | 'skip' (insertion order = vote order). */
  votes: Map<string, string>;
  ejectedId: string | null;
  tie: boolean;
}

type BotInbox = { type: 'chat'; msg: ChatMessage } | { type: 'event'; event: GameEvent };

interface BotEntry {
  brain: BotBrainLike | null;
  inbox: BotInbox[];
  errors: number;
}

export type JoinResult =
  | { ok: true; player: PlayerState }
  | { ok: false; code: ErrorCode; message: string };

const REASON_TEXT: Record<GameOverReason, string> = {
  tasks: 'the bonding curve hit 100%',
  ruggersEjected: 'every Rugger is gone',
  parity: 'the Ruggers matched the Holders',
  devDump: 'the DEV DUMP timer ran out',
  abandoned: 'not enough players left',
};

function freshStats(): PlayerStats {
  return { rugs: 0, tasksDone: 0, correctVotes: 0, wasRugged: false };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Timing-safe string comparison (hashing first equalizes lengths). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** The straight segment between two points stays clear of solid cells for a small circle. */
function segmentClear(x0: number, y0: number, x1: number, y1: number): boolean {
  // Never trap a player whose stored position is somehow already inside geometry.
  if (!circleFree(x0, y0, SWEEP_RADIUS)) return true;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(len / SWEEP_STEP_PX);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!circleFree(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, SWEEP_RADIUS)) return false;
  }
  return true;
}

function inWorld(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= WORLD_W && y <= WORLD_H;
}

export class Room {
  readonly code: string;
  readonly createdAt: number;
  /** Ranked room (see RoomOptions.ranked). Fixed for the room's lifetime. */
  readonly ranked: boolean;

  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly sendFn: (playerId: string, msg: S2C) => void;
  private readonly ticker: string;
  private readonly createBotBrain?: (init: BotBrainInit) => BotBrainLike;
  private readonly botNameFn: (index: number) => string;
  private readonly recordResultsFn?: (records: GameResultRecordLike[]) => void;
  private readonly profileOfFn?: (address: string) => RoomProfileLike | null;
  private readonly consumeTicketsFn?: (addresses: string[]) => ConsumeTicketsResult;
  private readonly recordRankedFn?: (records: RankedResultRecordLike[]) => void;
  /** Profiles read during one tick's snapshots (every viewer's snapshot shows the same players). */
  private profileCache: Map<string, RoomProfileLike | null> | null = null;
  private readonly onPlayerRemoved?: (playerId: string, reason: RemoveReason) => void;
  private readonly log: (message: string, err?: unknown) => void;

  private _phase: Phase = 'lobby';
  /** End of roleReveal / ejection (meeting stages keep their own end). */
  private phaseEndsAt: number | undefined;
  /** Insertion order = join order. */
  private readonly players = new Map<string, PlayerState>();
  private hostId = '';
  private _settings: GameSettings;
  private bodies: BodyView[] = [];
  private sabotage: ActiveSabotage | null = null;
  /** Shared by all ruggers. */
  private sabotageReadyAt = 0;
  private meeting: MeetingState | null = null;
  private ejection: EjectionView | null = null;
  private gameOver: GameOverView | null = null;
  /** Wallet-linked players removed mid-game (recorded as losses at game over). */
  private departed: PlayerState[] = [];
  private readonly bots = new Map<string, BotEntry>();
  /** Interest management: viewerId -> (targetId -> last time the target qualified). */
  private readonly interest = new Map<string, Map<string, number>>();
  /** The last CHAT_LOG_MAX chat lines, replayed by visibility on join and rejoin. */
  private chatLog: ChatMessage[] = [];
  private joinCounter = 0;
  private dirty = true;
  private lastBroadcastAt = -Infinity;
  private disposed = false;

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    this.now = opts.now;
    this.rng = opts.rng ?? Math.random;
    this.sendFn = opts.send;
    this.ticker = opts.ticker && opts.ticker.trim() ? opts.ticker.trim() : DEFAULT_TICKER;
    this.createBotBrain = opts.createBotBrain;
    this.botNameFn = opts.botName ?? ((i) => `Bot ${i + 1}`);
    this.recordResultsFn = opts.recordResults;
    this.ranked = opts.ranked === true;
    this.profileOfFn = opts.profileOf;
    this.consumeTicketsFn = opts.consumeRankedTickets;
    this.recordRankedFn = opts.recordRankedResults;
    this.onPlayerRemoved = opts.onPlayerRemoved;
    this.log = opts.log ?? ((m, e) => console.error(`[room ${opts.code}] ${m}`, e ?? ''));
    // Ranked settings are locked to the defaults; only isPublic may differ.
    const isPublic = opts.settings?.isPublic;
    this._settings = this.ranked
      ? normalizeSettings(DEFAULT_SETTINGS, typeof isPublic === 'boolean' ? { isPublic } : undefined)
      : normalizeSettings(DEFAULT_SETTINGS, opts.settings);
    this.createdAt = this.now();
  }

  // ---------- Read-only accessors ----------

  get phase(): Phase {
    return this._phase;
  }

  get settings(): GameSettings {
    return { ...this._settings };
  }

  get host(): string {
    return this.hostId;
  }

  get playerCount(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  get humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  get connectedHumanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot && p.connected) n++;
    return n;
  }

  /** Eligible for quick play. */
  get isPublicLobby(): boolean {
    return this._phase === 'lobby' && this._settings.isPublic && !this.isFull && this.connectedHumanCount > 0;
  }

  /** A room with no humans left is destroyed by the RoomManager. */
  shouldDestroy(): boolean {
    return this.disposed || this.humanCount === 0;
  }

  getPlayer(id: string): PlayerState | undefined {
    return this.players.get(id);
  }

  playerIds(): string[] {
    return [...this.players.keys()];
  }

  /** Bonding curve 0..1: done holder tasks / total holder tasks (removed players excluded). */
  taskProgress(): number {
    let total = 0;
    let done = 0;
    for (const p of this.players.values()) {
      if (p.role !== 'holder') continue;
      total += p.tasks.length;
      for (const t of p.tasks) if (t.done) done++;
    }
    return total > 0 ? done / total : 0;
  }

  // ---------- Membership (called by the RoomManager) ----------

  /** True when a seat in this room is already linked to this full wallet address. */
  hasWallet(address: string): boolean {
    for (const p of this.players.values()) if (p.address === address) return true;
    return false;
  }

  /**
   * Whether `wallet` could take a seat right now, without changing anything (the RoomManager asks before
   * moving a player out of their current room). Ranked rooms also need a profile with a ticket, and allow
   * one seat per wallet.
   */
  checkJoin(wallet?: WalletIdentity | null): { ok: true } | { ok: false; code: ErrorCode; message: string } {
    if (this.disposed) return { ok: false, code: 'ROOM_NOT_FOUND', message: 'Room is closed' };
    if (this._phase !== 'lobby') return { ok: false, code: 'GAME_IN_PROGRESS', message: 'That game already started' };
    if (this.isFull) return { ok: false, code: 'ROOM_FULL', message: 'Room is full' };
    if (this.ranked) {
      const denied = rankedEntryError(wallet, (a) => this.readProfile(a));
      if (denied) return { ok: false, ...denied };
      if (wallet && this.hasWallet(wallet.address)) {
        return { ok: false, code: 'INVALID_ACTION', message: 'This wallet already has a seat in this room' };
      }
    }
    return { ok: true };
  }

  /** Seat a human. `wallet` is the resolved Profile when the player signed in. */
  addHuman(input: { name: string; wallet?: WalletIdentity | null }): JoinResult {
    const allowed = this.checkJoin(input.wallet);
    if (!allowed.ok) return allowed;
    const p = this.createPlayer(false, sanitizeName(input.name));
    const w = input.wallet;
    // One seat per wallet per room: a second seat with the same wallet plays as a guest (ranked refuses it above).
    if (w && typeof w.address === 'string' && w.address && !this.hasWallet(w.address)) {
      p.name = sanitizeName(w.name || input.name);
      p.address = w.address;
      p.wallet = shortAddress(w.address);
    }
    this.players.set(p.id, p);
    if (!this.hostId || !this.players.has(this.hostId)) this.hostId = p.id;
    this.emit({ kind: 'playerJoined', playerId: p.id, name: p.name }, this.others(p.id));
    this.system(`${p.name} joined`, p.color);
    this.dirty = true;
    return { ok: true, player: p };
  }

  /** Restore a seat after a reconnect. Returns the player on success, null on a bad id/key. */
  rejoin(playerId: string, sessionKey: string): PlayerState | null {
    if (this.disposed) return null;
    const p = this.players.get(playerId);
    if (!p || p.isBot || typeof sessionKey !== 'string' || !safeEqual(p.sessionKey, sessionKey)) return null;
    const now = this.now();
    p.connected = true;
    p.disconnectedAt = null;
    // The reloaded client starts from scratch: make it snap to the server position.
    p.teleportSeq++;
    this.resetMoveBudget(p, now);
    p.lastMoveMsgAt = -Infinity;
    if (!this.players.has(this.hostId)) this.migrateHost();
    this.dirty = true;
    return p;
  }

  /** Socket closed: keep the seat for RECONNECT_GRACE_MS. */
  setDisconnected(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p || p.isBot || !p.connected) return;
    p.connected = false;
    p.disconnectedAt = this.now();
    p.moving = false;
    p.activeStationId = null;
    this.dropHolds(p.id);
    this.dirty = true;
  }

  /** Explicit `leave`: removed immediately in any phase. */
  leave(playerId: string): void {
    this.removePlayer(playerId, 'left');
  }

  /** Stop everything (room destroyed). */
  dispose(): void {
    this.disposed = true;
    this.bots.clear();
  }

  // ---------- Messages ----------

  /** Entry point for every C2S message from a human socket or a bot brain. */
  handle(playerId: string, input: C2S): void {
    if (this.disposed) return;
    const msg = parseC2S(input);
    if (!msg) return;
    const p = this.players.get(playerId);
    if (!p) return;
    try {
      this.dispatch(p, msg);
    } catch (err) {
      this.log(`error handling '${msg.t}' from ${playerId}`, err);
    }
  }

  private dispatch(p: PlayerState, msg: C2S): void {
    // A DEV DUMP timer that ran out since the last tick wins before any late action can count.
    if (GAMEPLAY_MESSAGES.has(msg.t) && this.expireDevDump(this.now())) return;
    switch (msg.t) {
      case 'leave':
        this.removePlayer(p.id, 'left');
        return;
      case 'setColor':
        this.onSetColor(p, msg.color);
        return;
      case 'settings':
        this.onSettings(p, msg.settings);
        return;
      case 'addBot':
        this.onAddBot(p);
        return;
      case 'removeBot':
        this.onRemoveBot(p);
        return;
      case 'kick':
        this.onKick(p, msg.playerId);
        return;
      case 'start':
        this.onStart(p);
        return;
      case 'move':
        this.onMove(p, msg.x, msg.y, msg.facing, msg.moving);
        return;
      case 'taskOpen':
        this.onTaskOpen(p, msg.stationId);
        return;
      case 'taskClose':
        if (p.activeStationId !== null) {
          p.activeStationId = null;
          this.dirty = true;
        }
        return;
      case 'taskDone':
        this.onTaskDone(p, msg.stationId);
        return;
      case 'kill':
        this.onKill(p, msg.targetId);
        return;
      case 'report':
        this.onReport(p, msg.bodyId);
        return;
      case 'emergency':
        this.onEmergency(p);
        return;
      case 'vent':
        if (msg.action === 'exit') this.onVentExit(p);
        else if (msg.action === 'enter') this.onVentEnter(p, msg.ventId);
        else this.onVentMove(p, msg.ventId);
        return;
      case 'sabotage':
        this.onSabotage(p, msg.kind);
        return;
      case 'fix':
        this.onFix(p, msg.stationId, msg.action);
        return;
      case 'chat':
        this.onChat(p, msg.text);
        return;
      case 'vote':
        this.onVote(p, msg.target);
        return;
      case 'backToLobby':
        this.onBackToLobby(p);
        return;
      case 'create':
      case 'join':
      case 'quick':
      case 'rejoin':
      case 'ping':
        // Connection-level messages are handled by the RoomManager.
        return;
    }
  }

  // ---------- Lobby ----------

  private requireHostInLobby(p: PlayerState): boolean {
    if (p.id !== this.hostId) {
      this.err(p, 'NOT_HOST', 'Only the host can do that');
      return false;
    }
    if (this._phase !== 'lobby') {
      this.err(p, 'INVALID_ACTION', 'Only possible in the lobby');
      return false;
    }
    return true;
  }

  private onSetColor(p: PlayerState, color: number): void {
    if (this._phase !== 'lobby') return this.err(p, 'INVALID_ACTION', 'Colors can only change in the lobby');
    if (!Number.isInteger(color) || color < 0 || color >= PLAYER_COLORS.length) return this.err(p, 'BAD_REQUEST', 'Unknown color');
    if (color === p.color) return;
    for (const q of this.players.values()) {
      if (q.id !== p.id && q.color === color) return this.err(p, 'INVALID_ACTION', 'That color is taken');
    }
    p.color = color;
    this.dirty = true;
  }

  private onSettings(p: PlayerState, patch: Partial<GameSettings>): void {
    if (!this.requireHostInLobby(p)) return;
    if (this.ranked) {
      // Locked to DEFAULT_SETTINGS except isPublic. A patch that would change anything else is refused
      // whole; one that only repeats the locked values (a client sending its full settings) is fine.
      const clamped = clampSettings(this._settings, patch);
      const changesLocked = (Object.keys(clamped) as Array<keyof GameSettings>).some(
        (k) => k !== 'isPublic' && clamped[k] !== this._settings[k],
      );
      if (changesLocked) return this.err(p, 'RANKED_LOCKED', 'Ranked settings are locked');
      if (clamped.isPublic !== this._settings.isPublic) {
        this._settings = { ...this._settings, isPublic: clamped.isPublic };
        this.dirty = true;
      }
      return;
    }
    const next = clampSettings(this._settings, patch);
    if (next.emergencyMeetings !== this._settings.emergencyMeetings) {
      for (const q of this.players.values()) q.emergencyLeft = next.emergencyMeetings;
    }
    this._settings = next;
    this.dirty = true;
  }

  private onAddBot(p: PlayerState): void {
    if (!this.requireHostInLobby(p)) return;
    if (this.ranked) return this.err(p, 'RANKED_LOCKED', 'No bots in ranked');
    if (this.isFull) return this.err(p, 'ROOM_FULL', 'Room is full');
    this.addBot();
  }

  private addBot(): PlayerState {
    const used = new Set<number>();
    for (const q of this.players.values()) if (q.isBot) used.add(q.botIndex);
    let index = 0;
    while (used.has(index)) index++;
    let name: string;
    try {
      name = sanitizeName(this.botNameFn(index));
    } catch (err) {
      this.log('botName threw', err);
      name = `Bot ${index + 1}`;
    }
    const bot = this.createPlayer(true, name);
    bot.botIndex = index;
    this.players.set(bot.id, bot);
    const entry: BotEntry = { brain: null, inbox: [], errors: 0 };
    this.bots.set(bot.id, entry);
    if (this.createBotBrain) {
      const id = bot.id;
      const seed = Math.floor(this.rng() * 0x7fffffff);
      try {
        entry.brain = this.createBotBrain({ id, send: (m) => this.handle(id, m), seed });
      } catch (err) {
        this.log(`bot brain for ${id} failed to construct`, err);
      }
    }
    this.emit({ kind: 'playerJoined', playerId: bot.id, name: bot.name }, this.others(bot.id));
    this.system(`${bot.name} (bot) joined`, bot.color);
    this.dirty = true;
    return bot;
  }

  private onRemoveBot(p: PlayerState): void {
    if (!this.requireHostInLobby(p)) return;
    if (this.ranked) return this.err(p, 'RANKED_LOCKED', 'No bots in ranked');
    let last: PlayerState | undefined;
    for (const q of this.players.values()) if (q.isBot) last = q;
    if (!last) return this.err(p, 'INVALID_ACTION', 'No bots to remove');
    this.removePlayer(last.id, 'kicked');
  }

  private onKick(p: PlayerState, targetId: string): void {
    if (!this.requireHostInLobby(p)) return;
    const target = this.players.get(targetId);
    if (!target || target.id === p.id) return this.err(p, 'INVALID_ACTION', 'Cannot kick that player');
    if (!target.isBot) this.safeSend(target.id, { t: 'event', event: { kind: 'kicked' } });
    this.removePlayer(target.id, 'kicked');
  }

  private onStart(p: PlayerState): void {
    if (!this.requireHostInLobby(p)) return;
    if (this.ranked) return this.onRankedStart(p);
    if (this.players.size < MIN_PLAYERS) {
      return this.err(p, 'NOT_ENOUGH_PLAYERS', `Need at least ${MIN_PLAYERS} players (bots count)`);
    }
    this.startGame();
  }

  /**
   * Ranked start: 4+ humans, every one connected and wallet-linked, then one ticket is taken from every
   * player at once (all or nothing). If anyone lacks a ticket nothing is consumed, nothing starts, and
   * the host hears who.
   */
  private onRankedStart(host: PlayerState): void {
    const list = [...this.players.values()];
    if (list.length < MIN_PLAYERS) return this.err(host, 'NOT_ENOUGH_PLAYERS', `Ranked needs at least ${MIN_PLAYERS} players`);
    // Never true (no bots, and joining needs a wallet), but a seat without a wallet can't pay a ticket.
    const unlinked = list.filter((q) => q.isBot || !q.address);
    if (unlinked.length > 0) {
      return this.err(host, 'NEED_WALLET', `Not signed in: ${unlinked.map((q) => q.name).join(', ')}`);
    }
    // A ticket is not taken from someone who isn't here to play it.
    const away = list.filter((q) => !q.connected);
    if (away.length > 0) {
      return this.err(host, 'INVALID_ACTION', `Waiting for ${away.map((q) => q.name).join(', ')} to reconnect`);
    }
    const addresses = list.map((q) => q.address as string);
    let result: ConsumeTicketsResult | null = null;
    try {
      result = this.consumeTicketsFn ? this.consumeTicketsFn(addresses) : null;
    } catch (err) {
      this.log('consumeRankedTickets threw', err);
      result = null;
    }
    this.dirty = true; // ticket badges may have changed either way
    if (!result || result.ok !== true) {
      const missing = result && result.ok === false && Array.isArray(result.missing) ? new Set(result.missing) : null;
      const names = missing ? list.filter((q) => missing.has(q.address as string)).map((q) => q.name) : [];
      const message = names.length > 0 ? `No ranked ticket: ${names.join(', ')}` : 'Could not check ranked tickets. Try again.';
      return this.err(host, 'NEED_TICKET', message);
    }
    this.startGame();
  }

  private startGame(): void {
    const now = this.now();
    const list = [...this.players.values()];
    // Ranked always plays the full rugger count for its size; settings.ruggers is locked there anyway.
    const ruggerCount = this.ranked ? maxRuggersFor(list.length) : Math.min(this._settings.ruggers, maxRuggersFor(list.length));
    const ruggerIds = new Set(shuffle(list.map((p) => p.id), this.rng).slice(0, ruggerCount));
    const perPlayer = this._settings.tasksPerPlayer;
    list.forEach((p, i) => {
      p.role = ruggerIds.has(p.id) ? 'rugger' : 'holder';
      p.alive = true;
      p.slot = i;
      // Holders get real tasks; ruggers get a fake list of the same size (never marked done).
      p.tasks = sample(TASK_STATIONS, perPlayer, this.rng).map((s) => ({ stationId: s.id, kind: s.kind, done: false }));
      p.activeStationId = null;
      p.openedAt = 0;
      p.ventId = null;
      p.killReadyAt = now + POST_MEETING_COOLDOWN_MS;
      p.emergencyLeft = this._settings.emergencyMeetings;
      p.stats = freshStats();
      p.facing = 1;
      p.roundCosmetics = this.liveCosmetics(p);
      this.placeAtSpawn(p, now);
    });
    this.bodies = [];
    this.sabotage = null;
    this.sabotageReadyAt = now + POST_MEETING_COOLDOWN_MS;
    this.meeting = null;
    this.ejection = null;
    this.gameOver = null;
    this.departed = [];
    this.chatLog = [];
    this._phase = 'roleReveal';
    this.phaseEndsAt = now + ROLE_REVEAL_MS;
    this.emit({ kind: 'gameStarted' });
    this.system(`Game started: ${ruggerCount} Rugger${ruggerCount === 1 ? '' : 's'} among ${list.length} players.`);
    this.dirty = true;
  }

  private beginPlaying(afterMeeting: boolean): void {
    const now = this.now();
    this._phase = 'playing';
    this.phaseEndsAt = undefined;
    const killDelay = afterMeeting ? this._settings.killCooldown * 1000 : POST_MEETING_COOLDOWN_MS;
    for (const p of this.players.values()) {
      p.killReadyAt = now + killDelay;
      this.resetMoveBudget(p, now);
      p.lastMoveMsgAt = -Infinity;
      p.moving = false;
    }
    this.sabotageReadyAt = now + POST_MEETING_COOLDOWN_MS;
    this.resetInterest();
    this.dirty = true;
  }

  // ---------- Movement ----------

  private onMove(p: PlayerState, x: number, y: number, facing: 1 | -1, moving: boolean): void {
    if (this._phase !== 'playing' || p.ventId !== null) return;
    const now = this.now();
    if (now - p.lastMoveMsgAt < MOVE_MIN_INTERVAL_MS) return;
    p.lastMoveMsgAt = now;
    const rate = this.moveRate(p); // px per ms
    const cap = rate * MOVE_BUDGET_WINDOW_MS + MOVE_SLACK_PX;
    p.moveBudget = Math.min(cap, p.moveBudget + rate * Math.max(0, now - p.budgetAt));
    p.budgetAt = now;
    const d = Math.hypot(x - p.x, y - p.y);
    let ok = d <= p.moveBudget;
    if (ok) ok = p.alive ? circleFree(x, y) && segmentClear(p.x, p.y, x, y) : inWorld(x, y);
    if (!ok) {
      // Keep the old position (and the budget); the client snaps back when it sees teleportSeq change.
      p.teleportSeq++;
      p.moving = false;
      this.dirty = true;
      return;
    }
    p.moveBudget -= d;
    p.x = x;
    p.y = y;
    p.facing = facing;
    p.moving = moving;
    p.lastMoveAt = now;
    const trail = p.trail;
    trail.push({ x, y, t: now });
    while (trail.length > 8 || (trail.length > 2 && now - trail[1].t > VELOCITY_WINDOW_MS)) trail.shift();
  }

  /** Budget refill rate in px/ms: 1.5x the player's speed (ghosts are faster). */
  private moveRate(p: PlayerState): number {
    const speed = BASE_SPEED * this._settings.playerSpeed * (p.alive ? 1 : GHOST_SPEED_MULT);
    return (speed * MOVE_SPEED_TOLERANCE) / 1000;
  }

  private placeAtSpawn(p: PlayerState, now: number): void {
    const sp = SPAWN_POINTS[((p.slot % SPAWN_POINTS.length) + SPAWN_POINTS.length) % SPAWN_POINTS.length];
    this.teleport(p, sp.x, sp.y, now);
  }

  private teleport(p: PlayerState, x: number, y: number, now: number): void {
    p.x = x;
    p.y = y;
    p.moving = false;
    p.teleportSeq++;
    this.resetMoveBudget(p, now);
  }

  /** After a teleport or a pause in play the client starts over from the server position. */
  private resetMoveBudget(p: PlayerState, now: number): void {
    p.lastMoveAt = now;
    p.moveBudget = this.moveRate(p) * MOVE_RESET_WINDOW_MS + MOVE_SLACK_PX;
    p.budgetAt = now;
    p.trail = [{ x: p.x, y: p.y, t: now }];
  }

  // ---------- Tasks ----------

  private onTaskOpen(p: PlayerState, stationId: string): void {
    if (this._phase !== 'playing' || p.ventId !== null) return this.err(p, 'INVALID_ACTION', 'Cannot open a task right now');
    const task = p.tasks.find((t) => t.stationId === stationId);
    const station = stationById(stationId);
    if (!task || task.done || !station) return this.err(p, 'INVALID_ACTION', 'Not one of your tasks');
    if (dist(p, station) > USE_RANGE) return this.err(p, 'INVALID_ACTION', 'Too far from the station');
    p.activeStationId = stationId;
    p.openedAt = this.now();
    this.dirty = true;
  }

  private onTaskDone(p: PlayerState, stationId: string): void {
    if (this._phase !== 'playing' || p.ventId !== null) return;
    if (p.activeStationId !== stationId) return this.err(p, 'INVALID_ACTION', 'That task is not open');
    const station = stationById(stationId);
    const task = p.tasks.find((t) => t.stationId === stationId);
    if (!station || !task) {
      p.activeStationId = null;
      this.dirty = true;
      return;
    }
    const now = this.now();
    if (now - p.openedAt < TASK_MIN_MS[station.kind]) return this.err(p, 'INVALID_ACTION', 'Too fast, finish the task');
    if (dist(p, station) > USE_RANGE * 1.5) return this.err(p, 'INVALID_ACTION', 'Too far from the station');
    p.activeStationId = null;
    this.dirty = true;
    // Ruggers' tasks are fake: closing them is all that happens.
    if (p.role !== 'holder' || task.done) return;
    task.done = true;
    p.stats.tasksDone++;
    this.safeSendOrQueue(p, { kind: 'taskCompleted', stationId });
    this.checkWin();
  }

  // ---------- Rugging, reports, X SPACES ----------

  private onKill(p: PlayerState, targetId: string): void {
    if (this._phase !== 'playing') return;
    if (p.role !== 'rugger' || !p.alive || p.ventId !== null) return this.err(p, 'INVALID_ACTION', 'Cannot rug right now');
    const now = this.now();
    if (now < p.killReadyAt) return this.err(p, 'INVALID_ACTION', 'Rug is on cooldown');
    const target = this.players.get(targetId);
    if (!target || !target.alive || target.role !== 'holder' || target.ventId !== null) {
      return this.err(p, 'INVALID_ACTION', 'No valid target');
    }
    if (dist(p, target) > KILL_RANGE) return this.err(p, 'INVALID_ACTION', 'Target out of range');
    target.alive = false;
    target.moving = false;
    target.activeStationId = null;
    target.stats.wasRugged = true;
    this.dropHolds(target.id);
    const body: BodyView = { id: target.id, color: target.color, x: round1(target.x), y: round1(target.y) };
    // The VICTIM's own rug, frozen at game start. Never the killer's: that would name the rugger.
    const rug = target.roundCosmetics?.rug;
    if (rug) body.rug = rug;
    this.bodies.push(body);
    p.killReadyAt = now + this._settings.killCooldown * 1000;
    p.stats.rugs++;
    const recipients = new Map<string, PlayerState>([
      [p.id, p],
      [target.id, target],
    ]);
    for (const q of this.players.values()) if (q.role === 'rugger') recipients.set(q.id, q);
    this.emit({ kind: 'rugged', victimId: target.id, killerId: p.id }, recipients.values());
    this.dirty = true;
    this.checkWin();
  }

  private onReport(p: PlayerState, bodyId: string): void {
    if (this._phase !== 'playing') return;
    if (!p.alive || p.ventId !== null) return this.err(p, 'INVALID_ACTION', 'Cannot report right now');
    const body = this.bodies.find((b) => b.id === bodyId);
    if (!body) return this.err(p, 'INVALID_ACTION', 'Nothing to report');
    if (dist(p, body) > REPORT_RANGE) return this.err(p, 'INVALID_ACTION', 'Too far to report');
    this.startMeeting(p, 'report', body.color);
  }

  private onEmergency(p: PlayerState): void {
    if (this._phase !== 'playing') return;
    if (!p.alive || p.ventId !== null) return this.err(p, 'INVALID_ACTION', 'Cannot call X SPACES right now');
    if (p.emergencyLeft <= 0) return this.err(p, 'INVALID_ACTION', 'No emergency X SPACES left');
    if (this.sabotage?.kind === 'devDump') return this.err(p, 'INVALID_ACTION', 'Stop the DEV DUMP first');
    if (dist(p, EMERGENCY_BUTTON) > EMERGENCY_RANGE) return this.err(p, 'INVALID_ACTION', 'Too far from the SPACES button');
    p.emergencyLeft--;
    this.startMeeting(p, 'emergency');
  }

  private startMeeting(caller: PlayerState, reason: MeetingReason, bodyColor?: number): void {
    const now = this.now();
    this.sabotage = null;
    this.bodies = [];
    for (const p of this.players.values()) {
      p.activeStationId = null;
      p.ventId = null;
      p.moving = false;
      if (p.alive) this.placeAtSpawn(p, now);
    }
    const meeting: MeetingState = {
      callerId: caller.id,
      reason,
      stage: 'discussion',
      stageEndsAt: now,
      votes: new Map(),
      ejectedId: null,
      tie: false,
    };
    if (bodyColor !== undefined) meeting.bodyColor = bodyColor;
    this.meeting = meeting;
    this._phase = 'meeting';
    this.phaseEndsAt = undefined;
    if (reason === 'report') {
      this.emit({ kind: 'bodyReported', reporterId: caller.id, bodyColor: bodyColor ?? caller.color });
      this.system(`${caller.name} found a rugged bag. X SPACES is live.`, caller.color);
    } else {
      this.emit({ kind: 'emergencyCalled', callerId: caller.id });
      this.system(`${caller.name} called an emergency X SPACES.`, caller.color);
    }
    if (this._settings.discussionTime > 0) {
      meeting.stageEndsAt = now + this._settings.discussionTime * 1000;
    } else {
      this.openVoting();
    }
    this.dirty = true;
  }

  private openVoting(): void {
    const m = this.meeting;
    if (!m) return;
    m.stage = 'voting';
    m.stageEndsAt = this.now() + this._settings.votingTime * 1000;
    this.emit({ kind: 'votingOpened' });
    this.dirty = true;
  }

  private onVote(p: PlayerState, target: string): void {
    const m = this.meeting;
    if (this._phase !== 'meeting' || !m || m.stage !== 'voting') return this.err(p, 'INVALID_ACTION', 'Voting is not open');
    if (!p.alive) return this.err(p, 'INVALID_ACTION', 'Ghosts cannot vote');
    if (m.votes.has(p.id)) return;
    if (target !== SKIP) {
      const t = this.players.get(target);
      if (!t || !t.alive) return this.err(p, 'INVALID_ACTION', 'Cannot vote for that player');
    }
    m.votes.set(p.id, target);
    this.dirty = true;
    this.checkAllVoted();
  }

  /** Voting ends early once every living player has voted. */
  private checkAllVoted(): void {
    const m = this.meeting;
    if (this._phase !== 'meeting' || !m || m.stage !== 'voting') return;
    for (const p of this.players.values()) if (p.alive && !m.votes.has(p.id)) return;
    this.showResults();
  }

  private showResults(): void {
    const m = this.meeting;
    if (!m) return;
    const result = tallyVotes(m.votes, (id) => this.players.get(id)?.alive === true);
    m.ejectedId = result.ejectedId;
    m.tie = result.tie;
    m.stage = 'results';
    m.stageEndsAt = this.now() + MEETING_RESULTS_MS;
    this.dirty = true;
  }

  private advanceMeeting(): void {
    const m = this.meeting;
    if (!m) return;
    if (m.stage === 'discussion') this.openVoting();
    else if (m.stage === 'voting') this.showResults();
    else this.startEjection();
  }

  private startEjection(): void {
    const now = this.now();
    const m = this.meeting;
    this.meeting = null;
    const candidate = m?.ejectedId ? this.players.get(m.ejectedId) : undefined;
    const ejected = candidate && candidate.alive ? candidate : undefined;
    if (ejected) {
      // Blacklisted: dead, no body.
      ejected.alive = false;
      ejected.moving = false;
      ejected.activeStationId = null;
      this.dropHolds(ejected.id);
      if (ejected.role === 'rugger' && m) {
        for (const [voterId, target] of m.votes) {
          if (target !== ejected.id) continue;
          const voter = this.players.get(voterId);
          if (voter) voter.stats.correctVotes++;
        }
      }
    }
    const view: EjectionView = { ejectedId: ejected ? ejected.id : null, tie: m?.tie ?? false };
    // Without confirmed blacklists the remaining count would give the ejected player's role away.
    if (this._settings.confirmEjects) view.ruggersLeft = this.livingCount('rugger');
    if (ejected) {
      view.ejectedName = ejected.name;
      view.ejectedColor = ejected.color;
      if (this._settings.confirmEjects) view.wasRugger = ejected.role === 'rugger';
    }
    this.ejection = view;
    this._phase = 'ejection';
    this.phaseEndsAt = now + EJECTION_MS;
    this.dirty = true;
  }

  private finishEjection(): void {
    const view = this.ejection;
    if (view) {
      if (view.ejectedId && view.ejectedName) {
        const verdict =
          view.wasRugger === undefined ? 'was blacklisted.' : view.wasRugger ? 'was the Rugger.' : 'was not the Rugger.';
        this.system(`${view.ejectedName} ${verdict}`, view.ejectedColor ?? SYSTEM_COLOR);
      } else {
        this.system(view.tie ? 'Tie vote. No one was blacklisted.' : 'No one was blacklisted.');
      }
    }
    this.ejection = null;
    if (this.checkWin()) return;
    this.beginPlaying(true);
  }

  // ---------- Sabotage ----------

  private onSabotage(p: PlayerState, kind: SabotageKind): void {
    if (this._phase !== 'playing' || p.role !== 'rugger') return this.err(p, 'INVALID_ACTION', 'Cannot sabotage right now');
    if (this.sabotage) return this.err(p, 'INVALID_ACTION', 'A sabotage is already running');
    const now = this.now();
    if (now < this.sabotageReadyAt) return this.err(p, 'INVALID_ACTION', 'Sabotage is on cooldown');
    const stations = SABOTAGE_STATIONS.filter((s) => s.sabotage === kind).map((s) => s.id);
    const sab: ActiveSabotage = { kind, startedAt: now, stations, holds: new Map(stations.map((id) => [id, new Set<string>()])) };
    if (kind === 'devDump') sab.endsAt = now + DEV_DUMP_DURATION_MS;
    this.sabotage = sab;
    this.emit({ kind: 'sabotageStarted', sabotage: kind });
    this.dirty = true;
  }

  private onFix(p: PlayerState, stationId: string, action: 'holdStart' | 'holdEnd' | 'done'): void {
    const s = this.sabotage;
    if (this._phase !== 'playing' || !s || !s.stations.includes(stationId)) return;
    const station = sabotageStationById(stationId);
    if (!station) return;
    if (s.kind === 'devDump') {
      if (action === 'holdEnd') {
        if (s.holds.get(stationId)?.delete(p.id)) this.dirty = true;
        return;
      }
      if (action !== 'holdStart') return;
      if (!p.alive || p.ventId !== null) return this.err(p, 'INVALID_ACTION', 'Cannot hold the BUY WALL right now');
      if (dist(p, station) > USE_RANGE) return this.err(p, 'INVALID_ACTION', 'Too far from the BUY WALL');
      this.dropHolds(p.id);
      s.holds.get(stationId)?.add(p.id);
      this.dirty = true;
      // Fixed the moment both BUY WALLs are held, so a hold made in time never loses to tick timing.
      if (this.bothWallsHeld(s)) this.fixSabotage();
      return;
    }
    if (action !== 'done') return;
    if (!p.alive || p.ventId !== null) return this.err(p, 'INVALID_ACTION', 'Cannot fix right now');
    if (dist(p, station) > USE_RANGE * 1.5) return this.err(p, 'INVALID_ACTION', 'Too far from the console');
    this.fixSabotage();
  }

  private fixSabotage(): void {
    const s = this.sabotage;
    if (!s) return;
    this.sabotage = null;
    this.sabotageReadyAt = this.now() + SABOTAGE_COOLDOWN_MS;
    this.emit({ kind: 'sabotageFixed', sabotage: s.kind });
    this.dirty = true;
  }

  private dropHolds(playerId: string): void {
    const s = this.sabotage;
    if (!s) return;
    for (const set of s.holds.values()) if (set.delete(playerId)) this.dirty = true;
  }

  /** devDump upkeep, every tick in `playing`. The timer is checked first: holds after endsAt are too late. */
  private updateSabotage(now: number): void {
    const s = this.sabotage;
    if (!s || s.kind !== 'devDump') return;
    if (this.expireDevDump(now)) return;
    if (this.bothWallsHeld(s)) this.fixSabotage();
  }

  /** Drop holders who left, died, disconnected or bridged; then true when every BUY WALL is held. */
  private bothWallsHeld(s: ActiveSabotage): boolean {
    for (const [stationId, holders] of s.holds) {
      const station = sabotageStationById(stationId);
      for (const pid of [...holders]) {
        const q = this.players.get(pid);
        if (!q || !station || !q.alive || !q.connected || q.ventId !== null || dist(q, station) > USE_RANGE * 1.5) {
          holders.delete(pid);
          this.dirty = true;
        }
      }
    }
    return s.stations.length > 0 && s.stations.every((id) => (s.holds.get(id)?.size ?? 0) > 0);
  }

  /** SPEC: if endsAt passes before the fix, ruggers win with reason devDump. Returns true when the game ended. */
  private expireDevDump(now: number): boolean {
    const s = this.sabotage;
    if (this._phase !== 'playing' || !s || s.kind !== 'devDump' || s.endsAt === undefined || now < s.endsAt) return false;
    return this.endGame('ruggers', 'devDump');
  }

  // ---------- Bridges (vents) ----------

  private onVentEnter(p: PlayerState, ventId: string): void {
    if (this._phase !== 'playing' || p.role !== 'rugger' || !p.alive) return this.err(p, 'INVALID_ACTION', 'Cannot use bridges');
    if (p.ventId !== null) return;
    const vent = ventById(ventId);
    if (!vent) return this.err(p, 'INVALID_ACTION', 'Unknown bridge');
    if (dist(p, vent) > VENT_RANGE) return this.err(p, 'INVALID_ACTION', 'Too far from the bridge');
    // Gone from every non-rugger's snapshots at once, with no hold (see interestView).
    for (const seen of this.interest.values()) seen.delete(p.id);
    p.ventId = vent.id;
    p.activeStationId = null;
    this.dropHolds(p.id);
    this.teleport(p, vent.x, vent.y, this.now());
    this.dirty = true;
  }

  private onVentMove(p: PlayerState, ventId: string): void {
    if (this._phase !== 'playing' || p.ventId === null) return;
    const current = ventById(p.ventId);
    const next = ventById(ventId);
    if (!current || !next || !current.links.includes(next.id)) return this.err(p, 'INVALID_ACTION', 'Bridges are not linked');
    p.ventId = next.id;
    this.teleport(p, next.x, next.y, this.now());
    this.dirty = true;
  }

  private onVentExit(p: PlayerState): void {
    if (this._phase !== 'playing' || p.ventId === null) return;
    // The player stays at the vent position.
    p.ventId = null;
    this.resetMoveBudget(p, this.now());
    p.moving = false;
    this.dirty = true;
  }

  // ---------- Chat ----------

  private onChat(p: PlayerState, raw: string): void {
    const text = sanitizeChat(raw);
    if (!text) return;
    let channel: ChatChannel;
    let recipients: PlayerState[];
    const all = [...this.players.values()];
    const ghosts = () => all.filter((q) => !q.alive);
    switch (this._phase) {
      case 'lobby':
      case 'gameOver':
        channel = 'lobby';
        recipients = all;
        break;
      case 'meeting':
        if (p.alive) {
          channel = 'meeting';
          recipients = all;
        } else {
          channel = 'ghost';
          recipients = ghosts();
        }
        break;
      case 'playing':
      case 'ejection':
        if (p.alive) return; // only ghosts talk outside meetings
        channel = 'ghost';
        recipients = ghosts();
        break;
      default:
        return;
    }
    const now = this.now();
    if (now - p.lastChatAt < CHAT_RATE_LIMIT_MS) return this.err(p, 'RATE_LIMITED', 'Slow down');
    p.lastChatAt = now;
    this.deliverChat({ t: 'chat', channel, fromId: p.id, fromName: p.name, color: p.color, text, ts: now }, recipients);
  }

  // ---------- Game over / lobby reset ----------

  private onBackToLobby(p: PlayerState): void {
    if (p.id !== this.hostId) return this.err(p, 'NOT_HOST', 'Only the host can do that');
    if (this._phase !== 'gameOver') return this.err(p, 'INVALID_ACTION', 'The game is not over');
    for (const q of [...this.players.values()]) if (!q.isBot && !q.connected) this.removePlayer(q.id, 'timeout');
    this.resetToLobby();
    // The lobby keeps only lobby chat, like the clients do when they see the lobby again.
    this.chatLog = this.chatLog.filter((m) => m.channel === 'lobby');
  }

  private resetToLobby(): void {
    const now = this.now();
    this._phase = 'lobby';
    this.phaseEndsAt = undefined;
    this.bodies = [];
    this.sabotage = null;
    this.sabotageReadyAt = 0;
    this.meeting = null;
    this.ejection = null;
    this.gameOver = null;
    this.departed = [];
    let slot = 0;
    for (const p of this.players.values()) {
      p.role = 'holder';
      p.alive = true;
      p.tasks = [];
      p.activeStationId = null;
      p.openedAt = 0;
      p.ventId = null;
      p.killReadyAt = 0;
      p.emergencyLeft = this._settings.emergencyMeetings;
      p.stats = freshStats();
      p.roundCosmetics = undefined;
      p.slot = slot++;
      this.placeAtSpawn(p, now);
    }
    this.system('Back in the lobby.');
    this.dirty = true;
  }

  /**
   * Win check (after kills, ejections, task completions and removals; also when the DEV DUMP timer expires).
   * Returns true when the game ended.
   */
  private checkWin(): boolean {
    const phase = this._phase;
    if (phase === 'lobby' || phase === 'gameOver') return false;
    let total = 0;
    let done = 0;
    let livingHolders = 0;
    let livingRuggers = 0;
    for (const p of this.players.values()) {
      if (p.role === 'holder') {
        total += p.tasks.length;
        for (const t of p.tasks) if (t.done) done++;
        if (p.alive) livingHolders++;
      } else if (p.alive) {
        livingRuggers++;
      }
    }
    if (total > 0 && done >= total) return this.endGame('holders', 'tasks');
    if (livingRuggers === 0) return this.endGame('holders', 'ruggersEjected');
    if (livingRuggers >= livingHolders) return this.endGame('ruggers', 'parity');
    const s = this.sabotage;
    if (s && s.kind === 'devDump' && s.endsAt !== undefined && this.now() >= s.endsAt) return this.endGame('ruggers', 'devDump');
    return false;
  }

  private endGame(winner: Winner, reason: GameOverReason): true {
    this._phase = 'gameOver';
    this.phaseEndsAt = undefined;
    this.sabotage = null;
    this.meeting = null;
    this.ejection = null;
    const roles: Record<string, Role> = {};
    const ruggerNames: string[] = [];
    for (const p of this.players.values()) {
      p.activeStationId = null;
      p.ventId = null;
      p.moving = false;
      roles[p.id] = p.role;
      if (p.role === 'rugger') ruggerNames.push(p.name);
    }
    this.gameOver = { winner, reason, roles };
    const headline = winner === 'holders' ? 'GRADUATED: Holders win' : 'RUGGED: Ruggers win';
    const reveal = ruggerNames.length ? ` Rugger${ruggerNames.length === 1 ? '' : 's'}: ${ruggerNames.join(', ')}.` : '';
    this.system(`${headline}, ${REASON_TEXT[reason]}.${reveal}`);
    this.recordResults(winner);
    this.dirty = true;
    return true;
  }

  private recordResults(winner: Winner): void {
    const departed = this.departed;
    this.departed = [];
    const records: GameResultRecordLike[] = [];
    const ranked: RankedResultRecordLike[] = [];
    const seen = new Set<string>();
    const add = (p: PlayerState, left: boolean) => {
      if (!p.address || seen.has(p.address)) return;
      seen.add(p.address);
      const teamWon = (winner === 'holders') === (p.role === 'holder');
      records.push({
        address: p.address,
        role: p.role,
        won: !left && teamWon,
        rugs: p.stats.rugs,
        tasksDone: p.stats.tasksDone,
        correctVotes: p.stats.correctVotes,
        wasRugged: p.stats.wasRugged,
      });
      if (!this.ranked) return;
      // SPEC: a player removed before the end gets leftEarly instead of everything else.
      ranked.push(
        left
          ? { address: p.address, role: p.role, won: false, rugs: 0, tasksDone: 0, correctVotes: 0, survived: false, leftEarly: true }
          : {
              address: p.address,
              role: p.role,
              won: teamWon,
              rugs: p.stats.rugs,
              tasksDone: p.stats.tasksDone,
              correctVotes: p.stats.correctVotes,
              survived: p.alive,
              leftEarly: false,
            },
      );
    };
    for (const p of this.players.values()) add(p, false);
    for (const p of departed) add(p, true);
    if (records.length > 0 && this.recordResultsFn) {
      try {
        this.recordResultsFn(records);
      } catch (err) {
        this.log('recordGameResults failed', err);
      }
    }
    if (ranked.length > 0) {
      if (!this.recordRankedFn) {
        this.log('ranked game over without a recordRankedResults hook');
        return;
      }
      try {
        this.recordRankedFn(ranked);
      } catch (err) {
        this.log('recordRankedResults failed', err);
      }
    }
  }

  // ---------- Removal and host migration ----------

  private removePlayer(playerId: string, reason: RemoveReason): void {
    const p = this.players.get(playerId);
    if (!p) return;
    const phase = this._phase;
    const inRound = phase === 'roleReveal' || phase === 'playing' || phase === 'meeting' || phase === 'ejection';
    this.players.delete(playerId);
    this.bots.delete(playerId);
    this.interest.delete(playerId);
    for (const seen of this.interest.values()) seen.delete(playerId);
    this.dropHolds(playerId);
    const m = this.meeting;
    if (m) {
      m.votes.delete(playerId);
      // While voting is open, voters whose target just left may vote again.
      if (m.stage === 'voting') for (const [voter, target] of [...m.votes]) if (target === playerId) m.votes.delete(voter);
    }
    if (inRound && p.address) this.departed.push(p);
    if (playerId === this.hostId) this.migrateHost();
    const verb = reason === 'kicked' ? 'was kicked' : reason === 'timeout' ? 'disconnected' : 'left';
    this.emit({ kind: 'playerLeft', playerId, name: p.name });
    this.system(`${p.name} ${verb}`, p.color);
    this.dirty = true;
    try {
      this.onPlayerRemoved?.(playerId, reason);
    } catch (err) {
      this.log('onPlayerRemoved threw', err);
    }
    // A removed player counts as dead with no body; their tasks leave the curve.
    if (inRound && !this.checkWin()) this.checkAllVoted();
  }

  /** The oldest remaining human becomes host (connected ones first). Bots never host. */
  private migrateHost(): void {
    let firstConnected: PlayerState | undefined;
    let first: PlayerState | undefined;
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      if (!first || p.joinSeq < first.joinSeq) first = p;
      if (p.connected && (!firstConnected || p.joinSeq < firstConnected.joinSeq)) firstConnected = p;
    }
    const next = firstConnected ?? first;
    const prev = this.hostId;
    this.hostId = next ? next.id : '';
    if (next && next.id !== prev) this.system(`${next.name} is now the host`, next.color);
    this.dirty = true;
  }

  // ---------- Tick ----------

  /** Advance timers, bots and snapshots. Call at SERVER_TICK_HZ. */
  tick(): void {
    if (this.disposed) return;
    const now = this.now();
    try {
      this.expireDisconnected(now);
      this.advanceTimers(now);
      if (this._phase === 'playing') {
        for (const p of this.players.values()) {
          if (p.moving && now - p.lastMoveMsgAt > MOVING_TIMEOUT_MS) {
            p.moving = false;
          }
        }
      }
    } catch (err) {
      this.log('tick failed', err);
    }
    // Every snapshot built this tick shows the same profiles: read each one from the store once.
    this.profileCache = new Map();
    try {
      this.tickBots(now);
      this.broadcast(now);
    } finally {
      this.profileCache = null;
    }
  }

  private expireDisconnected(now: number): void {
    for (const p of [...this.players.values()]) {
      if (!p.isBot && !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt >= RECONNECT_GRACE_MS) {
        this.removePlayer(p.id, 'timeout');
      }
    }
  }

  private advanceTimers(now: number): void {
    switch (this._phase) {
      case 'roleReveal':
        if (this.phaseEndsAt !== undefined && now >= this.phaseEndsAt) this.beginPlaying(false);
        break;
      case 'playing':
        this.updateSabotage(now);
        break;
      case 'meeting':
        if (this.meeting && now >= this.meeting.stageEndsAt) this.advanceMeeting();
        break;
      case 'ejection':
        if (this.phaseEndsAt !== undefined && now >= this.phaseEndsAt) this.finishEjection();
        break;
      case 'lobby':
      case 'gameOver':
        break;
    }
  }

  private tickBots(now: number): void {
    if (this.bots.size === 0) return;
    for (const [id, entry] of [...this.bots]) {
      if (this.disposed) return;
      if (!this.players.has(id)) {
        this.bots.delete(id);
        continue;
      }
      const brain = entry.brain;
      if (!brain) {
        entry.inbox.length = 0;
        continue;
      }
      for (const item of entry.inbox.splice(0)) {
        if (item.type === 'chat') this.guardBot(entry, id, () => brain.onChat(item.msg));
        else this.guardBot(entry, id, () => brain.onEvent(item.event));
      }
      const snap = this.buildSnapshot(id);
      if (snap) this.guardBot(entry, id, () => brain.onSnapshot(snap));
      if (this.players.has(id)) this.guardBot(entry, id, () => brain.tick(now));
    }
  }

  /** Exceptions thrown inside a bot must never crash the room. */
  private guardBot(entry: BotEntry, id: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      entry.errors++;
      if (entry.errors <= BOT_ERROR_LOG_LIMIT) this.log(`bot ${id} threw`, err);
    }
  }

  private broadcast(now: number): void {
    const due = this._phase === 'playing' || this.dirty || now - this.lastBroadcastAt >= IDLE_SNAPSHOT_MS;
    if (!due) return;
    this.dirty = false;
    this.lastBroadcastAt = now;
    for (const p of this.players.values()) {
      if (p.isBot || !p.connected) continue;
      const snap = this.buildSnapshot(p.id);
      if (snap) this.safeSend(p.id, snap);
    }
  }

  /** Send one player their snapshot right away (after welcome / rejoin). */
  sendSnapshotTo(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p || p.isBot) return;
    const snap = this.buildSnapshot(playerId);
    if (snap) this.safeSend(playerId, snap);
  }

  // ---------- Snapshots ----------

  /** Per-client view with the SPEC visibility rules. Null if the viewer is not in the room. */
  buildSnapshot(viewerId: string): Snapshot | null {
    const viewer = this.players.get(viewerId);
    if (!viewer) return null;
    const phase = this._phase;
    const snap: Snapshot = {
      t: 'snap',
      now: this.now(),
      phase,
      room: { code: this.code, hostId: this.hostId, settings: { ...this._settings }, ticker: this.ticker, ranked: this.ranked },
      players: this.visiblePlayers(viewer),
      bodies: this.bodies.map((b) => ({ ...b })),
      taskProgress: this.progressFor(viewer),
      sabotage: this.sabotageView(),
    };
    const endsAt = phase === 'meeting' ? this.meeting?.stageEndsAt : this.phaseEndsAt;
    if (endsAt !== undefined) snap.phaseEndsAt = endsAt;
    if (phase !== 'lobby') snap.me = this.meView(viewer);
    if (phase === 'meeting' && this.meeting) snap.meeting = this.meetingView(viewer, this.meeting);
    if (phase === 'ejection' && this.ejection) snap.ejection = { ...this.ejection };
    if (phase === 'gameOver' && this.gameOver) snap.gameOver = { ...this.gameOver, roles: { ...this.gameOver.roles } };
    return snap;
  }

  private visiblePlayers(viewer: PlayerState): PlayerView[] {
    const phase = this._phase;
    const out: PlayerView[] = [];
    if (phase === 'lobby') {
      for (const p of this.players.values()) out.push(this.playerView(p, false, false));
      return out;
    }
    // Dead viewers and everyone at game over see everything, roles included.
    const seeAll = phase === 'gameOver' || !viewer.alive;
    const viewerIsRugger = viewer.role === 'rugger';
    // Meeting cards show who is dead; outside meetings the living never receive ghosts.
    const includeDead = phase === 'meeting';
    // While playing, the living only receive the players they could plausibly see (interest management).
    // Players leaving view linger INTEREST_HOLD_MS; a rugger entering a bridge is dropped at once.
    const filtered = phase === 'playing' && !seeAll;
    const reach = filtered ? this.visionRadius(viewer) + INTEREST_MARGIN_PX : 0;
    // The viewer's sample points, worked out only once some target needs more than the direct check.
    let eyes: Vec[] | null = null;
    const getEyes = () => (eyes ??= this.viewPoints(viewer));
    const now = this.now();
    for (const p of this.players.values()) {
      const vented = p.ventId !== null;
      if (seeAll) {
        out.push(this.playerView(p, p.role === 'rugger', vented));
        continue;
      }
      const fellow = viewerIsRugger && p.role === 'rugger';
      if (!p.alive) {
        if (includeDead) out.push(this.meetingGhostView(p, fellow));
        continue;
      }
      // Fellow ruggers always see each other, inside bridges too.
      if (fellow) {
        out.push(this.playerView(p, true, vented));
        continue;
      }
      if (filtered && p.id !== viewer.id) {
        const v = this.interestView(viewer, p, getEyes, reach, now);
        if (v) out.push(v);
        continue;
      }
      if (vented) continue;
      out.push(this.playerView(p, false, false));
    }
    return out;
  }

  /** Vision radius as the client draws it (SPEC: crewVision / ruggerVision; FUD shrinks holders'). */
  private visionRadius(viewer: PlayerState): number {
    const s = this._settings;
    if (viewer.role === 'rugger') return BASE_VISION * s.ruggerVision;
    const fud = this.sabotage;
    const fudActive = fud?.kind === 'fud' && this.now() - fud.startedAt >= FUD_INTEREST_DELAY_MS;
    return BASE_VISION * s.crewVision * (fudActive ? FUD_VISION_MULT : 1);
  }

  /**
   * What a living viewer receives of another living player while playing (null: nothing).
   * A player is sent while it qualifies (see `qualifies`) and for INTEREST_HOLD_MS after. A rugger in a
   * bridge is never sent, with no hold, so a holder's client never draws them lingering on the hatch.
   */
  private interestView(viewer: PlayerState, p: PlayerState, eyes: () => readonly Vec[], reach: number, now: number): PlayerView | null {
    let seen = this.interest.get(viewer.id);
    if (!seen) this.interest.set(viewer.id, (seen = new Map()));
    if (p.ventId !== null) {
      seen.delete(p.id);
      return null;
    }
    if (this.qualifies(viewer, eyes, p, reach)) {
      seen.set(p.id, now);
      return this.playerView(p, false, false);
    }
    const at = seen.get(p.id);
    if (at !== undefined && now - at <= INTEREST_HOLD_MS) return this.playerView(p, false, false);
    seen.delete(p.id);
    return null;
  }

  /**
   * Within `reach` of the viewer and in line of sight from it or any of its sample points (`viewPoints`) to the
   * target's center or to any of four points one player radius off it, so nobody pops at wall edges or
   * when the viewer's predicted position rounds a corner ahead of the server's copy.
   */
  private qualifies(viewer: PlayerState, getEyes: () => readonly Vec[], target: Vec, reach: number): boolean {
    const dx = target.x - viewer.x;
    const dy = target.y - viewer.y;
    if (dx * dx + dy * dy > reach * reach) return false;
    if (lineOfSight(viewer, target)) return true;
    const eyes = getEyes();
    for (const e of eyes) if (lineOfSight(e, target)) return true;
    const r = PLAYER_RADIUS;
    const q = { x: 0, y: 0 };
    for (const e of eyes) {
      for (let i = 0; i < 4; i++) {
        q.x = target.x + (i === 0 ? r : i === 1 ? -r : 0);
        q.y = target.y + (i === 2 ? r : i === 3 ? -r : 0);
        if (lineOfSight(e, q)) return true;
      }
    }
    return false;
  }

  /** Where the viewer's client may be drawing from: its server position, points ahead along its velocity, probes. */
  private viewPoints(viewer: PlayerState): Vec[] {
    const eyes: Vec[] = [{ x: viewer.x, y: viewer.y }];
    const v = this.velocityOf(viewer);
    if (v) {
      let x = viewer.x;
      let y = viewer.y;
      let t = 0;
      for (const ahead of INTEREST_LOOKAHEAD_MS) {
        const q = moveWithCollision(x, y, v.x * (ahead - t), v.y * (ahead - t));
        if (Math.abs(q.x - x) + Math.abs(q.y - y) < 1) break; // stuck against a wall
        eyes.push(q);
        x = q.x;
        y = q.y;
        t = ahead;
      }
    }
    const d = INTEREST_PROBE_PX;
    for (let i = 0; i < 4; i++) {
      const dx = i === 0 ? d : i === 1 ? -d : 0;
      const dy = i === 2 ? d : i === 3 ? -d : 0;
      // Walked like a move, so a probe stops at a wall instead of looking through it.
      const q = moveWithCollision(viewer.x, viewer.y, dx, dy);
      if (Math.abs(q.x - viewer.x) + Math.abs(q.y - viewer.y) >= PLAYER_RADIUS / 2) eyes.push(q);
    }
    return eyes;
  }

  /** The viewer's recent velocity in px/ms from its accepted moves, capped at its speed; null when standing. */
  private velocityOf(p: PlayerState): Vec | null {
    const trail = p.trail;
    const last = trail[trail.length - 1];
    if (!p.moving || !last || trail.length < 2 || this.now() - last.t > MOVING_TIMEOUT_MS) return null;
    // The newest sample at least half a window older than the last one, so a bunch of moves arriving
    // together doesn't read as a sprint; but not one from before the player set off.
    let first: { x: number; y: number; t: number } | null = null;
    for (let i = trail.length - 2; i >= 0; i--) {
      const e = trail[i];
      if (first && last.t - e.t > 2 * VELOCITY_WINDOW_MS) break;
      first = e;
      if (last.t - e.t >= VELOCITY_WINDOW_MS / 2) break;
    }
    const dt = first ? last.t - first.t : 0;
    if (!first || dt <= 0) return null;
    let vx = (last.x - first.x) / dt;
    let vy = (last.y - first.y) / dt;
    const max = this.moveRate(p) / MOVE_SPEED_TOLERANCE;
    const len = Math.hypot(vx, vy);
    if (len < 1e-3) return null;
    if (len > max) {
      vx *= max / len;
      vy *= max / len;
    }
    return { x: vx, y: vy };
  }

  /** Forget interest state (a new round, everyone teleported). */
  private resetInterest(): void {
    this.interest.clear();
  }

  /** A ghost on a living viewer's meeting card: who and dead, never where the ghost is floating. */
  private meetingGhostView(p: PlayerState, isRugger: boolean): PlayerView {
    const v = this.playerView(p, isRugger, false);
    const sp = SPAWN_POINTS[((p.slot % SPAWN_POINTS.length) + SPAWN_POINTS.length) % SPAWN_POINTS.length];
    v.x = sp.x;
    v.y = sp.y;
    v.facing = 1;
    v.moving = false;
    return v;
  }

  private playerView(p: PlayerState, isRugger: boolean, inVent: boolean): PlayerView {
    const v: PlayerView = {
      id: p.id,
      name: p.name,
      color: p.color,
      x: round1(p.x),
      y: round1(p.y),
      facing: p.facing,
      moving: p.moving && p.ventId === null,
      alive: p.alive,
      isBot: p.isBot,
    };
    if (p.wallet) v.wallet = p.wallet;
    if (isRugger) v.isRugger = true;
    if (inVent) v.inVent = true;
    if (!p.connected) v.disconnected = true;
    // Identical for every viewer, so it carries nothing about roles or who saw what.
    const cosmetics = this.cosmeticsOf(p);
    if (cosmetics) v.cosmetics = { ...cosmetics };
    if (this.ranked && this._phase === 'lobby' && p.address) v.hasTicket = ticketsOf(this.readProfile(p.address)) >= 1;
    return v;
  }

  // ---------- Profiles (cosmetics, ranked tickets) ----------

  /** A stored profile by full address through the injected hook; cached for the current tick. */
  private readProfile(address: string): RoomProfileLike | null {
    if (!this.profileOfFn) return null;
    const cache = this.profileCache;
    if (cache?.has(address)) return cache.get(address) ?? null;
    let profile: RoomProfileLike | null = null;
    try {
      profile = this.profileOfFn(address) ?? null;
    } catch (err) {
      this.log('profileOf threw', err);
    }
    cache?.set(address, profile);
    return profile;
  }

  /** What the player has equipped in the store right now (signed-in humans only). */
  private liveCosmetics(p: PlayerState): EquippedCosmetics | undefined {
    if (p.isBot || !p.address) return undefined;
    return equippedFrom(this.readProfile(p.address));
  }

  /** Lobby: live from the store, so equipping shows at once. In a round: frozen at game start. */
  private cosmeticsOf(p: PlayerState): EquippedCosmetics | undefined {
    return this._phase === 'lobby' ? this.liveCosmetics(p) : p.roundCosmetics;
  }

  private progressFor(viewer: PlayerState): number {
    if (this._phase === 'lobby') return 0;
    if (this.sabotage?.kind === 'rpcDown' && viewer.role === 'holder') return -1;
    return this.taskProgress();
  }

  private sabotageView(): SabotageView | null {
    const s = this.sabotage;
    if (!s) return null;
    const view: SabotageView = {
      kind: s.kind,
      stations: s.stations.map((id) =>
        s.kind === 'devDump' ? { id, fixed: false, holders: s.holds.get(id)?.size ?? 0 } : { id, fixed: false },
      ),
    };
    if (s.endsAt !== undefined) view.endsAt = s.endsAt;
    return view;
  }

  private meView(p: PlayerState): MeView {
    const me: MeView = {
      id: p.id,
      role: p.role,
      alive: p.alive,
      x: p.x,
      y: p.y,
      teleportSeq: p.teleportSeq,
      tasks: p.tasks.map((t) => ({ stationId: t.stationId, kind: t.kind, done: p.role === 'holder' && t.done })),
      activeStationId: p.activeStationId,
      emergencyLeft: p.emergencyLeft,
    };
    if (p.role === 'rugger') {
      me.killReadyAt = p.killReadyAt;
      me.sabotageReadyAt = this.sabotageReadyAt;
      me.ventId = p.ventId;
    }
    return me;
  }

  private meetingView(viewer: PlayerState, m: MeetingState): MeetingView {
    const v: MeetingView = {
      callerId: m.callerId,
      reason: m.reason,
      stage: m.stage,
      votedIds: [...m.votes.keys()],
    };
    if (m.bodyColor !== undefined) v.bodyColor = m.bodyColor;
    const mine = m.votes.get(viewer.id);
    if (mine !== undefined) v.myVote = mine;
    if (m.stage === 'results') {
      v.votes = Object.fromEntries(m.votes);
      v.ejectedId = m.ejectedId;
      v.tie = m.tie;
    }
    return v;
  }

  // ---------- Delivery helpers ----------

  private others(exceptId: string): PlayerState[] {
    return [...this.players.values()].filter((p) => p.id !== exceptId);
  }

  private livingCount(role: Role): number {
    let n = 0;
    for (const p of this.players.values()) if (p.alive && p.role === role) n++;
    return n;
  }

  private emit(event: GameEvent, to?: Iterable<PlayerState>): void {
    const targets = to ? [...to] : [...this.players.values()];
    for (const p of targets) this.safeSendOrQueue(p, event);
  }

  private safeSendOrQueue(p: PlayerState, event: GameEvent): void {
    if (p.isBot) this.queueBot(p.id, { type: 'event', event: { ...event } });
    else this.safeSend(p.id, { t: 'event', event });
  }

  private deliverChat(msg: ChatMessage, to: Iterable<PlayerState>): void {
    this.chatLog.push(msg);
    if (this.chatLog.length > CHAT_LOG_MAX) this.chatLog.shift();
    for (const p of to) {
      if (p.isBot) this.queueBot(p.id, { type: 'chat', msg: { ...msg } });
      // A seat that is offline gets the line from the chat log when it rejoins.
      else if (p.connected) this.safeSend(p.id, msg);
    }
  }

  /**
   * Replay the chat log to a player who just joined or rejoined (a reloaded client starts empty), by
   * visibility at replay time: lobby, system and meeting lines for everyone, ghost lines for the dead.
   * Lines the client already has come again unchanged, so it can drop them by (ts, fromId, channel, text).
   */
  sendChatBacklogTo(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p || p.isBot) return;
    for (const msg of this.chatLog) if (msg.channel !== 'ghost' || !p.alive) this.safeSend(p.id, msg);
  }

  private system(text: string, color: number = SYSTEM_COLOR): void {
    const msg: ChatMessage = { t: 'chat', channel: 'system', fromId: null, fromName: 'SYSTEM', color, text, ts: this.now() };
    this.deliverChat(msg, this.players.values());
  }

  private queueBot(id: string, item: BotInbox): void {
    const entry = this.bots.get(id);
    if (!entry || !entry.brain) return;
    if (entry.inbox.length >= BOT_QUEUE_MAX) entry.inbox.shift();
    entry.inbox.push(item);
  }

  private err(p: PlayerState, code: ErrorCode, message: string): void {
    if (p.isBot) return;
    this.safeSend(p.id, { t: 'error', code, message });
  }

  private safeSend(playerId: string, msg: S2C): void {
    try {
      this.sendFn(playerId, msg);
    } catch (err) {
      this.log(`send to ${playerId} failed`, err);
    }
  }

  private createPlayer(isBot: boolean, name: string): PlayerState {
    const now = this.now();
    let id: string;
    do id = `${isBot ? 'b' : 'p'}_${randomBytes(6).toString('hex')}`;
    while (this.players.has(id));
    const slot = this.players.size;
    const sp = SPAWN_POINTS[slot % SPAWN_POINTS.length];
    return {
      id,
      sessionKey: isBot ? randomBytes(8).toString('hex') : randomBytes(18).toString('base64url'),
      isBot,
      joinSeq: this.joinCounter++,
      botIndex: -1,
      name,
      color: this.firstFreeColor(),
      connected: true,
      disconnectedAt: null,
      role: 'holder',
      alive: true,
      slot,
      x: sp.x,
      y: sp.y,
      facing: 1,
      moving: false,
      lastMoveAt: now,
      lastMoveMsgAt: -Infinity,
      moveBudget: MOVE_SLACK_PX,
      budgetAt: now,
      trail: [],
      teleportSeq: 0,
      tasks: [],
      activeStationId: null,
      openedAt: 0,
      killReadyAt: 0,
      ventId: null,
      emergencyLeft: this._settings.emergencyMeetings,
      lastChatAt: -Infinity,
      stats: freshStats(),
      roundCosmetics: undefined,
    };
  }

  private firstFreeColor(): number {
    const taken = new Set<number>();
    for (const p of this.players.values()) taken.add(p.color);
    for (let i = 0; i < PLAYER_COLORS.length; i++) if (!taken.has(i)) return i;
    return 0;
  }
}
