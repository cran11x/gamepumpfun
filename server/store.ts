// Wallet profiles, lifetime stats and login sessions, persisted to a single JSON file.
//
// - File: path.join(DATA_DIR || './data', 'db.json'), read lazily on first use.
// - Everything lives in memory and every export is synchronous.
// - Changes are written at most once per SAVE_DEBOUNCE_MS, atomically (tmp file + fsync + rename),
//   and flushed synchronously on SIGINT / SIGTERM / process exit.
// - Session tokens are never stored: the file only holds their SHA-256 hashes, so a leaked
//   db.json cannot be used to sign in as anyone.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_NAME_LENGTH } from '../shared/constants';
import { shortAddress, type LeaderboardEntry, type PlayerStats, type Profile, type Role } from '../shared/protocol';
import { isSolanaAddress } from './config';

export interface GameResultRecord {
  address: string; // full wallet address
  role: Role;
  won: boolean;
  rugs: number; // kills this game
  tasksDone: number;
  correctVotes: number; // votes cast for a rugger who was ejected by that vote
  wasRugged: boolean;
}

export type LeaderboardSort = 'wins' | 'ruggerWins' | 'holderWins' | 'rugs' | 'correctVotes';
export const LEADERBOARD_SORTS: readonly LeaderboardSort[] = ['wins', 'ruggerWins', 'holderWins', 'rugs', 'correctVotes'];

export function isLeaderboardSort(value: unknown): value is LeaderboardSort {
  return typeof value === 'string' && (LEADERBOARD_SORTS as readonly string[]).includes(value);
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LEADERBOARD_MAX_LIMIT = 100;
const SAVE_DEBOUNCE_MS = 1000;
const SAVE_RETRY_MS = 5000;
const MAX_SESSIONS_PER_ADDRESS = 10;
const MAX_SESSIONS = 200_000;
const MAX_PROFILES = 250_000;
/** Per-game sanity cap for counters coming from the game (guards the totals against garbage). */
const MAX_PER_GAME = 1000;
const DB_VERSION = 1;

const STAT_KEYS = [
  'gamesPlayed',
  'wins',
  'holderWins',
  'ruggerWins',
  'rugs',
  'timesRugged',
  'tasksDone',
  'correctVotes',
] as const satisfies readonly (keyof PlayerStats)[];
// Compile-time check that STAT_KEYS lists every PlayerStats field.
type MissingStatKey = Exclude<keyof PlayerStats, (typeof STAT_KEYS)[number]>;
const _allStatKeysListed: MissingStatKey extends never ? true : never = true;
void _allStatKeysListed;

interface StoredProfile {
  address: string;
  name: string;
  stats: PlayerStats;
  createdAt: number;
  /** Last time a game result was recorded (leaderboard tie-break; never sent to clients). */
  lastPlayedAt: number;
}

interface StoredSession {
  address: string;
  createdAt: number;
  expiresAt: number;
}

interface DbFile {
  version: number;
  profiles: Record<string, StoredProfile>;
  /** Keyed by sha256(token) in hex. */
  sessions: Record<string, StoredSession>;
}

/** Thrown by upsertProfile when the store is full of active profiles. */
export class StoreFullError extends Error {
  constructor() {
    super('Profile store is full');
    this.name = 'StoreFullError';
  }
}

// ---------- In-memory state ----------

interface State {
  file: string;
  profiles: Map<string, StoredProfile>;
  sessions: Map<string, StoredSession>;
  /** address -> session hashes, for the per-address cap and fast purges. */
  sessionsByAddress: Map<string, Set<string>>;
}

let state: State | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hooksInstalled = false;
/** Bumped on every mutation that can change the leaderboard. */
let revision = 0;
const leaderboardCache = new Map<LeaderboardSort, { revision: number; entries: LeaderboardEntry[] }>();

function dbPath(): string {
  return path.resolve(process.env.DATA_DIR || './data', 'db.json');
}

function emptyStats(): PlayerStats {
  return { gamesPlayed: 0, wins: 0, holderWins: 0, ruggerWins: 0, rugs: 0, timesRugged: 0, tasksDone: 0, correctVotes: 0 };
}

function toCount(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(max, Math.floor(v));
}

function normalizeStats(raw: unknown): PlayerStats {
  const stats = emptyStats();
  if (raw && typeof raw === 'object') {
    const src = raw as Record<string, unknown>;
    for (const key of STAT_KEYS) stats[key] = toCount(src[key]);
  }
  return stats;
}

function toProfile(p: StoredProfile): Profile {
  return { address: p.address, name: p.name, stats: { ...p.stats }, createdAt: p.createdAt };
}

// ---------- Names ----------

/**
 * Control characters plus invisible / direction-changing code points (zero-width spaces and
 * joiners, bidi overrides and isolates, BOM, Hangul fillers...). Same policy as room names.
 */
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]/g;
/** Collapse "zalgo" stacks: keep at most 3 combining marks in a row. */
const MARK_STACK = /(\p{M}{3})\p{M}+/gu;

/** Trimmed, control characters stripped, at most MAX_NAME_LENGTH code points. May return ''. */
export function sanitizeProfileName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .slice(0, 512)
    .replace(/[\t\n\r\v\f]/g, ' ')
    .replace(INVISIBLE, '')
    .replace(MARK_STACK, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
  const cps = Array.from(cleaned);
  return cps.length > MAX_NAME_LENGTH ? cps.slice(0, MAX_NAME_LENGTH).join('').trim() : cleaned;
}

function defaultName(address: string): string {
  return shortAddress(address);
}

// ---------- Loading ----------

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseDb(raw: unknown, now: number): Omit<State, 'file'> {
  const profiles = new Map<string, StoredProfile>();
  const sessions = new Map<string, StoredSession>();
  const sessionsByAddress = new Map<string, Set<string>>();
  if (!raw || typeof raw !== 'object') throw new Error('db root is not an object');
  const db = raw as Partial<DbFile>;

  if (db.profiles && typeof db.profiles === 'object') {
    for (const [address, value] of Object.entries(db.profiles)) {
      if (!isSolanaAddress(address) || !value || typeof value !== 'object') continue;
      const v = value as Partial<StoredProfile>;
      const name = sanitizeProfileName(v.name) || defaultName(address);
      const createdAt = toCount(v.createdAt) || now;
      profiles.set(address, {
        address,
        name,
        stats: normalizeStats(v.stats),
        createdAt,
        lastPlayedAt: toCount(v.lastPlayedAt),
      });
    }
  }

  if (db.sessions && typeof db.sessions === 'object') {
    for (const [hash, value] of Object.entries(db.sessions)) {
      if (!/^[0-9a-f]{64}$/.test(hash) || !value || typeof value !== 'object') continue;
      const v = value as Partial<StoredSession>;
      if (typeof v.address !== 'string' || !profiles.has(v.address)) continue;
      const expiresAt = toCount(v.expiresAt);
      if (expiresAt <= now) continue;
      sessions.set(hash, { address: v.address, createdAt: toCount(v.createdAt) || now, expiresAt });
      let set = sessionsByAddress.get(v.address);
      if (!set) sessionsByAddress.set(v.address, (set = new Set()));
      set.add(hash);
    }
  }
  return { profiles, sessions, sessionsByAddress };
}

/** Remove tmp files left behind by a crash mid-write. */
function removeStaleTmpFiles(file: string): void {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* not ours or already gone */
    }
  }
}

function load(): State {
  if (state) return state;
  const file = dbPath();
  const now = Date.now();
  let loaded: Omit<State, 'file'> = { profiles: new Map(), sessions: new Map(), sessionsByAddress: new Map() };
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Unreadable (permissions, EISDIR...): refuse to start from scratch and later overwrite it.
      throw new Error(`[store] cannot read ${file}: ${(err as Error).message}`);
    }
  }
  if (text !== null && text.trim() !== '') {
    try {
      loaded = parseDb(JSON.parse(text), now);
    } catch (err) {
      // Keep the broken file for manual recovery and start fresh.
      const backup = `${file}.corrupt-${now}`;
      try {
        fs.renameSync(file, backup);
        console.error(`[store] ${file} is corrupt (${(err as Error).message}); moved it to ${backup} and starting empty.`);
      } catch (renameErr) {
        throw new Error(`[store] ${file} is corrupt and could not be moved aside: ${(renameErr as Error).message}`);
      }
    }
  }
  removeStaleTmpFiles(file);
  state = { file, ...loaded };
  revision++;
  installExitHooks();
  return state;
}

// ---------- Saving ----------

function serialize(s: State): string {
  const db: DbFile = { version: DB_VERSION, profiles: {}, sessions: {} };
  for (const [address, p] of s.profiles) db.profiles[address] = p;
  for (const [hash, sess] of s.sessions) db.sessions[hash] = sess;
  return JSON.stringify(db);
}

let tmpSeq = 0;

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    const buf = Buffer.from(data, 'utf8');
    let offset = 0;
    while (offset < buf.length) offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function purgeExpiredSessions(s: State, now: number): void {
  for (const [hash, sess] of s.sessions) if (sess.expiresAt <= now) removeSession(s, hash);
}

/** Write pending changes now (synchronously). Safe to call at any time; a no-op when clean. */
export function flushStore(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!state || !dirty) return;
  purgeExpiredSessions(state, Date.now());
  const data = serialize(state);
  try {
    writeAtomic(state.file, data);
    dirty = false;
  } catch (err) {
    console.error(`[store] failed to write ${state.file}:`, (err as Error).message);
    scheduleSave(SAVE_RETRY_MS);
  }
}

function scheduleSave(delay = SAVE_DEBOUNCE_MS): void {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushStore();
  }, delay);
  // Never keep the process alive just for a pending save; the exit hook writes it.
  saveTimer.unref?.();
}

function markChanged(affectsLeaderboard: boolean): void {
  if (affectsLeaderboard) revision++;
  scheduleSave();
}

function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', () => flushStore());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    // Run before other handlers (e.g. server/index.ts graceful shutdown), flush, and if nobody
    // else handles the signal, re-raise it so the default "terminate" behavior still happens.
    process.prependOnceListener(signal, () => {
      flushStore();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

/**
 * Drop all in-memory state WITHOUT saving and forget the loaded file, so the next call loads
 * from the current DATA_DIR again. Intended for tests.
 */
export function resetStore(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  state = null;
  revision++;
  leaderboardCache.clear();
}

// ---------- Profiles ----------

export function getProfile(address: string): Profile | null {
  if (typeof address !== 'string') return null;
  const p = load().profiles.get(address);
  return p ? toProfile(p) : null;
}

/** Evict never-played profiles without a live session to make room. Returns true when space was made. */
function evictIdleProfiles(s: State, now: number): boolean {
  purgeExpiredSessions(s, now);
  let removed = 0;
  for (const [address, p] of s.profiles) {
    if (p.stats.gamesPlayed > 0 || s.sessionsByAddress.has(address)) continue;
    s.profiles.delete(address);
    if (++removed >= 1000) break;
  }
  if (removed > 0) markChanged(true);
  return removed > 0;
}

/** Get or create the profile for a verified wallet address. New profiles are named after the short address. */
export function upsertProfile(address: string, now: number = Date.now()): Profile {
  if (!isSolanaAddress(address)) throw new TypeError('invalid wallet address');
  const s = load();
  const existing = s.profiles.get(address);
  if (existing) return toProfile(existing);
  if (s.profiles.size >= MAX_PROFILES && !evictIdleProfiles(s, now)) throw new StoreFullError();
  const p: StoredProfile = { address, name: defaultName(address), stats: emptyStats(), createdAt: now, lastPlayedAt: 0 };
  s.profiles.set(address, p);
  markChanged(false);
  return toProfile(p);
}

/**
 * Set a profile's display name (sanitized). An empty name after sanitizing resets it to the
 * short address. Returns the updated profile, or null when there is no profile for `address`.
 */
export function setProfileName(address: string, name: string): Profile | null {
  const p = typeof address === 'string' ? load().profiles.get(address) : undefined;
  if (!p) return null;
  const next = sanitizeProfileName(name) || defaultName(address);
  if (next !== p.name) {
    p.name = next;
    markChanged(true);
  }
  return toProfile(p);
}

/** Add one finished game to each wallet's lifetime stats. Invalid records are skipped. */
export function recordGameResults(results: GameResultRecord[], now: number = Date.now()): void {
  if (!Array.isArray(results) || results.length === 0) return;
  const s = load();
  const seen = new Set<string>();
  let changed = false;
  for (const r of results) {
    if (!r || typeof r !== 'object' || !isSolanaAddress(r.address) || seen.has(r.address)) continue;
    if (r.role !== 'holder' && r.role !== 'rugger') continue;
    seen.add(r.address);
    let p = s.profiles.get(r.address);
    if (!p) {
      // Normally the profile exists (players sign in first); create it so a result is never lost.
      p = { address: r.address, name: defaultName(r.address), stats: emptyStats(), createdAt: now, lastPlayedAt: 0 };
      s.profiles.set(r.address, p);
    }
    const st = p.stats;
    st.gamesPlayed += 1;
    if (r.won === true) {
      st.wins += 1;
      if (r.role === 'holder') st.holderWins += 1;
      else st.ruggerWins += 1;
    }
    st.rugs += toCount(r.rugs, MAX_PER_GAME);
    st.tasksDone += toCount(r.tasksDone, MAX_PER_GAME);
    st.correctVotes += toCount(r.correctVotes, MAX_PER_GAME);
    if (r.wasRugged === true) st.timesRugged += 1;
    p.lastPlayedAt = now;
    changed = true;
  }
  if (changed) markChanged(true);
}

/**
 * Top players by `sort` (descending). Only wallets that have played at least one game are listed.
 * Ties: more wins, then fewer games played, then whoever reached it first (earlier last game),
 * then address for a stable order.
 */
export function getLeaderboard(sort: LeaderboardSort = 'wins', limit = 50): LeaderboardEntry[] {
  const key: LeaderboardSort = isLeaderboardSort(sort) ? sort : 'wins';
  const n = Math.max(1, Math.min(LEADERBOARD_MAX_LIMIT, Math.floor(Number.isFinite(limit) ? limit : 50)));
  const s = load();
  let cached = leaderboardCache.get(key);
  if (!cached || cached.revision !== revision) {
    const ranked = [...s.profiles.values()]
      .filter((p) => p.stats.gamesPlayed > 0)
      .sort(
        (a, b) =>
          b.stats[key] - a.stats[key] ||
          b.stats.wins - a.stats.wins ||
          a.stats.gamesPlayed - b.stats.gamesPlayed ||
          a.lastPlayedAt - b.lastPlayedAt ||
          (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
      )
      .slice(0, LEADERBOARD_MAX_LIMIT)
      .map((p) => ({ address: p.address, shortAddress: shortAddress(p.address), name: p.name, stats: { ...p.stats } }));
    cached = { revision, entries: ranked };
    leaderboardCache.set(key, cached);
  }
  return cached.entries.slice(0, n).map((e) => ({ ...e, stats: { ...e.stats } }));
}

// ---------- Sessions (used by server/auth.ts) ----------

function removeSession(s: State, hash: string): void {
  const sess = s.sessions.get(hash);
  if (!sess) return;
  s.sessions.delete(hash);
  const set = s.sessionsByAddress.get(sess.address);
  if (set) {
    set.delete(hash);
    if (set.size === 0) s.sessionsByAddress.delete(sess.address);
  }
  dirty = true;
}

/** Create a login session. Returns a random 32-byte hex token valid for 30 days. */
export function createSession(address: string, now: number = Date.now()): string {
  const s = load();
  if (!s.profiles.has(address)) throw new Error('createSession: unknown profile');
  const token = randomBytes(32).toString('hex');
  const hash = hashToken(token);

  // Per-address cap: drop the oldest sessions of this wallet.
  let set = s.sessionsByAddress.get(address);
  if (!set) s.sessionsByAddress.set(address, (set = new Set()));
  if (set.size >= MAX_SESSIONS_PER_ADDRESS) {
    const oldest = [...set]
      .map((h) => ({ h, at: s.sessions.get(h)?.createdAt ?? 0 }))
      .sort((a, b) => a.at - b.at)
      .slice(0, set.size - MAX_SESSIONS_PER_ADDRESS + 1);
    for (const { h } of oldest) removeSession(s, h);
    set = s.sessionsByAddress.get(address) ?? new Set();
    s.sessionsByAddress.set(address, set);
  }
  // Global cap: purge expired ones, then the oldest (Map keeps insertion order).
  if (s.sessions.size >= MAX_SESSIONS) {
    purgeExpiredSessions(s, now);
    for (const h of s.sessions.keys()) {
      if (s.sessions.size < MAX_SESSIONS) break;
      removeSession(s, h);
    }
    set = s.sessionsByAddress.get(address) ?? new Set();
    s.sessionsByAddress.set(address, set);
  }

  s.sessions.set(hash, { address, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  set.add(hash);
  markChanged(false);
  return token;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Wallet address for a live session token, or null (unknown, malformed or expired). */
export function getSessionAddress(token: string, now: number = Date.now()): string | null {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const s = load();
  const hash = hashToken(token);
  const sess = s.sessions.get(hash);
  if (!sess) return null;
  if (sess.expiresAt <= now) {
    removeSession(s, hash);
    scheduleSave();
    return null;
  }
  return sess.address;
}

/** Revoke a session token. Returns true when it existed. */
export function deleteSession(token: string): boolean {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  const s = load();
  const hash = hashToken(token);
  if (!s.sessions.has(hash)) return false;
  removeSession(s, hash);
  scheduleSave();
  return true;
}
