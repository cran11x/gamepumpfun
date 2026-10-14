// Phantom sign-in. Read-only by design: the only wallet calls made are connect(), signMessage()
// on a plain-text login message, and disconnect(). No transaction is ever built, signed or sent.
//
// Flow: provider.connect() -> address -> GET /api/auth/nonce -> provider.signMessage(utf8, 'utf8')
//       -> POST /api/auth/verify -> { token, profile } kept in localStorage ('amongrugs.wallet').

import bs58 from 'bs58';
import type { Profile } from '../../shared/protocol';
import { ApiError, fetchLoginNonce, fetchMe, postLoginVerify, postLogout, postProfileName, toProfile } from './api';
import type { WalletApi, WalletSession } from './context';

const STORAGE_KEY = 'amongrugs.wallet';
const TOKEN_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** How long login() waits for a late-injected provider before giving up. */
const PROVIDER_WAIT_MS = 1200;

// ---------- Minimal Phantom provider typing (kept local: no global Window augmentation) ----------

interface PhantomPublicKey {
  toString(): string;
  toBase58?(): string;
}

interface PhantomSignResult {
  signature: unknown;
  publicKey?: PhantomPublicKey | null;
}

type ProviderEvent = 'connect' | 'disconnect' | 'accountChanged';

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: PhantomPublicKey | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: PhantomPublicKey | null } | undefined | void>;
  disconnect?(): Promise<void> | void;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<PhantomSignResult | Uint8Array>;
  on?(event: ProviderEvent, handler: (arg?: unknown) => void): void;
}

interface PhantomWindow {
  phantom?: { solana?: PhantomProvider };
  solana?: PhantomProvider;
}

function getProvider(): PhantomProvider | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as PhantomWindow;
  try {
    const p = w.phantom?.solana;
    if (p?.isPhantom && typeof p.signMessage === 'function') return p;
    const legacy = w.solana;
    if (legacy?.isPhantom && typeof legacy.signMessage === 'function') return legacy;
  } catch {
    /* hostile getters on window */
  }
  return null;
}

async function waitForProvider(ms: number): Promise<PhantomProvider | null> {
  const deadline = Date.now() + ms;
  let p = getProvider();
  while (!p && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    p = getProvider();
  }
  return p;
}

function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Opera Mini/i.test(ua)) return true;
  // iPadOS reports a desktop Safari UA.
  return /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/** Re-open this page inside the Phantom mobile app's browser, where the provider exists. */
function openInPhantomApp(): void {
  const url = encodeURIComponent(window.location.href);
  const ref = encodeURIComponent(window.location.origin);
  window.location.href = `https://phantom.app/ul/browse/${url}?ref=${ref}`;
}

function keyToString(key: PhantomPublicKey | null | undefined): string | null {
  if (!key) return null;
  try {
    const s = typeof key.toBase58 === 'function' ? key.toBase58() : key.toString();
    return typeof s === 'string' && ADDRESS_RE.test(s) ? s : null;
  } catch {
    return null;
  }
}

function signatureBytes(result: PhantomSignResult | Uint8Array | null | undefined): Uint8Array | null {
  const raw: unknown = result instanceof Uint8Array ? result : result?.signature;
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw) && raw.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) return Uint8Array.from(raw as number[]);
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
    return Uint8Array.from((raw as { data: number[] }).data);
  }
  if (typeof raw === 'string') return bs58.decodeUnsafe(raw) ?? null;
  return null;
}

/** Turn a wallet / network failure into a short, human error message. */
function friendlyError(err: unknown, fallback: string): Error {
  if (err instanceof ApiError) return new Error(err.message);
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 4001) return new Error('Request cancelled in Phantom.');
  if (code === 4100) return new Error('Phantom did not authorize this site. Try connecting again.');
  if (code === -32002) return new Error('Phantom already has a pending request. Open Phantom to finish it.');
  if (code === 4900) return new Error('Phantom is disconnected. Unlock Phantom and try again.');
  const msg = err instanceof Error ? err.message : '';
  if (/reject|cancel|denied|declined/i.test(msg)) return new Error('Request cancelled in Phantom.');
  return new Error(fallback);
}

// ---------- Session storage ----------

function readStoredSession(): WalletSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: unknown; profile?: unknown };
    const profile = toProfile(parsed?.profile);
    if (typeof parsed?.token !== 'string' || !TOKEN_RE.test(parsed.token) || !profile) return null;
    return { token: parsed.token, profile };
  } catch {
    return null;
  }
}

function writeStoredSession(s: WalletSession | null): void {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: s.token, profile: s.profile }));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode, quota): the session lives in memory only */
  }
}

function copySession(s: WalletSession): WalletSession {
  return { token: s.token, profile: { ...s.profile, stats: { ...s.profile.stats } } };
}

function sameSession(a: WalletSession | null, b: WalletSession | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.token === b.token && JSON.stringify(a.profile) === JSON.stringify(b.profile);
}

// ---------- WalletApi ----------

export function createWallet(): WalletApi {
  let session: WalletSession | null = readStoredSession();
  let pendingLogin: Promise<WalletSession> | null = null;
  let watchedProvider: PhantomProvider | null = null;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (err) {
        console.error('[wallet] onChange listener failed', err);
      }
    }
  }

  function setSession(next: WalletSession | null): void {
    if (sameSession(session, next)) return;
    session = next ? copySession(next) : null;
    writeStoredSession(session);
    emit();
  }

  /** Forget the local session; optionally revoke it server-side and disconnect Phantom. */
  function endSession(opts: { revoke: boolean; disconnect: boolean }): void {
    const old = session;
    setSession(null);
    if (old && opts.revoke) void postLogout(old.token);
    if (opts.disconnect) {
      const p = getProvider();
      if (p && typeof p.disconnect === 'function') {
        try {
          void Promise.resolve(p.disconnect()).catch(() => undefined);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** If the user switches accounts inside Phantom, the old session no longer matches the wallet. */
  function watchProvider(p: PhantomProvider): void {
    if (watchedProvider === p || typeof p.on !== 'function') return;
    watchedProvider = p;
    try {
      p.on('accountChanged', (key) => {
        const next = keyToString(key as PhantomPublicKey | null | undefined);
        if (session && next && next !== session.profile.address) endSession({ revoke: true, disconnect: false });
      });
    } catch {
      /* provider without event support */
    }
  }

  // Other tabs logging in / out.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== null && e.key !== STORAGE_KEY) return;
      const next = readStoredSession();
      if (sameSession(session, next)) return;
      session = next;
      emit();
    });
  }

  async function doLogin(): Promise<WalletSession> {
    let provider = getProvider();
    if (!provider) {
      provider = await waitForProvider(PROVIDER_WAIT_MS);
      if (!provider) {
        if (isMobileBrowser()) {
          openInPhantomApp();
          throw new Error('Opening Phantom… finish signing in inside the Phantom app browser.');
        }
        throw new Error('Phantom wallet not found. Install Phantom from phantom.app, then reload this page.');
      }
    }

    let address: string | null;
    try {
      const resp = await provider.connect();
      address = keyToString((resp && typeof resp === 'object' ? resp.publicKey : null) ?? provider.publicKey);
    } catch (err) {
      throw friendlyError(err, "Couldn't connect to Phantom. Unlock it and try again.");
    }
    if (!address) throw new Error("Phantom didn't share a wallet address. Try again.");
    watchProvider(provider);

    let challenge: { nonce: string; message: string };
    try {
      challenge = await fetchLoginNonce(address);
    } catch (err) {
      throw friendlyError(err, "Couldn't start sign-in. Try again.");
    }
    // Only ever sign our own plain-text login message for this exact wallet and nonce.
    if (!challenge.message.includes(`\nWallet: ${address}\n`) || !challenge.message.includes(`\nNonce: ${challenge.nonce}\n`)) {
      throw new Error('Unexpected sign-in message from the server. Try again later.');
    }

    let signed: PhantomSignResult | Uint8Array;
    try {
      signed = await provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
    } catch (err) {
      throw friendlyError(err, "Couldn't sign the login message. Try again.");
    }
    if (signed && !(signed instanceof Uint8Array)) {
      const signer = keyToString(signed.publicKey);
      if (signer && signer !== address) throw new Error('Phantom signed with a different account. Switch back and try again.');
    }
    const signature = signatureBytes(signed);
    if (!signature || signature.length !== 64) throw new Error('Phantom returned an invalid signature. Try again.');

    let result: { token: string; profile: Profile };
    try {
      result = await postLoginVerify(address, challenge.nonce, bs58.encode(signature));
    } catch (err) {
      throw friendlyError(err, 'Sign-in failed. Try again.');
    }
    if (result.profile.address !== address) throw new Error('Sign-in failed. Try again.');

    const previous = session;
    setSession({ token: result.token, profile: result.profile });
    if (previous && previous.token !== result.token) void postLogout(previous.token);
    return copySession(session!);
  }

  const api: WalletApi = {
    isPhantomAvailable(): boolean {
      return getProvider() !== null;
    },

    getSession(): WalletSession | null {
      return session ? copySession(session) : null;
    },

    login(): Promise<WalletSession> {
      if (!pendingLogin) {
        pendingLogin = doLogin().finally(() => {
          pendingLogin = null;
        });
      }
      return pendingLogin;
    },

    logout(): void {
      endSession({ revoke: true, disconnect: true });
    },

    async refreshProfile(): Promise<Profile | null> {
      const s = session;
      if (!s) return null;
      try {
        const profile = await fetchMe(s.token);
        // Logged out or switched accounts while the request was in flight: report the current state.
        if (session?.token !== s.token) return session ? copySession(session).profile : null;
        setSession({ token: s.token, profile });
        return { ...profile, stats: { ...profile.stats } };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          if (session?.token === s.token) endSession({ revoke: false, disconnect: true });
          return null;
        }
        // Offline / server hiccup: keep the cached profile rather than signing the user out.
        return session ? { ...session.profile, stats: { ...session.profile.stats } } : null;
      }
    },

    async setName(name: string): Promise<Profile> {
      const s = session;
      if (!s) throw new Error('Connect Phantom to save your name.');
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) throw new Error("Name can't be empty.");
      try {
        const profile = await postProfileName(s.token, trimmed);
        if (session?.token === s.token) setSession({ token: s.token, profile });
        return { ...profile, stats: { ...profile.stats } };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          if (session?.token === s.token) endSession({ revoke: false, disconnect: true });
          throw new Error('Session expired. Connect Phantom again.');
        }
        throw err instanceof ApiError ? new Error(err.message) : friendlyError(err, "Couldn't save your name. Try again.");
      }
    },

    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };

  // Validate a stored session in the background (expired tokens sign out, names/stats refresh).
  if (session) setTimeout(() => void api.refreshProfile(), 0);

  return api;
}
