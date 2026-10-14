// Phantom "signMessage" login. No transactions are ever involved:
//
//   1. GET  /api/auth/nonce?address=<b58>  -> issueNonce(): a single-use nonce + the exact text to sign,
//      a Sign-In-With-Solana style message bound to this site's domain and origin (PUBLIC_ORIGIN, or
//      the request's Host), so a signature made for another site's prompt is useless here and
//      Phantom can warn about a domain mismatch
//   2. the wallet signs that UTF-8 text (ed25519, detached signature)
//   3. POST /api/auth/verify                -> verifyLogin(): checks + consumes the nonce, verifies the
//      signature against the address (which is the ed25519 public key), upserts the profile and
//      returns a 30-day session token
//   4. the token is sent as `Authorization: Bearer` to the API and as `authToken` on the WebSocket,
//      where resolveAuthToken() turns it back into a Profile.

import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { GAME_NAME } from '../shared/constants';
import type { AuthResult, Profile } from '../shared/protocol';
import { isSolanaAddress } from './config';
import { createSession, deleteSession, getProfile, getSessionAddress, upsertProfile } from './store';

export const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_NONCES = 20_000;
/** Outstanding nonces per (wallet, requester): one requester can't evict another's pending login. */
const MAX_NONCES_PER_ADDRESS = 5;
const MAX_REQUESTER_LENGTH = 64;
/** host[:port]: a DNS name / IPv4 or a bracketed IPv6 literal. */
const DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIGNATURE_B58_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export type AuthErrorCode = 'BAD_REQUEST' | 'NONCE_INVALID' | 'SIGNATURE_INVALID';

/** Login failure. BAD_REQUEST maps to HTTP 400, the others to 401. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface NonceResult {
  nonce: string;
  message: string;
}

/** The site a login is for. Both end up in the signed message. */
export interface LoginSite {
  /** `host[:port]`, lowercase, e.g. "amongrugs.fun". */
  domain: string;
  /** The origin with that host, e.g. "https://amongrugs.fun". */
  uri: string;
}

export interface NonceOptions {
  /** Defaults to http://localhost (the HTTP API always passes the real site). */
  site?: LoginSite;
  /** Who asked (the client IP key). The per-wallet cap only evicts this requester's older nonces. */
  requester?: string;
}

const DEFAULT_SITE: LoginSite = { domain: 'localhost', uri: 'http://localhost' };

/** True when `domain` is a plain `host[:port]` (no scheme, path, credentials or whitespace). */
export function isLoginDomain(domain: unknown): domain is string {
  return typeof domain === 'string' && domain.length <= 255 && DOMAIN_RE.test(domain);
}

/** True when `site` is a plain host[:port] and its matching http(s) origin (nothing that could add lines). */
export function isLoginSite(site: unknown): site is LoginSite {
  const s = site as Partial<LoginSite> | null;
  if (!s || typeof s.domain !== 'string' || typeof s.uri !== 'string') return false;
  if (!isLoginDomain(s.domain)) return false;
  try {
    const url = new URL(s.uri);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === s.uri && url.host === s.domain;
  } catch {
    return false;
  }
}

export interface AuthOptions {
  /** Clock in ms (injectable for tests). */
  now?: () => number;
  nonceTtlMs?: number;
  maxNonces?: number;
}

export interface Auth {
  issueNonce(address: string, options?: NonceOptions): NonceResult;
  verifyLogin(address: string, nonce: string, signatureB58: string): AuthResult;
  resolveAuthToken(token?: string): Profile | null;
  revokeToken(token?: string): boolean;
  /** Outstanding (unexpired, unused) nonces. */
  pendingNonces(): number;
}

interface PendingNonce {
  address: string;
  /** byRequest key: wallet + requester. */
  bucket: string;
  /** The exact text issued (domain and URI included); the signature is checked against it. */
  message: string;
  expiresAt: number;
}

/**
 * The exact text the wallet signs, in the Sign-In-With-Solana layout (domain first, then the
 * wallet, a plain-English statement and the URI / nonce / time fields).
 */
export function loginMessage(
  address: string,
  nonce: string,
  issuedAt: number,
  site: LoginSite = DEFAULT_SITE,
  ttlMs: number = NONCE_TTL_MS,
): string {
  return (
    `${site.domain} wants you to sign in with your Solana account:\n` +
    `${address}\n\n` +
    `Sign in to ${GAME_NAME} to prove you own this wallet. This is NOT a transaction and costs nothing.\n\n` +
    `URI: ${site.uri}\n` +
    'Version: 1\n' +
    `Nonce: ${nonce}\n` +
    `Issued At: ${new Date(issuedAt).toISOString()}\n` +
    `Expiration Time: ${new Date(issuedAt + ttlMs).toISOString()}`
  );
}

/** Create an independent authenticator (own nonce table and clock). Sessions live in server/store.ts. */
export function createAuth(options: AuthOptions = {}): Auth {
  const now = options.now ?? Date.now;
  const ttl = options.nonceTtlMs ?? NONCE_TTL_MS;
  const maxNonces = Math.max(1, options.maxNonces ?? MAX_NONCES);
  /** nonce -> pending login. Map insertion order == issue order, so the first key is the oldest. */
  const nonces = new Map<string, PendingNonce>();
  /** `${address}|${requester}` -> that requester's outstanding nonces for that wallet, oldest first. */
  const byRequest = new Map<string, string[]>();

  function forget(nonce: string): void {
    const entry = nonces.get(nonce);
    if (!entry) return;
    nonces.delete(nonce);
    const list = byRequest.get(entry.bucket);
    if (!list) return;
    const i = list.indexOf(nonce);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) byRequest.delete(entry.bucket);
  }

  function purgeExpired(t: number): void {
    for (const [nonce, entry] of nonces) if (entry.expiresAt <= t) forget(nonce);
  }

  function issueNonce(address: string, options: NonceOptions = {}): NonceResult {
    if (!isSolanaAddress(address)) throw new AuthError('BAD_REQUEST', 'Invalid wallet address');
    const site = options.site ?? DEFAULT_SITE;
    if (!isLoginSite(site)) throw new AuthError('BAD_REQUEST', 'Invalid site');
    const requester = typeof options.requester === 'string' ? options.requester.slice(0, MAX_REQUESTER_LENGTH) : '';
    const bucket = `${address}|${requester}`;
    const t = now();

    // Per-wallet cap, per requester: drop the oldest nonces this same requester got for this wallet.
    // Anyone can ask for nonces for any public address, so another requester must never evict the
    // owner's pending login.
    const mine = byRequest.get(bucket);
    while (mine && mine.length >= MAX_NONCES_PER_ADDRESS) forget(mine[0]);
    // Global cap: purge expired ones first, then evict the oldest.
    if (nonces.size >= maxNonces) {
      purgeExpired(t);
      for (const oldest of nonces.keys()) {
        if (nonces.size < maxNonces) break;
        forget(oldest);
      }
    }

    let nonce = randomBytes(16).toString('hex');
    while (nonces.has(nonce)) nonce = randomBytes(16).toString('hex');
    const message = loginMessage(address, nonce, t, site, ttl);
    nonces.set(nonce, { address, bucket, message, expiresAt: t + ttl });
    const list = byRequest.get(bucket);
    if (list) list.push(nonce);
    else byRequest.set(bucket, [nonce]);
    return { nonce, message };
  }

  function verifyLogin(address: string, nonce: string, signatureB58: string): AuthResult {
    if (!isSolanaAddress(address)) throw new AuthError('BAD_REQUEST', 'Invalid wallet address');
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw new AuthError('BAD_REQUEST', 'Invalid nonce');
    if (typeof signatureB58 !== 'string' || !SIGNATURE_B58_RE.test(signatureB58)) {
      throw new AuthError('BAD_REQUEST', 'Invalid signature');
    }
    const signature = bs58.decodeUnsafe(signatureB58);
    if (!signature || signature.length !== nacl.sign.signatureLength) throw new AuthError('BAD_REQUEST', 'Invalid signature');

    // The nonce must exist, be unexpired and belong to this wallet. A mismatched address does not
    // consume it (only whoever requested the nonce knows it, and they may still finish the login).
    const entry = nonces.get(nonce);
    if (!entry || entry.address !== address) throw new AuthError('NONCE_INVALID', 'Login request expired. Try again.');
    forget(nonce); // single use, whatever the outcome below
    if (entry.expiresAt <= now()) throw new AuthError('NONCE_INVALID', 'Login request expired. Try again.');

    const publicKey = bs58.decode(address);
    const message = new TextEncoder().encode(entry.message);
    let valid = false;
    try {
      valid = nacl.sign.detached.verify(message, signature, publicKey);
    } catch {
      valid = false;
    }
    if (!valid) throw new AuthError('SIGNATURE_INVALID', 'Signature check failed');

    const t = now();
    const profile = upsertProfile(address, t);
    const token = createSession(address, t);
    return { token, profile };
  }

  function resolveAuthToken(token?: string): Profile | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    const address = getSessionAddress(token.trim(), now());
    if (!address) return null;
    return getProfile(address);
  }

  function revokeToken(token?: string): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    return deleteSession(token.trim());
  }

  function pendingNonces(): number {
    purgeExpired(now());
    return nonces.size;
  }

  return { issueNonce, verifyLogin, resolveAuthToken, revokeToken, pendingNonces };
}

const defaultAuth = createAuth();

/**
 * Issue a single-use login nonce (5 min TTL) and the exact message to sign, bound to `options.site`.
 * Throws AuthError on a bad address or site.
 */
export function issueNonce(address: string, options?: NonceOptions): NonceResult {
  return defaultAuth.issueNonce(address, options);
}

/** Verify a signed login message. Returns the session token and profile, or throws AuthError. */
export function verifyLogin(address: string, nonce: string, signatureB58: string): AuthResult {
  return defaultAuth.verifyLogin(address, nonce, signatureB58);
}

/** Profile for a session token, or null when the token is missing, unknown or expired. Synchronous. */
export function resolveAuthToken(token?: string): Profile | null {
  return defaultAuth.resolveAuthToken(token);
}

/** Revoke a session token (logout). Returns true when it existed. */
export function revokeToken(token?: string): boolean {
  return defaultAuth.revokeToken(token);
}
