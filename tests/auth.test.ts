import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import express from 'express';
import nacl from 'tweetnacl';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TICKER, GAME_NAME } from '../shared/constants';
import { shortAddress } from '../shared/protocol';
import { createWallet } from '../client/src/wallet';
import { createApiRouter } from '../server/api';
import { AuthError, NONCE_TTL_MS, createAuth, issueNonce, resolveAuthToken, revokeToken, verifyLogin, type Auth } from '../server/auth';
import { getPublicConfig } from '../server/config';
import { SESSION_TTL_MS, flushStore, recordGameResults, resetStore } from '../server/store';

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amongrugs-auth-'));
  process.env.DATA_DIR = dir;
  resetStore();
});

afterAll(() => {
  flushStore();
  resetStore();
  fs.rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

interface Wallet {
  address: string;
  sign(message: string): string;
}

function newWallet(): Wallet {
  const kp = nacl.sign.keyPair();
  return {
    address: bs58.encode(kp.publicKey),
    sign: (message) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)),
  };
}

function authError(fn: () => unknown): AuthError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AuthError);
    return err as AuthError;
  }
  throw new Error('expected an AuthError');
}

describe('auth: nonce + signature login', () => {
  let clock: number;
  let auth: Auth;

  beforeEach(() => {
    clock = Date.UTC(2026, 9, 14, 12, 0, 0);
    auth = createAuth({ now: () => clock });
  });

  it('issues the exact login message for the wallet', () => {
    const w = newWallet();
    const { nonce, message } = auth.issueNonce(w.address);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(message).toBe(
      'AMONG RUGS login\n\n' +
        'Sign this message to prove you own this wallet. This is NOT a transaction and costs nothing.\n\n' +
        `Wallet: ${w.address}\n` +
        `Nonce: ${nonce}\n` +
        'Issued: 2026-10-14T12:00:00.000Z',
    );
    expect(auth.issueNonce(w.address).nonce).not.toBe(nonce);
  });

  it('verifies a valid signature, creates the profile and a session token', () => {
    const w = newWallet();
    const { nonce, message } = auth.issueNonce(w.address);
    const result = auth.verifyLogin(w.address, nonce, w.sign(message));
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.profile).toMatchObject({ address: w.address, name: shortAddress(w.address) });
    expect(result.profile.stats.gamesPlayed).toBe(0);
    expect(auth.resolveAuthToken(result.token)).toEqual(result.profile);
    expect(auth.pendingNonces()).toBe(0);
  });

  it('rejects nonce reuse', () => {
    const w = newWallet();
    const { nonce, message } = auth.issueNonce(w.address);
    const sig = w.sign(message);
    auth.verifyLogin(w.address, nonce, sig);
    expect(authError(() => auth.verifyLogin(w.address, nonce, sig)).code).toBe('NONCE_INVALID');
  });

  it('rejects a wrong signature and burns the nonce', () => {
    const w = newWallet();
    const other = newWallet();
    const { nonce, message } = auth.issueNonce(w.address);
    expect(authError(() => auth.verifyLogin(w.address, nonce, other.sign(message))).code).toBe('SIGNATURE_INVALID');
    // Single use: even the right signature can't use it afterwards.
    expect(authError(() => auth.verifyLogin(w.address, nonce, w.sign(message))).code).toBe('NONCE_INVALID');
  });

  it('rejects a signature over a different message or a tampered signature', () => {
    const w = newWallet();
    const a = auth.issueNonce(w.address);
    expect(authError(() => auth.verifyLogin(w.address, a.nonce, w.sign(a.message + ' '))).code).toBe('SIGNATURE_INVALID');
    const b = auth.issueNonce(w.address);
    const bytes = bs58.decode(w.sign(b.message));
    bytes[10] ^= 0xff;
    expect(authError(() => auth.verifyLogin(w.address, b.nonce, bs58.encode(bytes))).code).toBe('SIGNATURE_INVALID');
  });

  it('rejects a wrong address without burning the real owner nonce', () => {
    const owner = newWallet();
    const attacker = newWallet();
    const { nonce, message } = auth.issueNonce(owner.address);
    // The attacker signs the owner's message with their own key and claims their own address.
    expect(authError(() => auth.verifyLogin(attacker.address, nonce, attacker.sign(message))).code).toBe('NONCE_INVALID');
    // Or claims the owner's address with their own signature.
    expect(authError(() => auth.verifyLogin(owner.address, nonce, attacker.sign(message))).code).toBe('SIGNATURE_INVALID');
    // That attempt consumed it; a fresh nonce still works for the owner.
    const again = auth.issueNonce(owner.address);
    expect(authError(() => auth.verifyLogin(attacker.address, again.nonce, attacker.sign(again.message))).code).toBe(
      'NONCE_INVALID',
    );
    expect(auth.verifyLogin(owner.address, again.nonce, owner.sign(again.message)).profile.address).toBe(owner.address);
  });

  it('rejects an expired nonce (injected clock)', () => {
    const w = newWallet();
    const { nonce, message } = auth.issueNonce(w.address);
    clock += NONCE_TTL_MS;
    expect(authError(() => auth.verifyLogin(w.address, nonce, w.sign(message))).code).toBe('NONCE_INVALID');
  });

  it('accepts a nonce just before expiry and honors a TTL override', () => {
    const w = newWallet();
    const first = auth.issueNonce(w.address);
    clock += NONCE_TTL_MS - 1;
    expect(auth.verifyLogin(w.address, first.nonce, w.sign(first.message)).token).toBeTruthy();

    const short = createAuth({ now: () => clock, nonceTtlMs: 1000 });
    const n = short.issueNonce(w.address);
    clock += 1000;
    expect(authError(() => short.verifyLogin(w.address, n.nonce, w.sign(n.message))).code).toBe('NONCE_INVALID');
    expect(short.pendingNonces()).toBe(0);
  });

  it('rejects malformed input with BAD_REQUEST', () => {
    const w = newWallet();
    expect(authError(() => auth.issueNonce('not-a-wallet')).code).toBe('BAD_REQUEST');
    expect(authError(() => auth.issueNonce(bs58.encode(nacl.randomBytes(31)))).code).toBe('BAD_REQUEST');
    expect(authError(() => auth.issueNonce(undefined as unknown as string)).code).toBe('BAD_REQUEST');
    const { nonce } = auth.issueNonce(w.address);
    expect(authError(() => auth.verifyLogin(w.address, nonce, 'short')).code).toBe('BAD_REQUEST');
    expect(authError(() => auth.verifyLogin(w.address, nonce, bs58.encode(nacl.randomBytes(63)))).code).toBe('BAD_REQUEST');
    expect(authError(() => auth.verifyLogin(w.address, 'nonce!', bs58.encode(nacl.randomBytes(64)))).code).toBe('BAD_REQUEST');
    expect(authError(() => auth.verifyLogin('nope', nonce, bs58.encode(nacl.randomBytes(64)))).code).toBe('BAD_REQUEST');
    expect(authError(() => auth.verifyLogin(w.address, 'ab'.repeat(16), bs58.encode(nacl.randomBytes(64)))).code).toBe(
      'NONCE_INVALID',
    );
  });

  it('caps outstanding nonces globally and per wallet', () => {
    const small = createAuth({ now: () => clock, maxNonces: 3 });
    const wallets = Array.from({ length: 5 }, newWallet);
    const issued = wallets.map((w) => small.issueNonce(w.address));
    expect(small.pendingNonces()).toBe(3);
    // The oldest were evicted.
    expect(authError(() => small.verifyLogin(wallets[0].address, issued[0].nonce, wallets[0].sign(issued[0].message))).code).toBe(
      'NONCE_INVALID',
    );
    expect(small.verifyLogin(wallets[4].address, issued[4].nonce, wallets[4].sign(issued[4].message)).token).toBeTruthy();

    const w = newWallet();
    const many = Array.from({ length: 7 }, () => auth.issueNonce(w.address));
    expect(auth.pendingNonces()).toBe(5);
    expect(authError(() => auth.verifyLogin(w.address, many[0].nonce, w.sign(many[0].message))).code).toBe('NONCE_INVALID');
    expect(auth.verifyLogin(w.address, many[6].nonce, w.sign(many[6].message)).token).toBeTruthy();
  });

  it('resolveAuthToken handles missing, garbage, revoked and expired tokens', () => {
    const w = newWallet();
    const { nonce, message } = auth.issueNonce(w.address);
    const { token } = auth.verifyLogin(w.address, nonce, w.sign(message));
    expect(auth.resolveAuthToken()).toBeNull();
    expect(auth.resolveAuthToken('')).toBeNull();
    expect(auth.resolveAuthToken('garbage')).toBeNull();
    expect(auth.resolveAuthToken(token.toUpperCase())).toBeNull();
    expect(auth.resolveAuthToken(` ${token} `)?.address).toBe(w.address);

    clock += SESSION_TTL_MS + 1;
    expect(auth.resolveAuthToken(token)).toBeNull();

    const second = auth.issueNonce(w.address);
    const fresh = auth.verifyLogin(w.address, second.nonce, w.sign(second.message));
    expect(auth.resolveAuthToken(fresh.token)?.address).toBe(w.address);
    expect(auth.revokeToken(fresh.token)).toBe(true);
    expect(auth.resolveAuthToken(fresh.token)).toBeNull();
  });

  it('logging in again keeps the existing profile and stats', () => {
    const w = newWallet();
    const a = auth.issueNonce(w.address);
    auth.verifyLogin(w.address, a.nonce, w.sign(a.message));
    recordGameResults([{ address: w.address, role: 'rugger', won: true, rugs: 2, tasksDone: 0, correctVotes: 0, wasRugged: false }]);
    const b = auth.issueNonce(w.address);
    const second = auth.verifyLogin(w.address, b.nonce, w.sign(b.message));
    expect(second.profile.stats).toMatchObject({ gamesPlayed: 1, ruggerWins: 1, rugs: 2 });
  });

  it('module-level helpers work end to end with the real clock', () => {
    const w = newWallet();
    const { nonce, message } = issueNonce(w.address);
    const { token, profile } = verifyLogin(w.address, nonce, w.sign(message));
    expect(resolveAuthToken(token)).toEqual(profile);
    expect(() => verifyLogin(w.address, nonce, w.sign(message))).toThrow(AuthError);
  });
});

describe('config', () => {
  it('uses defaults when unset', () => {
    expect(getPublicConfig({})).toEqual({ gameName: GAME_NAME, ticker: DEFAULT_TICKER, contractAddress: null, links: {} });
  });

  it('validates the contract address and only keeps https links', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ca = bs58.encode(nacl.randomBytes(32));
    const cfg = getPublicConfig({
      GAME_NAME: '  AMONG\u0000 RUGS 2  ',
      TICKER: 'rugz',
      CONTRACT_ADDRESS: ` ${ca} `,
      LINK_X: 'https://x.com/amongrugs',
      LINK_TELEGRAM: 'http://t.me/amongrugs',
      LINK_PUMPFUN: 'javascript:alert(1)',
    });
    expect(cfg).toEqual({ gameName: 'AMONG RUGS 2', ticker: '$rugz', contractAddress: ca, links: { x: 'https://x.com/amongrugs' } });
    expect(getPublicConfig({ CONTRACT_ADDRESS: '0xdeadbeef' }).contractAddress).toBeNull();
    expect(getPublicConfig({ CONTRACT_ADDRESS: bs58.encode(nacl.randomBytes(24)) }).contractAddress).toBeNull();
    expect(getPublicConfig({ LINK_X: 'https://user:pass@x.com/' }).links).toEqual({});
    expect(getPublicConfig({ TICKER: '$$RUGS' }).ticker).toBe('$RUGS');
    expect(getPublicConfig({ TICKER: '   ' }).ticker).toBe(DEFAULT_TICKER);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns fresh objects', () => {
    const a = getPublicConfig({ LINK_X: 'https://x.com/a' });
    a.links.x = 'https://evil.example/';
    expect(getPublicConfig({ LINK_X: 'https://x.com/a' }).links.x).toBe('https://x.com/a');
  });
});

/** An express app with the API router mounted exactly like server/index.ts does (outer JSON parser first). */
async function startApi(rooms = { publicLobbies: 2, playersOnline: 7 }): Promise<{ base: string; close(): Promise<void> }> {
  const app = express();
  app.use('/api', express.json({ limit: '16kb' }), createApiRouter({ getRoomsInfo: () => rooms }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('HTTP API', () => {
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ base, close } = await startApi());
  });

  afterAll(async () => {
    await close();
  });

  const get = (p: string, token?: string) => fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const post = (p: string, body: unknown, token?: string) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  async function login(w: Wallet): Promise<{ token: string; profile: { address: string; name: string } }> {
    const n = await get(`/auth/nonce?address=${w.address}`);
    expect(n.status).toBe(200);
    const { nonce, message } = (await n.json()) as { nonce: string; message: string };
    const v = await post('/auth/verify', { address: w.address, nonce, signature: w.sign(message) });
    expect(v.status).toBe(200);
    return (await v.json()) as { token: string; profile: { address: string; name: string } };
  }

  it('GET /config and /rooms', async () => {
    const c = await get('/config');
    expect(c.status).toBe(200);
    const cfg = (await c.json()) as Record<string, unknown>;
    expect(Object.keys(cfg).sort()).toEqual(['contractAddress', 'gameName', 'links', 'ticker']);
    const r = await get('/rooms');
    expect(await r.json()).toEqual({ publicLobbies: 2, playersOnline: 7 });
  });

  it('full login flow, /me and /me/name', async () => {
    const w = newWallet();
    const { token, profile } = await login(w);
    expect(profile.address).toBe(w.address);

    const me = await get('/me', token);
    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(((await me.json()) as { address: string }).address).toBe(w.address);

    const named = await post('/me/name', { name: '  wif\u0007 hat  ' }, token);
    expect(named.status).toBe(200);
    expect(((await named.json()) as { name: string }).name).toBe('wif hat');
    expect((await post('/me/name', { name: ' \u200b ' }, token)).status).toBe(400);
    expect((await post('/me/name', { nope: 1 }, token)).status).toBe(400);

    const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect(logout.status).toBe(204);
    expect((await get('/me', token)).status).toBe(401);
  });

  it('auth errors use 400 / 401 with JSON bodies', async () => {
    const w = newWallet();
    expect((await get('/auth/nonce')).status).toBe(400);
    const bad = await get('/auth/nonce?address=0OIl');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid wallet address' });

    const { nonce, message } = (await (await get(`/auth/nonce?address=${w.address}`)).json()) as { nonce: string; message: string };
    const wrong = await post('/auth/verify', { address: w.address, nonce, signature: newWallet().sign(message) });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBeTruthy();
    expect((await post('/auth/verify', { address: w.address })).status).toBe(400);
    expect((await post('/auth/verify', '{"address": ')).status).toBe(400);

    expect((await get('/me')).status).toBe(401);
    expect((await get('/me', 'f'.repeat(64))).status).toBe(401);
    const noAuth = await post('/me/name', { name: 'x' });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('GET /leaderboard validates sort and limit', async () => {
    const w = newWallet();
    await login(w);
    recordGameResults([{ address: w.address, role: 'holder', won: true, rugs: 0, tasksDone: 5, correctVotes: 4, wasRugged: false }]);
    const lb = await get('/leaderboard?sort=correctVotes&limit=5');
    expect(lb.status).toBe(200);
    const entries = (await lb.json()) as Array<{ address: string; shortAddress: string; stats: { correctVotes: number } }>;
    expect(entries[0]).toMatchObject({ address: w.address, shortAddress: shortAddress(w.address) });
    expect(entries.length).toBeLessThanOrEqual(5);
    expect((await get('/leaderboard')).status).toBe(200);
    expect((await get('/leaderboard?sort=hacks')).status).toBe(400);
    expect((await get('/leaderboard?sort=wins&limit=-1')).status).toBe(400);
  });

  it('rejects oversized bodies', async () => {
    const res = await post('/me/name', { name: 'x'.repeat(5000) }, 'a'.repeat(64));
    expect(res.status).toBe(413);
  });

  it('rate limits the auth endpoints per IP', async () => {
    const w = newWallet();
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await get(`/auth/nonce?address=${w.address}`)).status);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(30);
    const limited = await get(`/auth/nonce?address=${w.address}`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await limited.json()) as { error: string }).error).toMatch(/slow down/i);
    // Other endpoints are unaffected.
    expect((await get('/config')).status).toBe(200);
  });
});

describe('client wallet (mock Phantom)', () => {
  const realFetch = globalThis.fetch.bind(globalThis);
  const storage = new Map<string, string>();
  const memoryStorage = {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    key: (i: number) => [...storage.keys()][i] ?? null,
    get length() {
      return storage.size;
    },
  };
  let apiBase: string;
  let close: () => Promise<void>;
  let win: { location: { href: string; origin: string }; addEventListener(): void; phantom?: unknown; solana?: unknown };

  type SignMode = 'object' | 'raw';
  function mockPhantom(opts: { mode?: SignMode; rejectConnect?: boolean } = {}) {
    const kp = nacl.sign.keyPair();
    const address = bs58.encode(kp.publicKey);
    const calls: string[] = [];
    const signed: string[] = [];
    const forbidden = (name: string) => () => {
      calls.push(name);
      throw new Error(`${name} must never be called`);
    };
    const provider = {
      isPhantom: true,
      publicKey: null as { toString(): string } | null,
      async connect() {
        calls.push('connect');
        if (opts.rejectConnect) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        provider.publicKey = { toString: () => address };
        return { publicKey: provider.publicKey };
      },
      async disconnect() {
        calls.push('disconnect');
      },
      async signMessage(message: Uint8Array, display?: string) {
        calls.push(`signMessage:${display}`);
        expect(message).toBeInstanceOf(Uint8Array);
        signed.push(new TextDecoder().decode(message));
        const signature = nacl.sign.detached(message, kp.secretKey);
        return opts.mode === 'raw' ? signature : { signature, publicKey: provider.publicKey };
      },
      on() {},
      signTransaction: forbidden('signTransaction'),
      signAllTransactions: forbidden('signAllTransactions'),
      signAndSendTransaction: forbidden('signAndSendTransaction'),
      request: forbidden('request'),
    };
    return { provider, address, calls, signed };
  }

  beforeAll(async () => {
    ({ base: apiBase, close } = await startApi());
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(() => {
    storage.clear();
    win = { location: { href: 'https://rugs.example/?room=ABCD', origin: 'https://rugs.example' }, addEventListener() {} };
    vi.stubGlobal('window', win);
    vi.stubGlobal('localStorage', memoryStorage);
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => realFetch(apiBase + String(input).replace(/^\/api/, ''), init));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs in with connect + signMessage only, and stores the session', async () => {
    const phantom = mockPhantom();
    win.phantom = { solana: phantom.provider };
    const wallet = createWallet();
    expect(wallet.isPhantomAvailable()).toBe(true);
    expect(wallet.getSession()).toBeNull();
    const changes = vi.fn();
    wallet.onChange(changes);

    const session = await wallet.login();
    expect(phantom.calls).toEqual(['connect', 'signMessage:utf8']);
    expect(phantom.signed[0]).toMatch(new RegExp(`^AMONG RUGS login\n\n.*\n\nWallet: ${phantom.address}\nNonce: [0-9a-f]{32}\nIssued: `, 's'));
    expect(session.profile.address).toBe(phantom.address);
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(wallet.getSession()).toEqual(session);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.get('amongrugs.wallet')!)).toEqual({ token: session.token, profile: session.profile });
    expect(resolveAuthToken(session.token)?.address).toBe(phantom.address);

    // A new page load restores the session from storage.
    const reloaded = createWallet();
    expect(reloaded.getSession()?.token).toBe(session.token);
  });

  it('accepts a raw Uint8Array signature (legacy provider) via window.solana', async () => {
    const phantom = mockPhantom({ mode: 'raw' });
    win.solana = phantom.provider;
    const wallet = createWallet();
    expect(wallet.isPhantomAvailable()).toBe(true);
    const session = await wallet.login();
    expect(session.profile.address).toBe(phantom.address);
  });

  it('setName, refreshProfile and logout', async () => {
    const phantom = mockPhantom();
    win.phantom = { solana: phantom.provider };
    const wallet = createWallet();
    const { token } = await wallet.login();

    const profile = await wallet.setName('  moon\u0000boy  ');
    expect(profile.name).toBe('moonboy');
    expect(wallet.getSession()?.profile.name).toBe('moonboy');
    expect(JSON.parse(storage.get('amongrugs.wallet')!).profile.name).toBe('moonboy');
    await expect(wallet.setName('   ')).rejects.toThrow(/empty/i);

    expect((await wallet.refreshProfile())?.name).toBe('moonboy');

    wallet.logout();
    expect(wallet.getSession()).toBeNull();
    expect(storage.has('amongrugs.wallet')).toBe(false);
    expect(phantom.calls).toContain('disconnect');
    await vi.waitFor(() => expect(resolveAuthToken(token)).toBeNull());
    await expect(wallet.setName('x')).rejects.toThrow(/connect phantom/i);
    expect(await wallet.refreshProfile()).toBeNull();
  });

  it('refreshProfile logs out when the server says 401', async () => {
    const phantom = mockPhantom();
    win.phantom = { solana: phantom.provider };
    const wallet = createWallet();
    const { token } = await wallet.login();
    revokeToken(token);
    const changes = vi.fn();
    wallet.onChange(changes);
    expect(await wallet.refreshProfile()).toBeNull();
    expect(wallet.getSession()).toBeNull();
    expect(storage.has('amongrugs.wallet')).toBe(false);
    expect(changes).toHaveBeenCalled();
  });

  it('keeps the cached profile when the server is unreachable', async () => {
    const phantom = mockPhantom();
    win.phantom = { solana: phantom.provider };
    const wallet = createWallet();
    const session = await wallet.login();
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')));
    expect(await wallet.refreshProfile()).toEqual(session.profile);
    expect(wallet.getSession()?.token).toBe(session.token);
  });

  it('turns a rejected connect into a friendly error', async () => {
    const phantom = mockPhantom({ rejectConnect: true });
    win.phantom = { solana: phantom.provider };
    const wallet = createWallet();
    await expect(wallet.login()).rejects.toThrow('Request cancelled in Phantom.');
    expect(wallet.getSession()).toBeNull();
  });

  it('asks desktop users to install Phantom', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130', maxTouchPoints: 0 });
    const wallet = createWallet();
    expect(wallet.isPhantomAvailable()).toBe(false);
    await expect(wallet.login()).rejects.toThrow(/install phantom/i);
    expect(win.location.href).toBe('https://rugs.example/?room=ABCD');
  });

  it('deep-links mobile browsers into the Phantom app', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', maxTouchPoints: 5 });
    const wallet = createWallet();
    await expect(wallet.login()).rejects.toThrow(/phantom/i);
    expect(win.location.href).toBe(
      `https://phantom.app/ul/browse/${encodeURIComponent('https://rugs.example/?room=ABCD')}?ref=${encodeURIComponent('https://rugs.example')}`,
    );
  });

  it('ignores corrupt stored sessions', () => {
    storage.set('amongrugs.wallet', '{"token": "nope", "profile": 5}');
    expect(createWallet().getSession()).toBeNull();
    storage.set('amongrugs.wallet', 'not json');
    expect(createWallet().getSession()).toBeNull();
  });
});
