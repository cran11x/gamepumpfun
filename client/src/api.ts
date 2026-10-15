// HTTP helpers for the same-origin API (/api/*, see the bottom of shared/protocol.ts).
// Public: fetchConfig, fetchLeaderboard, fetchRoomsInfo, fetchRankedLeaderboard, fetchBurnStats.
// The authed helpers below (login, profile, equip, burn intent / confirm) are used by wallet.ts.
// Every response is validated and normalized: nothing from the network is trusted blindly.

import { DEFAULT_RANKED_ENTRY_PRICE, DEFAULT_TICKER, GAME_NAME } from '../../shared/constants';
import { COSMETIC_SLOTS, cosmeticById, isCosmeticForSlot, type CosmeticSlot } from '../../shared/cosmetics';
import type {
  AuthResult,
  BurnConfig,
  BurnConfirmRequest,
  BurnIntent,
  BurnIntentRequest,
  BurnPurpose,
  BurnReceipt,
  BurnRecord,
  BurnStats,
  EquippedCosmetics,
  LeaderboardEntry,
  PlayerStats,
  Profile,
  PublicConfig,
  RankedEntry,
  RankedLeaderboard,
} from '../../shared/protocol';
import { shortAddress } from '../../shared/protocol';

export type LeaderboardSort = 'wins' | 'ruggerWins' | 'holderWins' | 'rugs' | 'correctVotes';
export const LEADERBOARD_SORTS: readonly LeaderboardSort[] = ['wins', 'ruggerWins', 'holderWins', 'rugs', 'correctVotes'];

export interface RoomsInfo {
  publicLobbies: number;
  playersOnline: number;
}

const API_BASE = '/api';
const TIMEOUT_MS = 10_000;

/** A failed API call. `status` is the HTTP status, or 0 when the server could not be reached. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string;
  timeoutMs?: number;
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Session expired. Connect Phantom again.';
  if (status === 429) return 'Too many requests. Try again in a moment.';
  if (status >= 500) return 'Server error. Try again in a moment.';
  return 'Request failed';
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  try {
    let res: Response;
    try {
      res = await fetch(API_BASE + path, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(
        ctrl.signal.aborted ? 'The server took too long to answer. Try again.' : "Can't reach the server. Check your connection.",
        0,
      );
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      throw new ApiError("Can't reach the server. Check your connection.", 0);
    }
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const serverMsg =
        data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
          ? (data as { error: string }).error
          : '';
      throw new ApiError(serverMsg || defaultMessage(res.status), res.status);
    }
    if (res.status === 204) return undefined as T;
    if (data === undefined) throw new ApiError('Unexpected server response', res.status);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Response validation (never trust shapes blindly) ----------

const STAT_KEYS: readonly (keyof PlayerStats)[] = [
  'gamesPlayed',
  'wins',
  'holderWins',
  'ruggerWins',
  'rugs',
  'timesRugged',
  'tasksDone',
  'correctVotes',
];

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function toStats(raw: unknown): PlayerStats {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const stats = {} as PlayerStats;
  for (const k of STAT_KEYS) stats[k] = num(src[k]);
  return stats;
}

const SLOTS: readonly CosmeticSlot[] = COSMETIC_SLOTS.map((s) => s.slot);

/** Owned catalog items and what is equipped (only owned items, each in its own slot). */
function toCosmetics(raw: unknown): Profile['cosmetics'] {
  const src = raw && typeof raw === 'object' ? (raw as { owned?: unknown; equipped?: unknown }) : {};
  const owned: string[] = [];
  if (Array.isArray(src.owned)) {
    for (const id of src.owned) if (typeof id === 'string' && cosmeticById(id) && !owned.includes(id)) owned.push(id);
  }
  const equipped: EquippedCosmetics = {};
  if (src.equipped && typeof src.equipped === 'object') {
    const eq = src.equipped as Record<string, unknown>;
    for (const slot of SLOTS) {
      const id = eq[slot];
      if (typeof id === 'string' && owned.includes(id) && isCosmeticForSlot(id, slot)) equipped[slot] = id;
    }
  }
  return { owned, equipped };
}

/** `{name: <name effect id>}` when `raw` carries a known name effect, else undefined. */
function toNameFx(raw: unknown): Pick<EquippedCosmetics, 'name'> | undefined {
  const id = raw && typeof raw === 'object' ? (raw as { name?: unknown }).name : undefined;
  return typeof id === 'string' && isCosmeticForSlot(id, 'name') ? { name: id } : undefined;
}

/** Normalize a Profile from the server; null when it isn't one. */
export function toProfile(raw: unknown): Profile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.address !== 'string' || !r.address) return null;
  return {
    address: r.address,
    name: typeof r.name === 'string' && r.name ? r.name : shortAddress(r.address),
    stats: toStats(r.stats),
    createdAt: num(r.createdAt),
    cosmetics: toCosmetics(r.cosmetics),
    rankedTickets: num(r.rankedTickets),
  };
}

/** A deep copy of a profile (callers may mutate it freely). */
export function copyProfile(p: Profile): Profile {
  return {
    ...p,
    stats: { ...p.stats },
    cosmetics: { owned: [...p.cosmetics.owned], equipped: { ...p.cosmetics.equipped } },
  };
}

function httpsLink(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function nonEmpty(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isAddress(v: unknown): v is string {
  return typeof v === 'string' && BASE58_ADDRESS_RE.test(v);
}

/** Burns hidden (the client fallback whenever the server's answer is unusable). */
export const BURNS_OFF: BurnConfig = {
  mode: 'off',
  cluster: 'mainnet-beta',
  mint: null,
  decimals: 6,
  rankedEntryPrice: DEFAULT_RANKED_ENTRY_PRICE,
  priceMultiplier: 1,
};

function toBurnConfig(raw: unknown): BurnConfig {
  if (!raw || typeof raw !== 'object') return { ...BURNS_OFF };
  const r = raw as Record<string, unknown>;
  const mode = r.mode === 'live' || r.mode === 'mock' ? r.mode : 'off';
  const mint = isAddress(r.mint) ? r.mint : null;
  // Live burns need a mint to check transactions against.
  if (mode === 'off' || (mode === 'live' && !mint)) return { ...BURNS_OFF };
  const decimals = typeof r.decimals === 'number' && Number.isInteger(r.decimals) && r.decimals >= 0 && r.decimals <= 18 ? r.decimals : 6;
  const price = num(r.rankedEntryPrice);
  const mult = typeof r.priceMultiplier === 'number' && Number.isFinite(r.priceMultiplier) && r.priceMultiplier > 0 ? r.priceMultiplier : 1;
  return {
    mode,
    cluster: r.cluster === 'devnet' ? 'devnet' : 'mainnet-beta',
    mint,
    decimals,
    rankedEntryPrice: price > 0 ? price : DEFAULT_RANKED_ENTRY_PRICE,
    priceMultiplier: mult,
  };
}

/** Only Solscan transaction links are ever rendered. */
function explorerLink(v: unknown): string | null {
  const link = httpsLink(v);
  if (!link) return null;
  const url = new URL(link);
  return url.hostname === 'solscan.io' && url.pathname.startsWith('/tx/') ? link : null;
}

function isPurpose(v: unknown): v is BurnPurpose {
  return v === 'ranked' || v === 'cosmetic';
}

function optItem(purpose: BurnPurpose, v: unknown): string | undefined {
  return purpose === 'cosmetic' && typeof v === 'string' && cosmeticById(v) ? v : undefined;
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

// ---------- Public helpers ----------

export async function fetchConfig(): Promise<PublicConfig> {
  const raw = await request<Record<string, unknown>>('/config', { timeoutMs: 5000 });
  const linksRaw = raw && typeof raw.links === 'object' && raw.links ? (raw.links as Record<string, unknown>) : {};
  const links: PublicConfig['links'] = {};
  const x = httpsLink(linksRaw.x);
  const telegram = httpsLink(linksRaw.telegram);
  const pumpfun = httpsLink(linksRaw.pumpfun);
  if (x) links.x = x;
  if (telegram) links.telegram = telegram;
  if (pumpfun) links.pumpfun = pumpfun;
  const ca = raw?.contractAddress;
  return {
    gameName: nonEmpty(raw?.gameName, GAME_NAME),
    ticker: nonEmpty(raw?.ticker, DEFAULT_TICKER),
    contractAddress: isAddress(ca) ? ca : null,
    links,
    burn: toBurnConfig(raw?.burn),
  };
}

/** Top players for a sort key (unknown keys fall back to 'wins'). */
export async function fetchLeaderboard(sort: LeaderboardSort | (string & {}) = 'wins'): Promise<LeaderboardEntry[]> {
  const key = (LEADERBOARD_SORTS as readonly string[]).includes(sort) ? sort : 'wins';
  const raw = await request<unknown>(`/leaderboard?sort=${encodeURIComponent(key)}`);
  if (!Array.isArray(raw)) return [];
  const out: LeaderboardEntry[] = [];
  for (const item of raw) {
    const p = toProfile(item);
    if (!p) continue;
    const short = (item as { shortAddress?: unknown }).shortAddress;
    out.push({ address: p.address, shortAddress: typeof short === 'string' ? short : shortAddress(p.address), name: p.name, stats: p.stats });
  }
  return out;
}

export async function fetchRoomsInfo(): Promise<RoomsInfo> {
  const raw = await request<Record<string, unknown>>('/rooms', { timeoutMs: 5000 });
  return { publicLobbies: num(raw?.publicLobbies), playersOnline: num(raw?.playersOnline) };
}

/** Weekly ranked leaderboard (ISO weeks from Monday 00:00 UTC). */
export async function fetchRankedLeaderboard(week: 'current' | 'previous' = 'current'): Promise<RankedLeaderboard> {
  const w = week === 'previous' ? 'previous' : 'current';
  const raw = await request<Record<string, unknown>>(`/leaderboard/ranked?week=${w}`);
  const entries: RankedEntry[] = [];
  if (Array.isArray(raw?.entries)) {
    for (const item of raw.entries as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      if (typeof e.address !== 'string' || !e.address) continue;
      const entry: RankedEntry = {
        address: e.address,
        shortAddress: typeof e.shortAddress === 'string' ? e.shortAddress : shortAddress(e.address),
        name: typeof e.name === 'string' && e.name ? e.name : shortAddress(e.address),
        points: int(e.points),
        games: num(e.games),
        wins: num(e.wins),
        rugs: num(e.rugs),
        correctVotes: num(e.correctVotes),
      };
      const fx = toNameFx(e.cosmetics);
      if (fx) entry.cosmetics = fx;
      entries.push(entry);
    }
  }
  return {
    weekId: typeof raw?.weekId === 'string' ? raw.weekId : '',
    weekStart: num(raw?.weekStart),
    weekEnd: num(raw?.weekEnd),
    entries,
  };
}

function toBurnRecord(raw: unknown): BurnRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isPurpose(r.purpose) || typeof r.signature !== 'string') return null;
  const record: BurnRecord = {
    shortAddress: typeof r.shortAddress === 'string' ? r.shortAddress : '',
    name: typeof r.name === 'string' ? r.name : '',
    amount: num(r.amount),
    purpose: r.purpose,
    signature: r.signature,
    explorerUrl: explorerLink(r.explorerUrl),
    at: num(r.at),
  };
  const itemId = optItem(r.purpose, r.itemId);
  if (itemId) record.itemId = itemId;
  const fx = toNameFx(r.cosmetics);
  if (fx) record.cosmetics = fx;
  return record;
}

/** Total burned through the game and the latest burns. */
export async function fetchBurnStats(): Promise<BurnStats> {
  const raw = await request<Record<string, unknown>>('/burns/stats', { timeoutMs: 5000 });
  const recent: BurnRecord[] = [];
  if (Array.isArray(raw?.recent)) for (const item of raw.recent as unknown[]) {
    const r = toBurnRecord(item);
    if (r) recent.push(r);
  }
  const mode = raw?.mode === 'live' || raw?.mode === 'mock' ? raw.mode : 'off';
  return { mode, totalBurned: num(raw?.totalBurned), burns: num(raw?.burns), recent };
}

// ---------- Auth helpers (wallet.ts) ----------

export async function fetchLoginNonce(address: string): Promise<{ nonce: string; message: string }> {
  const raw = await request<Record<string, unknown>>(`/auth/nonce?address=${encodeURIComponent(address)}`);
  if (typeof raw?.nonce !== 'string' || typeof raw?.message !== 'string') throw new ApiError('Unexpected server response', 200);
  return { nonce: raw.nonce, message: raw.message };
}

export async function postLoginVerify(address: string, nonce: string, signature: string): Promise<AuthResult> {
  const raw = await request<Record<string, unknown>>('/auth/verify', { method: 'POST', body: { address, nonce, signature } });
  const profile = toProfile(raw?.profile);
  if (typeof raw?.token !== 'string' || !profile) throw new ApiError('Unexpected server response', 200);
  return { token: raw.token, profile };
}

export async function fetchMe(token: string): Promise<Profile> {
  const profile = toProfile(await request<unknown>('/me', { token }));
  if (!profile) throw new ApiError('Unexpected server response', 200);
  return profile;
}

export async function postProfileName(token: string, name: string): Promise<Profile> {
  const profile = toProfile(await request<unknown>('/me/name', { method: 'POST', token, body: { name } }));
  if (!profile) throw new ApiError('Unexpected server response', 200);
  return profile;
}

export async function postEquip(token: string, slot: CosmeticSlot, itemId: string | null): Promise<Profile> {
  const profile = toProfile(await request<unknown>('/me/equip', { method: 'POST', token, body: { slot, itemId } }));
  if (!profile) throw new ApiError('Unexpected server response', 200);
  return profile;
}

/** POST /burn/intent. The result is shape-checked here; wallet.ts checks the transaction itself. */
export async function postBurnIntent(token: string, req: BurnIntentRequest): Promise<BurnIntent> {
  const body: BurnIntentRequest = req.purpose === 'cosmetic' ? { purpose: 'cosmetic', itemId: req.itemId } : { purpose: 'ranked' };
  const raw = await request<Record<string, unknown>>('/burn/intent', { method: 'POST', token, body, timeoutMs: 20_000 });
  const bad = () => new ApiError('Unexpected server response', 200);
  if (!raw || typeof raw.intentId !== 'string' || !/^[0-9a-f]{32}$/.test(raw.intentId) || !isPurpose(raw.purpose)) throw bad();
  if (typeof raw.amount !== 'number' || !Number.isSafeInteger(raw.amount) || raw.amount <= 0) throw bad();
  if (typeof raw.amountRaw !== 'string' || !/^[1-9][0-9]{0,19}$/.test(raw.amountRaw) || typeof raw.memo !== 'string') throw bad();
  if (raw.transaction !== null && (typeof raw.transaction !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.transaction))) throw bad();
  const intent: BurnIntent = {
    intentId: raw.intentId,
    purpose: raw.purpose,
    amount: raw.amount,
    amountRaw: raw.amountRaw,
    memo: raw.memo,
    transaction: raw.transaction,
    expiresAt: num(raw.expiresAt),
  };
  const itemId = optItem(raw.purpose, raw.itemId);
  if (raw.purpose === 'cosmetic' && !itemId) throw bad();
  if (itemId) intent.itemId = itemId;
  return intent;
}

export type BurnConfirmResult = { status: 'confirmed'; receipt: BurnReceipt } | { status: 'pending' };

/** POST /burn/confirm. The server may hold the request ~25 s while it looks for the transaction. */
export async function postBurnConfirm(token: string, req: BurnConfirmRequest): Promise<BurnConfirmResult> {
  const raw = await request<Record<string, unknown>>('/burn/confirm', {
    method: 'POST',
    token,
    body: { intentId: req.intentId, signature: req.signature },
    timeoutMs: 45_000,
  });
  if (raw?.status === 'pending') return { status: 'pending' };
  const profile = toProfile(raw?.profile);
  if (raw?.status !== 'confirmed' || !profile || !isPurpose(raw.purpose) || typeof raw.signature !== 'string') {
    throw new ApiError('Unexpected server response', 200);
  }
  const receipt: BurnReceipt = {
    status: 'confirmed',
    signature: raw.signature,
    amount: num(raw.amount),
    purpose: raw.purpose,
    explorerUrl: explorerLink(raw.explorerUrl),
    profile,
  };
  const itemId = optItem(raw.purpose, raw.itemId);
  if (itemId) receipt.itemId = itemId;
  return { status: 'confirmed', receipt };
}

/** Revoke the session server-side. Best effort: never throws. */
export async function postLogout(token: string): Promise<void> {
  try {
    await request<void>('/auth/logout', { method: 'POST', token, timeoutMs: 5000 });
  } catch {
    /* offline or already expired: the local session is gone either way */
  }
}
