// HTTP helpers for the same-origin API (/api/*, see the bottom of shared/protocol.ts).
// Public: fetchConfig, fetchLeaderboard, fetchRoomsInfo. The authed helpers below are used by wallet.ts.

import { DEFAULT_TICKER, GAME_NAME } from '../../shared/constants';
import type { AuthResult, LeaderboardEntry, PlayerStats, Profile, PublicConfig } from '../../shared/protocol';
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
    contractAddress: typeof ca === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca) ? ca : null,
    links,
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

/** Revoke the session server-side. Best effort: never throws. */
export async function postLogout(token: string): Promise<void> {
  try {
    await request<void>('/auth/logout', { method: 'POST', token, timeoutMs: 5000 });
  } catch {
    /* offline or already expired: the local session is gone either way */
  }
}
