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
// Invalid values are dropped (with one warning per distinct value) so a typo in a deploy
// never puts a broken or unsafe link on the home screen.

import bs58 from 'bs58';
import { DEFAULT_TICKER, GAME_NAME } from '../shared/constants';
import type { PublicConfig } from '../shared/protocol';

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

const ENV_KEYS = ['GAME_NAME', 'TICKER', 'CONTRACT_ADDRESS', 'LINK_X', 'LINK_TELEGRAM', 'LINK_PUMPFUN'] as const;

let cacheKey: string | null = null;
let cached: PublicConfig | null = null;

function build(env: ConfigEnv): PublicConfig {
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
    contractAddress: parseContractAddress(env.CONTRACT_ADDRESS),
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
  return { ...cached, links: { ...cached.links } };
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
