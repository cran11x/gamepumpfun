// RoomManager: room registry, connection <-> seat binding, create / join / quick play / rejoin,
// cleanup of empty rooms and the single global tick loop that drives every Room at SERVER_TICK_HZ.

import { randomInt } from 'node:crypto';
import { DEFAULT_TICKER, ROOM_CODE_LENGTH, SERVER_TICK_HZ } from '../shared/constants';
import type { C2S, ErrorCode, S2C } from '../shared/protocol';
import { RateLimiter } from './api';
import { resolveAuthToken } from './auth';
import { BotBrain, botName } from './bots';
import { getPublicConfig } from './config';
import { Room, type WalletIdentity } from './game';
import { recordGameResults } from './store';

/** SPEC: 4 letters from this alphabet (no I or O). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Hard cap so a flood of sockets cannot allocate unbounded rooms. */
const MAX_ROOMS = 5000;
/** Minimum spacing between create / join / quick from one connection. */
const JOIN_COOLDOWN_MS = 250;
/**
 * Failed joins (a code with no room) allowed per client IP per window. Past that, join answers
 * RATE_LIMITED until the window ends, so private codes can't be swept. Rejoin is not limited: every
 * failed rejoin gets the same REJOIN_FAILED, so it reveals nothing, and the client must hear that
 * answer to drop its stale session.
 */
const LOOKUP_FAIL_LIMIT = 30;
const LOOKUP_FAIL_WINDOW_MS = 60_000;
/** Same text for every failed rejoin: whether the room exists must not show. */
const REJOIN_FAILED_MSG = 'Could not restore your seat';
const LOOKUP_BLOCKED_MSG = 'Too many attempts. Try again in a minute.';

export interface Binding {
  code: string;
  playerId: string;
}

/** One client connection (a WebSocket in production, anything with `send` in tests). */
export interface Conn {
  send(msg: S2C): void;
  /** The seat this connection controls, managed by RoomManager. */
  binding: Binding | null;
  /** Last create/join/quick time (anti-churn), managed by RoomManager. */
  lastJoinAt: number;
  /** Client key for per-IP limits (server/api.ts `clientKey`). Connections without one share 'local'. */
  readonly ip?: string;
}

export interface RoomManagerOptions {
  now?: () => number;
  rng?: () => number;
  log?: (message: string, err?: unknown) => void;
}

const seatKey = (code: string, playerId: string) => `${code}:${playerId}`;

/** Uppercase, trimmed and restricted to the code alphabet; null if it can't be a room code. */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** seatKey -> the connection currently driving that seat. */
  private readonly seats = new Map<string, Conn>();
  private readonly conns = new Set<Conn>();
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly log: (message: string, err?: unknown) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Failed room lookups per client IP, and IPs blocked from lookups until a time. */
  private readonly lookupFails: RateLimiter;
  private readonly lookupBlockedUntil = new Map<string, number>();
  /**
   * The seat whose chat backlog a connection already got. A client only rejoins on a fresh socket, so a
   * repeat on the same one (a join or rejoin loop) gets no second ~100-line replay.
   */
  private readonly backlogSent = new WeakMap<Conn, string>();

  constructor(opts: RoomManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    this.log = opts.log ?? ((m, e) => console.error(`[rooms] ${m}`, e ?? ''));
    this.lookupFails = new RateLimiter(LOOKUP_FAIL_LIMIT, LOOKUP_FAIL_WINDOW_MS, 50_000, this.now);
  }

  // ---------- Lifecycle ----------

  /** Start the one global tick loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), Math.round(1000 / SERVER_TICK_HZ));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const code of [...this.rooms.keys()]) this.destroy(code);
  }

  /** Tick every room; destroy the ones with no humans left. */
  tick(): void {
    for (const room of [...this.rooms.values()]) {
      try {
        room.tick();
      } catch (err) {
        this.log(`room ${room.code} tick crashed`, err);
      }
      if (room.shouldDestroy()) this.destroy(room.code);
    }
  }

  getRoomsInfo(): { publicLobbies: number; playersOnline: number } {
    let publicLobbies = 0;
    for (const room of this.rooms.values()) if (room.isPublicLobby) publicLobbies++;
    return { publicLobbies, playersOnline: this.conns.size };
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  // ---------- Connections ----------

  connect(conn: Conn): void {
    this.conns.add(conn);
  }

  /** Socket closed: the seat (if any) enters the reconnect grace window. */
  disconnect(conn: Conn): void {
    this.conns.delete(conn);
    const b = conn.binding;
    conn.binding = null;
    if (!b) return;
    const key = seatKey(b.code, b.playerId);
    if (this.seats.get(key) !== conn) return; // superseded by a newer connection
    this.seats.delete(key);
    this.rooms.get(b.code)?.setDisconnected(b.playerId);
  }

  /** Route one validated client message. */
  handleMessage(conn: Conn, msg: C2S): void {
    switch (msg.t) {
      case 'ping':
        conn.send({ t: 'pong', ts: msg.ts, serverNow: this.now() });
        return;
      case 'create':
        this.create(conn, msg.name, msg.authToken);
        return;
      case 'join':
        this.join(conn, msg.code, msg.name, msg.authToken);
        return;
      case 'quick':
        this.quick(conn, msg.name, msg.authToken);
        return;
      case 'rejoin':
        this.rejoin(conn, msg.code, msg.playerId, msg.sessionKey);
        return;
      case 'leave':
        this.leave(conn);
        return;
      default: {
        const b = conn.binding;
        if (!b) return;
        const room = this.rooms.get(b.code);
        if (!room || this.seats.get(seatKey(b.code, b.playerId)) !== conn) {
          conn.binding = null;
          return;
        }
        room.handle(b.playerId, msg);
      }
    }
  }

  // ---------- Create / join / quick / rejoin / leave ----------

  private create(conn: Conn, name: string, authToken?: string): void {
    if (!this.joinAllowed(conn)) return;
    if (this.rooms.size >= MAX_ROOMS) return this.error(conn, 'INVALID_ACTION', 'Server is full, try again soon');
    this.leave(conn);
    this.seat(conn, this.createRoom(false), name, authToken);
  }

  private join(conn: Conn, rawCode: string, name: string, authToken?: string): void {
    if (!this.joinAllowed(conn)) return;
    // Whether a join works shows whether the room exists, so a blocked IP gets no answer at all.
    if (this.lookupBlocked(conn)) return this.error(conn, 'RATE_LIMITED', LOOKUP_BLOCKED_MSG);
    const code = normalizeRoomCode(rawCode);
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) {
      if (this.lookupFailed(conn)) return this.error(conn, 'RATE_LIMITED', LOOKUP_BLOCKED_MSG);
      return this.error(conn, 'ROOM_NOT_FOUND', 'No room with that code');
    }
    const b = conn.binding;
    if (b && b.code === room.code && this.seats.get(seatKey(b.code, b.playerId)) === conn && room.getPlayer(b.playerId)) {
      // Already seated here: just re-send the welcome.
      this.welcome(conn, room, b.playerId);
      return;
    }
    // Check before leaving the current room so a failed join doesn't kick you out of yours.
    if (room.phase !== 'lobby') return this.error(conn, 'GAME_IN_PROGRESS', 'That game already started');
    if (room.isFull) return this.error(conn, 'ROOM_FULL', 'Room is full');
    this.leave(conn);
    this.seat(conn, room, name, authToken);
  }

  /** Join the public lobby with the most players, or create a new public room. */
  private quick(conn: Conn, name: string, authToken?: string): void {
    if (!this.joinAllowed(conn)) return;
    const current = conn.binding?.code;
    let best: Room | undefined;
    for (const room of this.rooms.values()) {
      if (room.code === current || !room.isPublicLobby) continue;
      if (!best || room.playerCount > best.playerCount || (room.playerCount === best.playerCount && room.createdAt < best.createdAt)) {
        best = room;
      }
    }
    if (!best && this.rooms.size >= MAX_ROOMS) return this.error(conn, 'INVALID_ACTION', 'Server is full, try again soon');
    this.leave(conn);
    this.seat(conn, best ?? this.createRoom(true), name, authToken);
  }

  private rejoin(conn: Conn, rawCode: string, playerId: string, sessionKey: string): void {
    // A missing room and a wrong seat/key must look the same (same error, no side effects), or rejoin
    // becomes an oracle for private room codes. That holds for a blocked IP too, so a failed rejoin is
    // always REJOIN_FAILED (the client then forgets the stale session), and a valid seat key always
    // works: only its owner can have it, so success reveals nothing to a prober.
    const code = normalizeRoomCode(rawCode);
    const room = code ? this.rooms.get(code) : undefined;
    const player = room ? room.rejoin(playerId, sessionKey) : null;
    if (!room || !player) return this.error(conn, 'REJOIN_FAILED', REJOIN_FAILED_MSG);
    const b = conn.binding;
    if (b && (b.code !== room.code || b.playerId !== playerId)) this.leave(conn);
    const key = seatKey(room.code, playerId);
    const previous = this.seats.get(key);
    if (previous && previous !== conn) {
      // Another tab/socket held this seat: hand it over and tell the old one to forget the session.
      previous.binding = null;
      this.backlogSent.delete(previous);
      try {
        previous.send({ t: 'error', code: 'REJOIN_FAILED', message: 'Your seat was opened somewhere else' });
      } catch {
        /* old socket already gone */
      }
    }
    this.bind(conn, room.code, playerId);
    this.welcome(conn, room, playerId);
  }

  /** Leave the current room (if any). In-game this removes the player immediately. */
  private leave(conn: Conn): void {
    const b = conn.binding;
    if (!b) return;
    conn.binding = null;
    this.backlogSent.delete(conn);
    const key = seatKey(b.code, b.playerId);
    if (this.seats.get(key) !== conn) return;
    this.seats.delete(key);
    const room = this.rooms.get(b.code);
    if (!room) return;
    room.leave(b.playerId);
    if (room.shouldDestroy()) this.destroy(room.code);
  }

  private seat(conn: Conn, room: Room, name: string, authToken?: string): void {
    const res = room.addHuman({ name, wallet: this.resolveWallet(authToken) });
    if (!res.ok) {
      this.error(conn, res.code, res.message);
      if (room.shouldDestroy()) this.destroy(room.code);
      return;
    }
    this.bind(conn, room.code, res.player.id);
    this.welcome(conn, room, res.player.id);
  }

  private welcome(conn: Conn, room: Room, playerId: string): void {
    const p = room.getPlayer(playerId);
    if (!p) return;
    conn.send({ t: 'welcome', playerId, sessionKey: p.sessionKey, code: room.code });
    // The visible chat backlog goes before the first snapshot, so the screen that snapshot opens has it.
    const key = seatKey(room.code, playerId);
    if (this.backlogSent.get(conn) !== key) {
      this.backlogSent.set(conn, key);
      room.sendChatBacklogTo(playerId);
    }
    room.sendSnapshotTo(playerId);
  }

  // ---------- Internals ----------

  private createRoom(forcePublic: boolean): Room {
    const code = this.newCode();
    const room = new Room({
      code,
      now: this.now,
      rng: this.rng,
      send: (playerId, msg) => this.sendTo(code, playerId, msg),
      ticker: this.ticker(),
      settings: forcePublic ? { isPublic: true } : undefined,
      createBotBrain: (init) => new BotBrain(init),
      botName: (i) => botName(i),
      recordResults: (records) => recordGameResults(records),
      onPlayerRemoved: (playerId) => this.unbind(code, playerId),
      log: (m, e) => this.log(`room ${code}: ${m}`, e),
    });
    this.rooms.set(code, room);
    return room;
  }

  private destroy(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.dispose();
    this.rooms.delete(code);
    const prefix = `${code}:`;
    for (const [key, conn] of [...this.seats]) {
      if (!key.startsWith(prefix)) continue;
      this.seats.delete(key);
      if (conn.binding?.code === code) conn.binding = null;
    }
  }

  private bind(conn: Conn, code: string, playerId: string): void {
    conn.binding = { code, playerId };
    this.seats.set(seatKey(code, playerId), conn);
  }

  /** The room removed a player (left, kicked, grace expired): forget their socket. */
  private unbind(code: string, playerId: string): void {
    const key = seatKey(code, playerId);
    const conn = this.seats.get(key);
    if (!conn) return;
    this.seats.delete(key);
    this.backlogSent.delete(conn);
    if (conn.binding && conn.binding.code === code && conn.binding.playerId === playerId) conn.binding = null;
  }

  private sendTo(code: string, playerId: string, msg: S2C): void {
    const conn = this.seats.get(seatKey(code, playerId));
    if (!conn) return;
    try {
      conn.send(msg);
    } catch (err) {
      this.log(`send to ${playerId} failed`, err);
    }
  }

  private lookupBlocked(conn: Conn): boolean {
    const ip = conn.ip ?? 'local';
    const until = this.lookupBlockedUntil.get(ip);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.lookupBlockedUntil.delete(ip);
    return false;
  }

  /**
   * Count a failed room lookup. Past the limit the IP is blocked until its window ends, and true is
   * returned so this failure is already answered RATE_LIMITED.
   */
  private lookupFailed(conn: Conn): boolean {
    const ip = conn.ip ?? 'local';
    const retryMs = this.lookupFails.take(ip);
    if (retryMs <= 0) return false;
    const now = this.now();
    if (this.lookupBlockedUntil.size >= 10_000) {
      for (const [k, until] of this.lookupBlockedUntil) if (until <= now) this.lookupBlockedUntil.delete(k);
    }
    this.lookupBlockedUntil.set(ip, now + retryMs);
    return true;
  }

  private joinAllowed(conn: Conn): boolean {
    const now = this.now();
    if (now - conn.lastJoinAt < JOIN_COOLDOWN_MS) {
      this.error(conn, 'RATE_LIMITED', 'Slow down');
      return false;
    }
    conn.lastJoinAt = now;
    return true;
  }

  private error(conn: Conn, code: ErrorCode, message: string): void {
    try {
      conn.send({ t: 'error', code, message });
    } catch {
      /* socket gone */
    }
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('room code space exhausted');
  }

  private resolveWallet(authToken?: string): WalletIdentity | null {
    if (!authToken) return null;
    try {
      const profile = resolveAuthToken(authToken);
      if (!profile || typeof profile.address !== 'string' || !profile.address) return null;
      return { name: typeof profile.name === 'string' ? profile.name : '', address: profile.address };
    } catch (err) {
      this.log('resolveAuthToken threw', err);
      return null;
    }
  }

  private ticker(): string {
    try {
      const t = getPublicConfig().ticker;
      return typeof t === 'string' && t.trim() ? t.trim() : DEFAULT_TICKER;
    } catch (err) {
      this.log('getPublicConfig threw', err);
      return DEFAULT_TICKER;
    }
  }
}
