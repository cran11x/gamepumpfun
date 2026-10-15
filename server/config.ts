// Public configuration read from the environment.
//
//   GAME_NAME         title shown in the client (default: GAME_NAME constant)
//   TICKER            coin ticker, e.g. "$RUGS" (a missing "$" is added)
//   CONTRACT_ADDRESS  Solana mint of the project's coin (base58, 32 bytes) or unset
//   LINK_X            https link to the X / Twitter account
//   LINK_TELEGRAM     https link to the Telegram group
//   LINK_PUMPFUN      https link to the pump.fun coin page
//   PUBLIC_ORIGIN     origin(s) the Phantom login message is bound to, e.g. "https://amongrugs.fun"
//                     (comma-separated for several, the first is the default). Not sent to the client.
//
// Token burns (SPEC "Ranked lobbies and token burns"):
//   TOKEN_MINT                 SPL mint of the project's token. Unset: burns are off.
//   SOLANA_RPC_URL             JSON-RPC endpoint for live mode (default mainnet-beta). Never sent to the client.
//   SOLANA_CLUSTER             mainnet-beta (default) or devnet; used for explorer links.
//   BURN_MODE                  "mock" for local testing / e2e (refused when NODE_ENV=production), "off" to
//                              force burns off. Otherwise live when TOKEN_MINT is set, off when it isn't.
//   RANKED_ENTRY_PRICE         whole tokens per ranked ticket (default DEFAULT_RANKED_ENTRY_PRICE)
//   COSMETIC_PRICE_MULTIPLIER  multiplies every cosmetic base price (default 1)
//
// Invalid values are dropped (with one warning per distinct value) so a typo in a deploy
// never puts a broken or unsafe link on the home screen.

import bs58 from 'bs58';
import { DEFAULT_RANKED_ENTRY_PRICE, DEFAULT_TICKER, GAME_NAME } from '../shared/constants';
import type { BurnConfig, PublicConfig } from '../shared/protocol';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_GAME_NAME_LENGTH = 32;
/** "$" plus up to 12 characters. */
const MAX_TICKER_LENGTH = 13;
const MAX_LINK_LENGTH = 512;

/** True when `value` is a base58 Solana public key (32 bytes). */
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !BASE58_RE.test(value)) return false;
  const bytes = bs58.decodeUnsafe(value);
  return bytes !== undefined && bytes.length === 32;
}

/** Strip control / invisible characters and collapse whitespace. */
function cleanText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncate(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('').trim() : s;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[config] ${message}`);
}

function parseGameName(raw: string | undefined): string {
  if (raw === undefined) return GAME_NAME;
  const name = truncate(cleanText(raw), MAX_GAME_NAME_LENGTH);
  return name || GAME_NAME;
}

function parseTicker(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_TICKER;
  const compact = cleanText(raw).replace(/\s/g, '').replace(/^\$+/, '');
  if (!compact) return DEFAULT_TICKER;
  return truncate(`$${compact}`, MAX_TICKER_LENGTH);
}

function parseContractAddress(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (isSolanaAddress(value)) return value;
  warnOnce(`ca:${value}`, `CONTRACT_ADDRESS "${value}" is not a base58 Solana address; it will not be shown.`);
  return null;
}

function parseLink(name: string, raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    warnOnce(`${name}:${value}`, `${name} "${value}" is not a valid URL; it will not be shown.`);
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    warnOnce(`${name}:${value}`, `${name} must be a plain https:// URL; it will not be shown.`);
    return undefined;
  }
  const href = url.toString();
  if (href.length > MAX_LINK_LENGTH) {
    warnOnce(`${name}:${value}`, `${name} is longer than ${MAX_LINK_LENGTH} characters; it will not be shown.`);
    return undefined;
  }
  return href;
}

type ConfigEnv = Record<string, string | undefined>;

const ENV_KEYS = ['GAME_NAME', 'TICKER', 'CONTRACT_ADDRESS', 'LINK_X', 'LINK_TELEGRAM', 'LINK_PUMPFUN', 'TOKEN_MINT'] as const;

let cacheKey: string | null = null;
let cached: Omit<PublicConfig, 'burn'> | null = null;

function build(env: ConfigEnv): Omit<PublicConfig, 'burn'> {
  const links: PublicConfig['links'] = {};
  const x = parseLink('LINK_X', env.LINK_X);
  const telegram = parseLink('LINK_TELEGRAM', env.LINK_TELEGRAM);
  const pumpfun = parseLink('LINK_PUMPFUN', env.LINK_PUMPFUN);
  if (x) links.x = x;
  if (telegram) links.telegram = telegram;
  if (pumpfun) links.pumpfun = pumpfun;
  return {
    gameName: parseGameName(env.GAME_NAME),
    ticker: parseTicker(env.TICKER),
    // The token's mint is the coin's contract address: show it when no separate CA is configured.
    contractAddress: parseContractAddress(env.CONTRACT_ADDRESS) ?? parseMint(env.TOKEN_MINT),
    links,
  };
}

/**
 * Public config for the client (GET /api/config) and the room ticker. Values are re-read
 * from the environment on every call (cheap, memoized on the raw values) and every call
 * returns a fresh object, so callers may mutate the result freely.
 */
export function getPublicConfig(env: ConfigEnv = process.env): PublicConfig {
  const key = JSON.stringify(ENV_KEYS.map((k) => env[k] ?? null));
  if (cached === null || key !== cacheKey) {
    cached = build(env);
    cacheKey = key;
  }
  return { ...cached, links: { ...cached.links }, burn: getBurnConfig(env) };
}

// ---------- Token burns ----------

export type BurnMode = BurnConfig['mode'];
export type SolanaCluster = BurnConfig['cluster'];

/** Server-side burn settings. `rpcUrl` may carry an API key: never send it to clients or logs. */
export interface BurnSettings {
  mode: BurnMode;
  cluster: SolanaCluster;
  mint: string | null;
  rpcUrl: string;
  rankedEntryPrice: number;
  priceMultiplier: number;
}

/** A configuration the server must refuse to start with. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
/** pump.fun coins use 6 decimals; reported until the mint has been read in live mode. */
export const DEFAULT_TOKEN_DECIMALS = 6;
const MAX_RANKED_ENTRY_PRICE = 1_000_000_000_000;
const MAX_PRICE_MULTIPLIER = 1_000_000;
const BURN_ENV_KEYS = [
  'BURN_MODE',
  'NODE_ENV',
  'TOKEN_MINT',
  'SOLANA_RPC_URL',
  'SOLANA_CLUSTER',
  'RANKED_ENTRY_PRICE',
  'COSMETIC_PRICE_MULTIPLIER',
] as const;

function parseMint(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (isSolanaAddress(value)) return value;
  warnOnce(`mint:${value}`, `TOKEN_MINT "${value}" is not a base58 Solana address; token burns stay off.`);
  return null;
}

function parseRpcUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_SOLANA_RPC_URL;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
  } catch {
    /* fall through */
  }
  // Don't echo the value: RPC URLs often embed an API key.
  warnOnce('rpc-url', `SOLANA_RPC_URL is not an http(s) URL; using ${DEFAULT_SOLANA_RPC_URL}.`);
  return DEFAULT_SOLANA_RPC_URL;
}

function parseCluster(raw: string | undefined): SolanaCluster {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'mainnet-beta' || value === 'mainnet') return 'mainnet-beta';
  if (value === 'devnet') return 'devnet';
  warnOnce(`cluster:${value}`, `SOLANA_CLUSTER "${value}" must be mainnet-beta or devnet; using mainnet-beta.`);
  return 'mainnet-beta';
}

function parseEntryPrice(raw: string | undefined): number {
  const value = raw?.trim().replace(/[_,]/g, '');
  if (!value) return DEFAULT_RANKED_ENTRY_PRICE;
  const n = Number(value);
  if (/^\d+$/.test(value) && Number.isSafeInteger(n) && n >= 1 && n <= MAX_RANKED_ENTRY_PRICE) return n;
  warnOnce(`entry:${value}`, `RANKED_ENTRY_PRICE "${value}" must be a whole number of tokens; using ${DEFAULT_RANKED_ENTRY_PRICE}.`);
  return DEFAULT_RANKED_ENTRY_PRICE;
}

function parseMultiplier(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return 1;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && n <= MAX_PRICE_MULTIPLIER) return n;
  warnOnce(`mult:${value}`, `COSMETIC_PRICE_MULTIPLIER "${value}" must be a positive number; using 1.`);
  return 1;
}

let burnKey: string | null = null;
let burnCached: BurnSettings | ConfigError | null = null;

function buildBurnSettings(env: ConfigEnv): BurnSettings | ConfigError {
  const rawMode = env.BURN_MODE?.trim().toLowerCase() ?? '';
  const mint = parseMint(env.TOKEN_MINT);
  const base = {
    cluster: parseCluster(env.SOLANA_CLUSTER),
    mint,
    rpcUrl: parseRpcUrl(env.SOLANA_RPC_URL),
    rankedEntryPrice: parseEntryPrice(env.RANKED_ENTRY_PRICE),
    priceMultiplier: parseMultiplier(env.COSMETIC_PRICE_MULTIPLIER),
  };
  if (rawMode === 'mock') {
    if (env.NODE_ENV?.trim() === 'production') {
      return new ConfigError('BURN_MODE=mock accepts fake burns and must never run with NODE_ENV=production. Unset BURN_MODE.');
    }
    return { mode: 'mock', ...base };
  }
  if (rawMode === 'off') return { mode: 'off', ...base, mint: null };
  if (rawMode !== '' && rawMode !== 'live') {
    warnOnce(`mode:${rawMode}`, `BURN_MODE "${rawMode}" is not recognised (use mock or off); ignoring it.`);
  }
  return mint ? { mode: 'live', ...base } : { mode: 'off', ...base, mint: null };
}

/**
 * Burn settings from the environment. Throws ConfigError for a configuration the server must not
 * run with (mock mode in production); the API router calls this at startup, so it refuses to start.
 */
export function getBurnSettings(env: ConfigEnv = process.env): BurnSettings {
  const key = JSON.stringify(BURN_ENV_KEYS.map((k) => env[k] ?? null));
  if (burnCached === null || key !== burnKey) {
    burnCached = buildBurnSettings(env);
    burnKey = key;
  }
  if (burnCached instanceof ConfigError) throw burnCached;
  return { ...burnCached };
}

let mintInfo: { mint: string; decimals: number } | null = null;

/** Called by the burn service once it has read the mint account (live mode). */
export function setMintDecimals(mint: string, decimals: number): void {
  if (isSolanaAddress(mint) && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18) mintInfo = { mint, decimals };
}

/** Decimals of `mint`: read from chain in live mode, DEFAULT_TOKEN_DECIMALS until then (and in mock mode). */
export function getMintDecimals(mint: string | null): number {
  return mint && mintInfo?.mint === mint ? mintInfo.decimals : DEFAULT_TOKEN_DECIMALS;
}

/** The public part of the burn settings. Never throws: a refused configuration reports 'off'. */
export function getBurnConfig(env: ConfigEnv = process.env): BurnConfig {
  let s: BurnSettings;
  try {
    s = getBurnSettings(env);
  } catch {
    return { mode: 'off', cluster: 'mainnet-beta', mint: null, decimals: DEFAULT_TOKEN_DECIMALS, rankedEntryPrice: DEFAULT_RANKED_ENTRY_PRICE, priceMultiplier: 1 };
  }
  return {
    mode: s.mode,
    cluster: s.cluster,
    mint: s.mode === 'off' ? null : s.mint,
    decimals: getMintDecimals(s.mint),
    rankedEntryPrice: s.rankedEntryPrice,
    priceMultiplier: s.priceMultiplier,
  };
}

// ---------- Login origin ----------

let originsKey: string | undefined;
let originsCache: string[] = [];

/**
 * The public origins from PUBLIC_ORIGIN (http/https only, normalized to `scheme://host[:port]`),
 * in the order given. Empty when unset: the login message then uses the request's Host header.
 */
export function getLoginOrigins(env: ConfigEnv = process.env): string[] {
  const raw = env.PUBLIC_ORIGIN?.trim() ?? '';
  if (raw !== originsKey) {
    const origins: string[] = [];
    for (const part of raw.split(',')) {
      const value = part.trim();
      if (!value) continue;
      let url: URL | null = null;
      try {
        url = new URL(value);
      } catch {
        url = null;
      }
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.host) {
        warnOnce(`origin:${value}`, `PUBLIC_ORIGIN entry "${value}" is not an http(s) origin; it is ignored.`);
        continue;
      }
      if (!origins.includes(url.origin)) origins.push(url.origin);
    }
    originsKey = raw;
    originsCache = origins;
  }
  return [...originsCache];
}
