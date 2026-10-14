// HTTP API mounted at /api (see the bottom of shared/protocol.ts):
//
//   GET  /config                       -> PublicConfig
//   GET  /auth/nonce?address=<b58>     -> { nonce, message }  (message bound to PUBLIC_ORIGIN or the Host)
//   POST /auth/verify {address, nonce, signature}  -> AuthResult | 401
//   POST /auth/logout   (Bearer)       -> 204 (revokes the token; extra, used by the client on logout)
//   GET  /me            (Bearer)       -> Profile | 401
//   POST /me/name {name} (Bearer)      -> Profile
//   GET  /leaderboard?sort=<key>&limit=<n> -> LeaderboardEntry[]
//   GET  /rooms                        -> { publicLobbies, playersOnline }
//
// Errors are JSON `{ error: string }` with a proper status code. Responses never contain
// anything secret beyond the caller's own session token (returned once, by /auth/verify).

import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import type { Profile } from '../shared/protocol';
import { AuthError, isLoginDomain, isLoginSite, issueNonce, resolveAuthToken, revokeToken, verifyLogin, type LoginSite } from './auth';
import { getLoginOrigins, getPublicConfig } from './config';
import {
  LEADERBOARD_MAX_LIMIT,
  LEADERBOARD_SORTS,
  StoreFullError,
  getLeaderboard,
  isLeaderboardSort,
  sanitizeProfileName,
  setProfileName,
} from './store';

export interface ApiDeps {
  getRoomsInfo(): { publicLobbies: number; playersOnline: number };
}

const BODY_LIMIT_BYTES = 4 * 1024;

// ---------- Rate limiting (in memory, per client IP) ----------

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window counter per key, with a bounded key table. */
export class RateLimiter {
  private readonly hits = new Map<string, Bucket>();
  private calls = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one hit. Returns 0 when allowed, otherwise the ms until the window resets. */
  take(key: string): number {
    const t = this.now();
    if (++this.calls % 1000 === 0 || this.hits.size >= this.maxKeys) this.sweep(t);
    let b = this.hits.get(key);
    if (!b || b.resetAt <= t) {
      if (b) this.hits.delete(key); // re-insert so Map order tracks recency
      b = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, b);
    }
    b.count++;
    return b.count > this.limit ? Math.max(1, b.resetAt - t) : 0;
  }

  private sweep(t: number): void {
    for (const [k, b] of this.hits) if (b.resetAt <= t) this.hits.delete(k);
    // Still full (a flood of distinct keys): forget the oldest windows.
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}

function expandIPv6(ip: string): string[] | null {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  return groups.length === 8 ? groups : null;
}

/** Rate-limit key for a request: the IPv4 address, or the /64 prefix for IPv6 (one subscriber). */
export function clientKey(req: Request): string {
  let ip = (req.ip || req.socket?.remoteAddress || 'unknown').trim().toLowerCase();
  const pct = ip.indexOf('%');
  if (pct >= 0) ip = ip.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const groups = expandIPv6(ip);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip;
}

function limitBy(limiter: RateLimiter): RequestHandler {
  return (req, res, next) => {
    const retryMs = limiter.take(clientKey(req));
    if (retryMs === 0) return next();
    res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
    res.status(429).json({ error: 'Too many requests. Slow down and try again in a moment.' });
  };
}

// ---------- Helpers ----------

let warnedNoOrigin = false;

/**
 * The site a login message is bound to. With PUBLIC_ORIGIN set (recommended in production) it is
 * the configured origin whose host matches the request, else the first one, whatever Host says.
 * Without it, the request's own Host header (https when the request or a proxy says so). Null when
 * that header is missing or malformed.
 */
export function loginSiteFor(req: Request): LoginSite | null {
  const host = (typeof req.headers.host === 'string' ? req.headers.host : '').trim().toLowerCase();
  const origins = getLoginOrigins();
  let uri: string;
  if (origins.length > 0) {
    uri = origins.find((o) => new URL(o).host === host) ?? origins[0];
  } else {
    if (!warnedNoOrigin && process.env.NODE_ENV === 'production') {
      warnedNoOrigin = true;
      console.warn('[api] PUBLIC_ORIGIN is not set: Phantom login messages use the request Host header. Set it to your public origin.');
    }
    if (!isLoginDomain(host)) return null;
    const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
    uri = `${req.protocol === 'https' || forwarded === 'https' ? 'https' : 'http'}://${host}`;
  }
  try {
    const url = new URL(uri);
    const site: LoginSite = { domain: url.host, uri: url.origin };
    return isLoginSite(site) ? site : null;
  } catch {
    return null;
  }
}

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : undefined;
}

type AuthedRequest = Request & { profile?: Profile };

/** Require a valid session token; attaches the profile to the request. */
const requireAuth: RequestHandler = (req, res, next) => {
  const token = bearerToken(req);
  const profile = token ? resolveAuthToken(token) : null;
  if (!profile) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return fail(res, 401, 'Not signed in');
  }
  (req as AuthedRequest).profile = profile;
  next();
};

function bodyField(req: Request, key: string): unknown {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

function queryString(req: Request, key: string): string | undefined {
  const v: unknown = (req.query as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' ? v : undefined;
}

// ---------- Router ----------

export function createApiRouter(deps: ApiDeps): Router {
  const router = express.Router();

  // Separate limiters per router instance (and per endpoint) keep tests and endpoints independent.
  const nonceLimiter = new RateLimiter(30, 60_000);
  const verifyLimiter = new RateLimiter(20, 60_000);
  const logoutLimiter = new RateLimiter(30, 60_000);
  const nameLimiter = new RateLimiter(12, 60_000);

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Reject oversized bodies up front even if an outer parser with a larger limit already ran.
    const length = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > BODY_LIMIT_BYTES) return fail(res, 413, 'Request body too large');
    next();
  });
  router.use(express.json({ limit: BODY_LIMIT_BYTES }));

  router.get('/config', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(getPublicConfig());
  });

  router.get('/auth/nonce', limitBy(nonceLimiter), (req, res) => {
    const address = queryString(req, 'address')?.trim();
    if (!address) return fail(res, 400, 'Missing wallet address');
    const site = loginSiteFor(req);
    if (!site) return fail(res, 400, 'Bad Host header');
    try {
      res.json(issueNonce(address, { site, requester: clientKey(req) }));
    } catch (err) {
      if (err instanceof AuthError) return fail(res, 400, err.message);
      throw err;
    }
  });

  router.post('/auth/verify', limitBy(verifyLimiter), (req, res) => {
    const address = bodyField(req, 'address');
    const nonce = bodyField(req, 'nonce');
    const signature = bodyField(req, 'signature');
    if (typeof address !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
      return fail(res, 400, 'Expected { address, nonce, signature }');
    }
    try {
      res.json(verifyLogin(address.trim(), nonce.trim(), signature.trim()));
    } catch (err) {
      if (err instanceof AuthError) return fail(res, err.code === 'BAD_REQUEST' ? 400 : 401, err.message);
      if (err instanceof StoreFullError) return fail(res, 503, 'Sign-in is temporarily unavailable. Play as a guest for now.');
      throw err;
    }
  });

  router.post('/auth/logout', limitBy(logoutLimiter), (req, res) => {
    const token = bearerToken(req);
    if (token) revokeToken(token);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json((req as AuthedRequest).profile);
  });

  router.post('/me/name', limitBy(nameLimiter), requireAuth, (req, res) => {
    const raw = bodyField(req, 'name');
    if (typeof raw !== 'string') return fail(res, 400, 'Expected { name }');
    const name = sanitizeProfileName(raw);
    if (!name) return fail(res, 400, "Name can't be empty");
    const profile = setProfileName((req as AuthedRequest).profile!.address, name);
    if (!profile) return fail(res, 401, 'Not signed in');
    res.json(profile);
  });

  router.get('/leaderboard', (req, res) => {
    const sort = queryString(req, 'sort') ?? 'wins';
    if (!isLeaderboardSort(sort)) return fail(res, 400, `sort must be one of: ${LEADERBOARD_SORTS.join(', ')}`);
    const rawLimit = queryString(req, 'limit');
    let limit = 50;
    if (rawLimit !== undefined) {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 1) return fail(res, 400, `limit must be an integer from 1 to ${LEADERBOARD_MAX_LIMIT}`);
      limit = Math.min(n, LEADERBOARD_MAX_LIMIT);
    }
    res.json(getLeaderboard(sort, limit));
  });

  router.get('/rooms', (_req, res) => {
    const info = deps.getRoomsInfo();
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    res.json({ publicLobbies: count(info?.publicLobbies), playersOnline: count(info?.playersOnline) });
  });

  // JSON errors for anything thrown above (body parser errors included).
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { status?: unknown; statusCode?: unknown; type?: unknown };
    const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : 500;
    if (status === 413) return fail(res, 413, 'Request body too large');
    if (status >= 400 && status < 500) {
      return fail(res, status, e?.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Bad request');
    }
    console.error('[api] error', err);
    fail(res, 500, 'Internal server error');
  });

  return router;
}
