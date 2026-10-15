// Wallet profiles, lifetime stats, login sessions, token burns, cosmetics, ranked tickets and weekly
// ranked stats, persisted to a single JSON file.
//
// - File: path.join(DATA_DIR || './data', 'db.json'), read lazily on first use.
// - Everything lives in memory and every export is synchronous.
// - Changes are written at most once per SAVE_DEBOUNCE_MS, atomically (tmp file + fsync + rename +
//   directory fsync), and flushed synchronously on SIGINT / SIGTERM / process exit.
// - Session tokens are never stored: the file only holds their SHA-256 hashes, so a leaked
//   db.json cannot be used to sign in as anyone.
// - Burns: every granted burn is kept forever, keyed by its transaction signature, so a signature can
//   only ever pay for one purchase. A grant (signature record + ticket / cosmetic + burn log) is one
//   synchronous step and lands in the same atomic write.
// - Version 1 files (before burns) load fine: profiles get no cosmetics and no tickets. A file written
//   by a NEWER version is refused instead of being silently downgraded.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_NAME_LENGTH, MAX_PLAYERS, RANKED_POINTS, SETTINGS_BOUNDS } from '../shared/constants';
import { COSMETICS, COSMETIC_SLOTS, cosmeticById, isCosmeticForSlot, type CosmeticSlot } from '../shared/cosmetics';
import {
  shortAddress,
  type BurnPurpose,
  type EquippedCosmetics,
  type LeaderboardEntry,
  type PlayerStats,
  type Profile,
  type RankedEntry,
  type RankedLeaderboard,
  type Role,
} from '../shared/protocol';
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

export interface RankedResultRecord {
  address: string;
  role: Role;
  won: boolean;
  rugs: number;
  tasksDone: number;
  correctVotes: number;
  /** Alive at the end. Only pays RANKED_POINTS.survived to a holder in a game the holders won. */
  survived: boolean;
  /** Removed before the end: RANKED_POINTS.leftEarly replaces everything else. */
  leftEarly: boolean;
}

export type LeaderboardSort = 'wins' | 'ruggerWins' | 'holderWins' | 'rugs' | 'correctVotes';
export const LEADERBOARD_SORTS: readonly LeaderboardSort[] = ['wins', 'ruggerWins', 'holderWins', 'rugs', 'correctVotes'];

export function isLeaderboardSort(value: unknown): value is LeaderboardSort {
  return typeof value === 'string' && (LEADERBOARD_SORTS as readonly string[]).includes(value);
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LEADERBOARD_MAX_LIMIT = 100;
/** Ranked leaderboard size (SPEC: top 50). */
export const RANKED_LEADERBOARD_SIZE = 50;
/** Unused ranked tickets one wallet can hold. */
export const MAX_RANKED_TICKETS = 10_000;
const SAVE_DEBOUNCE_MS = 1000;
const SAVE_RETRY_MS = 5000;
const MAX_SESSIONS_PER_ADDRESS = 10;
const MAX_SESSIONS = 200_000;
const MAX_PROFILES = 250_000;
/** Per-game sanity cap for counters coming from the game (guards the totals against garbage). */
const MAX_PER_GAME = 1000;
/** Weekly ranked stats are kept for this many weeks (current + previous are served). */
const RANKED_WEEKS_KEPT = 8;
/** Hard cap on stored burn intents (open + recently expired); see server/burns.ts for the policy. */
export const MAX_BURN_INTENTS = 20_000;
const DB_VERSION = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

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

const SLOTS: readonly CosmeticSlot[] = COSMETIC_SLOTS.map((s) => s.slot);
/** Catalog ids, for the per-snapshot getProfile() path. */
const CATALOG_IDS: ReadonlySet<string> = new Set(COSMETICS.map((c) => c.id));
/** Stored item ids: catalog-shaped. Unknown (e.g. retired) ids are kept on disk but never served. */
const ITEM_ID_RE = /^[a-z0-9_]{1,48}$/;
const MAX_OWNED = 500;
const HEX32_RE = /^[0-9a-f]{32}$/;
/** A base58 transaction signature, or a mock-mode signature. */
const SIGNATURE_RE = /^(?:[1-9A-HJ-NP-Za-km-z]{64,90}|mock_[A-Za-z0-9]{8,64})$/;
const AMOUNT_RAW_RE = /^[1-9][0-9]{0,19}$/;

interface StoredCosmetics {
  owned: string[];
  equipped: EquippedCosmetics;
}

interface StoredProfile {
  address: string;
  name: string;
  stats: PlayerStats;
  createdAt: number;
  /** Last time a game result was recorded (leaderboard tie-break; never sent to clients). */
  lastPlayedAt: number;
  cosmetics: StoredCosmetics;
  rankedTickets: number;
}

interface StoredSession {
  address: string;
  createdAt: number;
  expiresAt: number;
}

/** One granted burn. Kept forever: `signature` can never pay for anything else. */
export interface StoredBurn {
  signature: string;
  intentId: string;
  address: string;
  purpose: BurnPurpose;
  itemId?: string;
  /** Whole tokens. */
  amount: number;
  /** Base units, decimal string. */
  amountRaw: string;
  at: number;
}

/** A burn the server prepared and is waiting to see on chain (see server/burns.ts). */
export interface StoredBurnIntent {
  /** 32 hex chars. */
  id: string;
  address: string;
  purpose: BurnPurpose;
  itemId?: string;
  amount: number;
  amountRaw: string;
  decimals: number;
  /** 32 hex chars; public once the transaction lands (it is in the memo). */
  nonce: string;
  memo: string;
  mode: 'live' | 'mock';
  createdAt: number;
  expiresAt: number;
  /** A confirm with a well-formed signature arrived: the player probably signed it. Kept longer. */
  claimed: boolean;
}

interface StoredRankedStats {
  points: number;
  games: number;
  wins: number;
  rugs: number;
  correctVotes: number;
  /** Last recorded game (tie-break: who got there first). */
  lastAt: number;
}

interface DbFile {
  version: number;
  profiles: Record<string, StoredProfile>;
  /** Keyed by sha256(token) in hex. */
  sessions: Record<string, StoredSession>;
  /** Oldest first. */
  burns: StoredBurn[];
  intents: Record<string, StoredBurnIntent>;
  /** weekId -> address -> stats. */
  ranked: Record<string, Record<string, StoredRankedStats>>;
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
  burns: StoredBurn[];
  burnsBySignature: Map<string, StoredBurn>;
  burnsByIntent: Map<string, StoredBurn>;
  /** Sum of `amount` over `burns`. */
  totalBurned: number;
  intents: Map<string, StoredBurnIntent>;
  intentsByAddress: Map<string, Set<string>>;
  ranked: Map<string, Map<string, StoredRankedStats>>;
}

type Loaded = Omit<State, 'file'>;

let state: State | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hooksInstalled = false;
/** Bumped on every mutation that can change a leaderboard. */
let revision = 0;
const leaderboardCache = new Map<LeaderboardSort, { revision: number; entries: LeaderboardEntry[] }>();
const rankedCache = new Map<string, { revision: number; entries: RankedEntry[] }>();

function dbPath(): string {
  return path.resolve(process.env.DATA_DIR || './data', 'db.json');
}

function emptyState(): Loaded {
  return {
    profiles: new Map(),
    sessions: new Map(),
    sessionsByAddress: new Map(),
    burns: [],
    burnsBySignature: new Map(),
    burnsByIntent: new Map(),
    totalBurned: 0,
    intents: new Map(),
    intentsByAddress: new Map(),
    ranked: new Map(),
  };
}

function emptyStats(): PlayerStats {
  return { gamesPlayed: 0, wins: 0, holderWins: 0, ruggerWins: 0, rugs: 0, timesRugged: 0, tasksDone: 0, correctVotes: 0 };
}

function emptyCosmetics(): StoredCosmetics {
  return { owned: [], equipped: {} };
}

function newProfile(address: string, now: number): StoredProfile {
  return {
    address,
    name: defaultName(address),
    stats: emptyStats(),
    createdAt: now,
    lastPlayedAt: 0,
    cosmetics: emptyCosmetics(),
    rankedTickets: 0,
  };
}

function toCount(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(max, Math.floor(v));
}

function toInt(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function normalizeStats(raw: unknown): PlayerStats {
  const stats = emptyStats();
  if (raw && typeof raw === 'object') {
    const src = raw as Record<string, unknown>;
    for (const key of STAT_KEYS) stats[key] = toCount(src[key]);
  }
  return stats;
}

function normalizeCosmetics(raw: unknown): StoredCosmetics {
  const out = emptyCosmetics();
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as { owned?: unknown; equipped?: unknown };
  if (Array.isArray(src.owned)) {
    for (const id of src.owned) {
      if (typeof id === 'string' && ITEM_ID_RE.test(id) && !out.owned.includes(id)) out.owned.push(id);
      if (out.owned.length >= MAX_OWNED) break;
    }
  }
  if (src.equipped && typeof src.equipped === 'object') {
    const eq = src.equipped as Record<string, unknown>;
    for (const slot of SLOTS) {
      const id = eq[slot];
      if (typeof id === 'string' && out.owned.includes(id) && isCosmeticForSlot(id, slot)) out.equipped[slot] = id;
    }
  }
  return out;
}

function copyEquipped(eq: EquippedCosmetics): EquippedCosmetics {
  const out: EquippedCosmetics = {};
  for (const slot of SLOTS) if (eq[slot]) out[slot] = eq[slot];
  return out;
}

function toProfile(p: StoredProfile): Profile {
  return {
    address: p.address,
    name: p.name,
    stats: { ...p.stats },
    createdAt: p.createdAt,
    // Retired catalog items stay on disk (so nothing paid for is lost) but are not served.
    cosmetics: { owned: p.cosmetics.owned.filter((id) => CATALOG_IDS.has(id)), equipped: copyEquipped(p.cosmetics.equipped) },
    rankedTickets: p.rankedTickets,
  };
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

function isPurpose(v: unknown): v is BurnPurpose {
  return v === 'ranked' || v === 'cosmetic';
}

/** A burn or intent's purpose/item pair is coherent: tickets carry no item, cosmetics a stored-shape id. */
function validPurposeItem(purpose: unknown, itemId: unknown): boolean {
  if (purpose === 'ranked') return itemId === undefined;
  if (purpose === 'cosmetic') return typeof itemId === 'string' && ITEM_ID_RE.test(itemId);
  return false;
}

function parseBurn(raw: unknown): StoredBurn | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<StoredBurn>;
  if (typeof v.signature !== 'string' || !SIGNATURE_RE.test(v.signature)) return null;
  if (typeof v.intentId !== 'string' || !HEX32_RE.test(v.intentId)) return null;
  if (!isSolanaAddress(v.address) || !isPurpose(v.purpose)) return null;
  const itemId = v.purpose === 'cosmetic' ? v.itemId : undefined;
  if (!validPurposeItem(v.purpose, itemId)) return null;
  const amount = toCount(v.amount);
  if (amount <= 0 || typeof v.amountRaw !== 'string' || !AMOUNT_RAW_RE.test(v.amountRaw)) return null;
  const burn: StoredBurn = { signature: v.signature, intentId: v.intentId, address: v.address, purpose: v.purpose, amount, amountRaw: v.amountRaw, at: toCount(v.at) };
  if (itemId !== undefined) burn.itemId = itemId;
  return burn;
}

function parseIntent(raw: unknown): StoredBurnIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<StoredBurnIntent>;
  if (typeof v.id !== 'string' || !HEX32_RE.test(v.id) || typeof v.nonce !== 'string' || !HEX32_RE.test(v.nonce)) return null;
  if (!isSolanaAddress(v.address) || !isPurpose(v.purpose)) return null;
  const itemId = v.purpose === 'cosmetic' ? v.itemId : undefined;
  if (!validPurposeItem(v.purpose, itemId)) return null;
  const amount = toCount(v.amount);
  if (amount <= 0 || typeof v.amountRaw !== 'string' || !AMOUNT_RAW_RE.test(v.amountRaw)) return null;
  if (typeof v.memo !== 'string' || v.memo.length > 200 || !v.memo.endsWith(` ${v.nonce}`)) return null;
  if (v.mode !== 'live' && v.mode !== 'mock') return null;
  if (typeof v.decimals !== 'number' || !Number.isInteger(v.decimals) || v.decimals < 0 || v.decimals > 18) return null;
  const createdAt = toCount(v.createdAt);
  const expiresAt = toCount(v.expiresAt);
  if (!createdAt || expiresAt <= createdAt) return null;
  const intent: StoredBurnIntent = {
    id: v.id,
    address: v.address,
    purpose: v.purpose,
    amount,
    amountRaw: v.amountRaw,
    decimals: v.decimals,
    nonce: v.nonce,
    memo: v.memo,
    mode: v.mode,
    createdAt,
    expiresAt,
    claimed: v.claimed === true,
  };
  if (itemId !== undefined) intent.itemId = itemId;
  return intent;
}

function parseRankedStats(raw: unknown): StoredRankedStats | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<StoredRankedStats>;
  const games = toCount(v.games);
  if (games <= 0) return null;
  return {
    points: toInt(v.points, -1e12, 1e12),
    games,
    wins: toCount(v.wins),
    rugs: toCount(v.rugs),
    correctVotes: toCount(v.correctVotes),
    lastAt: toCount(v.lastAt),
  };
}

function indexIntent(s: Loaded, intent: StoredBurnIntent): void {
  s.intents.set(intent.id, intent);
  let set = s.intentsByAddress.get(intent.address);
  if (!set) s.intentsByAddress.set(intent.address, (set = new Set()));
  set.add(intent.id);
}

function unindexIntent(s: Loaded, id: string): void {
  const intent = s.intents.get(id);
  if (!intent) return;
  s.intents.delete(id);
  const set = s.intentsByAddress.get(intent.address);
  if (set) {
    set.delete(id);
    if (set.size === 0) s.intentsByAddress.delete(intent.address);
  }
}

function addBurn(s: Loaded, burn: StoredBurn): void {
  s.burns.push(burn);
  s.burnsBySignature.set(burn.signature, burn);
  s.burnsByIntent.set(burn.intentId, burn);
  s.totalBurned += burn.amount;
}

/** Thrown for a db.json written by a newer version: never load (and later overwrite) it. */
class NewerDbError extends Error {}

function parseDb(raw: unknown, now: number): Loaded {
  const out = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('db root is not an object');
  const db = raw as Partial<DbFile>;
  if (typeof db.version === 'number' && db.version > DB_VERSION) {
    throw new NewerDbError(`db.json has version ${db.version}, newer than this server understands (${DB_VERSION})`);
  }

  if (db.profiles && typeof db.profiles === 'object') {
    for (const [address, value] of Object.entries(db.profiles)) {
      if (!isSolanaAddress(address) || !value || typeof value !== 'object') continue;
      const v = value as Partial<StoredProfile>;
      const name = sanitizeProfileName(v.name) || defaultName(address);
      const createdAt = toCount(v.createdAt) || now;
      out.profiles.set(address, {
        address,
        name,
        stats: normalizeStats(v.stats),
        createdAt,
        lastPlayedAt: toCount(v.lastPlayedAt),
        // Version 1 profiles have neither field: they start with nothing.
        cosmetics: normalizeCosmetics(v.cosmetics),
        rankedTickets: toCount(v.rankedTickets, MAX_RANKED_TICKETS),
      });
    }
  }

  if (db.sessions && typeof db.sessions === 'object') {
    for (const [hash, value] of Object.entries(db.sessions)) {
      if (!/^[0-9a-f]{64}$/.test(hash) || !value || typeof value !== 'object') continue;
      const v = value as Partial<StoredSession>;
      if (typeof v.address !== 'string' || !out.profiles.has(v.address)) continue;
      const expiresAt = toCount(v.expiresAt);
      if (expiresAt <= now) continue;
      out.sessions.set(hash, { address: v.address, createdAt: toCount(v.createdAt) || now, expiresAt });
      let set = out.sessionsByAddress.get(v.address);
      if (!set) out.sessionsByAddress.set(v.address, (set = new Set()));
      set.add(hash);
    }
  }

  if (Array.isArray(db.burns)) {
    for (const value of db.burns) {
      const burn = parseBurn(value);
      // First record wins: a signature or an intent can only ever be granted once.
      if (!burn || out.burnsBySignature.has(burn.signature) || out.burnsByIntent.has(burn.intentId)) continue;
      addBurn(out, burn);
    }
  }

  if (db.intents && typeof db.intents === 'object') {
    for (const [id, value] of Object.entries(db.intents)) {
      const intent = parseIntent(value);
      if (!intent || intent.id !== id) continue;
      indexIntent(out, intent);
    }
  }

  if (db.ranked && typeof db.ranked === 'object') {
    for (const [weekId, players] of Object.entries(db.ranked)) {
      if (!/^\d{4}-W\d{2}$/.test(weekId) || !players || typeof players !== 'object') continue;
      const week = new Map<string, StoredRankedStats>();
      for (const [address, value] of Object.entries(players)) {
        const stats = isSolanaAddress(address) ? parseRankedStats(value) : null;
        if (stats) week.set(address, stats);
      }
      if (week.size > 0) out.ranked.set(weekId, week);
    }
  }
  return out;
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
  let loaded: Loaded = emptyState();
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
      // Never "repair" a file a newer server wrote: that would drop its data on the next save.
      if (err instanceof NewerDbError) throw new Error(`[store] ${file}: ${err.message}. Refusing to load it.`);
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
  const db: DbFile = { version: DB_VERSION, profiles: {}, sessions: {}, burns: s.burns, intents: {}, ranked: {} };
  for (const [address, p] of s.profiles) db.profiles[address] = p;
  for (const [hash, sess] of s.sessions) db.sessions[hash] = sess;
  for (const [id, intent] of s.intents) db.intents[id] = intent;
  for (const [weekId, players] of s.ranked) {
    const week: Record<string, StoredRankedStats> = {};
    for (const [address, stats] of players) week[address] = stats;
    db.ranked[weekId] = week;
  }
  return JSON.stringify(db);
}

let tmpSeq = 0;

function writeAtomic(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
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
  // Make the rename itself durable (best effort: not every platform can fsync a directory).
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(dir, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    /* ignore */
  } finally {
    if (dirFd !== null) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* ignore */
      }
    }
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
  rankedCache.clear();
}

// ---------- Profiles ----------

/** Profile with cosmetics and ranked tickets (a fresh copy), or null. */
export function getProfile(address: string): Profile | null {
  if (typeof address !== 'string') return null;
  const p = load().profiles.get(address);
  return p ? toProfile(p) : null;
}

/** Cheap read of a wallet's equipped cosmetics (a copy), or null without a profile. */
export function getEquippedCosmetics(address: string): EquippedCosmetics | null {
  if (typeof address !== 'string') return null;
  const p = load().profiles.get(address);
  return p ? copyEquipped(p.cosmetics.equipped) : null;
}

/** Holds nothing anyone paid for: safe to drop when the store is full. */
function isDisposable(s: State, p: StoredProfile): boolean {
  return (
    p.stats.gamesPlayed === 0 &&
    p.rankedTickets === 0 &&
    p.cosmetics.owned.length === 0 &&
    !s.sessionsByAddress.has(p.address) &&
    !s.intentsByAddress.has(p.address)
  );
}

/** Evict never-played, never-paid profiles without a live session to make room. Returns true when space was made. */
function evictIdleProfiles(s: State, now: number): boolean {
  purgeExpiredSessions(s, now);
  let removed = 0;
  for (const [address, p] of s.profiles) {
    if (!isDisposable(s, p)) continue;
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
  const p = newProfile(address, now);
  s.profiles.set(address, p);
  markChanged(false);
  return toProfile(p);
}

/** The stored profile, created when missing (a result or a paid burn must never be lost). */
function ensureProfile(s: State, address: string, now: number): StoredProfile {
  let p = s.profiles.get(address);
  if (!p) {
    p = newProfile(address, now);
    s.profiles.set(address, p);
  }
  return p;
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
    // Normally the profile exists (players sign in first); create it so a result is never lost.
    const p = ensureProfile(s, r.address, now);
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

// ---------- Cosmetics ----------

export type EquipError = 'no_profile' | 'bad_slot' | 'unknown_item' | 'wrong_slot' | 'not_owned';
export type EquipResult = { ok: true; profile: Profile } | { ok: false; error: EquipError };

export function isCosmeticSlot(value: unknown): value is CosmeticSlot {
  return typeof value === 'string' && (SLOTS as readonly string[]).includes(value);
}

/** Equip an owned catalog item in its own slot, or clear the slot with `itemId: null`. */
export function equipCosmetic(address: string, slot: CosmeticSlot, itemId: string | null): EquipResult {
  const p = typeof address === 'string' ? load().profiles.get(address) : undefined;
  if (!p) return { ok: false, error: 'no_profile' };
  if (!isCosmeticSlot(slot)) return { ok: false, error: 'bad_slot' };
  if (itemId === null) {
    if (p.cosmetics.equipped[slot] !== undefined) {
      delete p.cosmetics.equipped[slot];
      markChanged(false);
    }
    return { ok: true, profile: toProfile(p) };
  }
  const item = typeof itemId === 'string' ? cosmeticById(itemId) : undefined;
  if (!item) return { ok: false, error: 'unknown_item' };
  if (item.slot !== slot) return { ok: false, error: 'wrong_slot' };
  if (!p.cosmetics.owned.includes(item.id)) return { ok: false, error: 'not_owned' };
  if (p.cosmetics.equipped[slot] !== item.id) {
    p.cosmetics.equipped[slot] = item.id;
    markChanged(false);
  }
  return { ok: true, profile: toProfile(p) };
}

// ---------- Ranked tickets ----------

/**
 * Take one ranked ticket from every wallet, all or nothing. Duplicate addresses count once. Fails
 * (consuming nothing) with the wallets that have no ticket (or no profile).
 */
export function consumeRankedTickets(addresses: string[]): { ok: true } | { ok: false; missing: string[] } {
  if (!Array.isArray(addresses)) return { ok: false, missing: [] };
  const s = load();
  const unique = [...new Set(addresses)];
  const missing = unique.filter((a) => {
    const p = typeof a === 'string' ? s.profiles.get(a) : undefined;
    return !p || p.rankedTickets < 1;
  });
  if (missing.length > 0) return { ok: false, missing };
  if (unique.length === 0) return { ok: true };
  for (const a of unique) s.profiles.get(a)!.rankedTickets -= 1;
  markChanged(false);
  return { ok: true };
}

// ---------- Weekly ranked stats ----------

export interface RankedWeek {
  /** ISO week id, e.g. "2026-W42". */
  weekId: string;
  /** Monday 00:00 UTC. */
  weekStart: number;
  /** The next Monday 00:00 UTC (exclusive). */
  weekEnd: number;
}

/** The ISO week (Monday 00:00 UTC to the next Monday) containing `now`. */
export function rankedWeek(now: number = Date.now()): RankedWeek {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const weekStart = dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * DAY_MS; // back to Monday
  // The ISO year is the year of the week's Thursday; week 1 is the week with January 4th in it.
  const isoYear = new Date(weekStart + 3 * DAY_MS).getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const week1Start = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  const week = Math.round((weekStart - week1Start) / WEEK_MS) + 1;
  return { weekId: `${isoYear}-W${String(week).padStart(2, '0')}`, weekStart, weekEnd: weekStart + WEEK_MS };
}

const RANKED_CAPS = {
  rugs: MAX_PLAYERS - 1,
  tasksDone: SETTINGS_BOUNDS.tasksPerPlayer.max,
  correctVotes: SETTINGS_BOUNDS.ruggers.max,
};

/** Weekly points for one finished ranked game (RANKED_POINTS). Counters are clamped to sane per-game maxima. */
export function rankedPoints(r: RankedResultRecord): number {
  if (r.leftEarly === true) return RANKED_POINTS.leftEarly;
  let points = 0;
  if (r.won === true) points += r.role === 'rugger' ? RANKED_POINTS.ruggerWin : RANKED_POINTS.holderWin;
  points += toCount(r.rugs, RANKED_CAPS.rugs) * RANKED_POINTS.perRug;
  points += toCount(r.tasksDone, RANKED_CAPS.tasksDone) * RANKED_POINTS.perTask;
  points += toCount(r.correctVotes, RANKED_CAPS.correctVotes) * RANKED_POINTS.perCorrectVote;
  if (r.survived === true && r.won === true && r.role === 'holder') points += RANKED_POINTS.survived;
  return points;
}

/** Add one finished ranked game to the week containing `now`. Invalid and duplicate records are skipped. */
export function recordRankedResults(records: RankedResultRecord[], now: number = Date.now()): void {
  if (!Array.isArray(records) || records.length === 0) return;
  const s = load();
  const { weekId } = rankedWeek(now);
  let week = s.ranked.get(weekId);
  const seen = new Set<string>();
  let changed = false;
  for (const r of records) {
    if (!r || typeof r !== 'object' || !isSolanaAddress(r.address) || seen.has(r.address)) continue;
    if (r.role !== 'holder' && r.role !== 'rugger') continue;
    seen.add(r.address);
    ensureProfile(s, r.address, now);
    if (!week) s.ranked.set(weekId, (week = new Map()));
    let st = week.get(r.address);
    if (!st) week.set(r.address, (st = { points: 0, games: 0, wins: 0, rugs: 0, correctVotes: 0, lastAt: 0 }));
    st.points += rankedPoints(r);
    st.games += 1;
    if (r.leftEarly !== true) {
      if (r.won === true) st.wins += 1;
      st.rugs += toCount(r.rugs, RANKED_CAPS.rugs);
      st.correctVotes += toCount(r.correctVotes, RANKED_CAPS.correctVotes);
    }
    st.lastAt = now;
    changed = true;
  }
  if (!changed) return;
  // Keep a few weeks of history; only the current and previous week are served.
  if (s.ranked.size > RANKED_WEEKS_KEPT) {
    const ids = [...s.ranked.keys()].sort();
    for (const id of ids.slice(0, ids.length - RANKED_WEEKS_KEPT)) s.ranked.delete(id);
  }
  markChanged(true);
}

/**
 * Weekly ranked leaderboard: the top 50 of the current (or previous) ISO week by points, then wins,
 * then fewer games, then who got there first.
 */
export function getRankedLeaderboard(week: 'current' | 'previous' = 'current', now: number = Date.now()): RankedLeaderboard {
  const current = rankedWeek(now);
  const w = week === 'previous' ? rankedWeek(current.weekStart - 1) : current;
  const s = load();
  let cached = rankedCache.get(w.weekId);
  if (!cached || cached.revision !== revision) {
    const players = s.ranked.get(w.weekId) ?? new Map<string, StoredRankedStats>();
    const entries = [...players.entries()]
      .sort(
        ([aAddr, a], [bAddr, b]) =>
          b.points - a.points || b.wins - a.wins || a.games - b.games || a.lastAt - b.lastAt || (aAddr < bAddr ? -1 : aAddr > bAddr ? 1 : 0),
      )
      .slice(0, RANKED_LEADERBOARD_SIZE)
      .map(([address, st]) => ({
        address,
        shortAddress: shortAddress(address),
        name: s.profiles.get(address)?.name ?? defaultName(address),
        points: st.points,
        games: st.games,
        wins: st.wins,
        rugs: st.rugs,
        correctVotes: st.correctVotes,
      }));
    cached = { revision, entries };
    rankedCache.set(w.weekId, cached);
  }
  return { weekId: w.weekId, weekStart: w.weekStart, weekEnd: w.weekEnd, entries: cached.entries.map((e) => ({ ...e })) };
}

// ---------- Burns (used by server/burns.ts) ----------

export interface BurnGrant {
  signature: string;
  intentId: string;
  address: string;
  purpose: BurnPurpose;
  itemId?: string;
  amount: number;
  amountRaw: string;
  at: number;
}

export type GrantResult =
  | { ok: true; burn: StoredBurn; profile: Profile; /** This exact grant had already been made. */ duplicate: boolean }
  | { ok: false; reason: 'signature_used' | 'intent_used' | 'invalid' };

/**
 * Record a verified burn and deliver what it paid for, in one synchronous step:
 * - the signature must never have paid for anything else, and the intent must not be paid yet;
 * - the exact same grant again (same signature, intent and wallet) is a no-op that returns the original;
 * - ranked: one ticket; cosmetic: the item is added to `owned` and equipped when its slot is empty.
 */
export function grantBurn(g: BurnGrant): GrantResult {
  const burn = parseBurn(g);
  if (!burn || (g.purpose === 'cosmetic' && !cosmeticById(g.itemId ?? ''))) return { ok: false, reason: 'invalid' };
  const s = load();
  const bySig = s.burnsBySignature.get(burn.signature);
  if (bySig) {
    if (bySig.intentId === burn.intentId && bySig.address === burn.address) {
      return { ok: true, burn: { ...bySig }, profile: toProfile(ensureProfile(s, burn.address, burn.at)), duplicate: true };
    }
    return { ok: false, reason: 'signature_used' };
  }
  if (s.burnsByIntent.has(burn.intentId)) return { ok: false, reason: 'intent_used' };

  const p = ensureProfile(s, burn.address, burn.at);
  if (burn.purpose === 'ranked') {
    p.rankedTickets = Math.min(MAX_RANKED_TICKETS, p.rankedTickets + 1);
  } else {
    const item = cosmeticById(burn.itemId!)!;
    if (!p.cosmetics.owned.includes(item.id)) p.cosmetics.owned.push(item.id);
    if (!p.cosmetics.equipped[item.slot]) p.cosmetics.equipped[item.slot] = item.id;
  }
  addBurn(s, burn);
  markChanged(false);
  return { ok: true, burn: { ...burn }, profile: toProfile(p), duplicate: false };
}

export function getBurnBySignature(signature: string): StoredBurn | null {
  if (typeof signature !== 'string') return null;
  const b = load().burnsBySignature.get(signature);
  return b ? { ...b } : null;
}

export function getBurnByIntent(intentId: string): StoredBurn | null {
  if (typeof intentId !== 'string') return null;
  const b = load().burnsByIntent.get(intentId);
  return b ? { ...b } : null;
}

export interface BurnTotals {
  /** Whole tokens burned, all time. */
  totalBurned: number;
  burns: number;
  /** Newest first, each with the burner's current display name. */
  recent: Array<StoredBurn & { name: string }>;
}

export function getBurnTotals(recentLimit = 20): BurnTotals {
  const s = load();
  const n = Math.max(0, Math.min(100, Math.floor(recentLimit)));
  const recent = (n === 0 ? [] : s.burns.slice(-n))
    .reverse()
    .map((b) => ({ ...b, name: s.profiles.get(b.address)?.name ?? defaultName(b.address) }));
  return { totalBurned: s.totalBurned, burns: s.burns.length, recent };
}

// ---------- Burn intents (used by server/burns.ts) ----------

/** Insert or replace an intent. Returns false when the intent is malformed. */
export function putBurnIntent(intent: StoredBurnIntent): boolean {
  const parsed = parseIntent(intent);
  if (!parsed) return false;
  const s = load();
  unindexIntent(s, parsed.id);
  indexIntent(s, parsed);
  markChanged(false);
  return true;
}

export function getBurnIntent(id: string): StoredBurnIntent | null {
  if (typeof id !== 'string') return null;
  const intent = load().intents.get(id);
  return intent ? { ...intent } : null;
}

/** The wallet's stored intents (copies), oldest first. */
export function listBurnIntents(address: string): StoredBurnIntent[] {
  const s = load();
  const ids = s.intentsByAddress.get(address);
  if (!ids) return [];
  return [...ids]
    .map((id) => s.intents.get(id)!)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((i) => ({ ...i }));
}

export function markBurnIntentClaimed(id: string): void {
  const intent = load().intents.get(id);
  if (!intent || intent.claimed) return;
  intent.claimed = true;
  markChanged(false);
}

export function deleteBurnIntent(id: string): void {
  const s = load();
  if (!s.intents.has(id)) return;
  unindexIntent(s, id);
  markChanged(false);
}

export function countBurnIntents(): number {
  return load().intents.size;
}

/** Delete every intent for which `drop` returns true (oldest first). Returns how many were deleted. */
export function pruneBurnIntents(drop: (intent: Readonly<StoredBurnIntent>) => boolean): number {
  const s = load();
  let removed = 0;
  for (const intent of [...s.intents.values()].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!drop(intent)) continue;
    unindexIntent(s, intent.id);
    removed++;
  }
  if (removed > 0) markChanged(false);
  return removed;
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
