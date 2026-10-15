// Phantom wallet: sign-in, profile, cosmetics and token burns.
//
// Sign-in never involves a transaction: connect() -> GET /api/auth/nonce -> signMessage(utf8, 'utf8')
// on our own plain-text login message -> POST /api/auth/verify -> { token, profile } kept in
// localStorage ('amongrugs.wallet').
//
// Burns (burn()) are the ONLY transactions this app ever asks Phantom for, and only the one the server
// built for the purchase the player picked:
//   POST /api/burn/intent -> base64 unsigned v0 transaction. Before Phantom opens, the transaction is
//   decoded (@solana/web3.js, loaded lazily so the main bundle stays small) and must be exactly
//   BurnChecked(amount = the price, mint = the configured token, owner = you) + Memo(the intent memo),
//   fee payer = you, no other signer, no lookup tables. Anything else is refused unsigned.
//   -> provider.signAndSendTransaction(tx) -> { intentId, signature } kept in localStorage
//   ('amongrugs.pendingBurns') until POST /api/burn/confirm says confirmed (202s are retried for ~90 s;
//   resumePendingBurns() retries later, e.g. after the tab was closed).
// Mock mode (server BURN_MODE=mock): no Phantom call at all; the confirm uses a "mock_" signature.

import bs58 from 'bs58';
import { cosmeticById, type CosmeticSlot } from '../../shared/cosmetics';
import type { BurnConfig, BurnIntent, BurnIntentRequest, BurnPurpose, BurnReceipt, Profile, PublicConfig } from '../../shared/protocol';
import { shortAddress } from '../../shared/protocol';
import {
  ApiError,
  copyProfile,
  fetchConfig,
  fetchLoginNonce,
  fetchMe,
  postBurnConfirm,
  postBurnIntent,
  postEquip,
  postLoginVerify,
  postLogout,
  postProfileName,
  toProfile,
} from './api';
import type { BurnStage, WalletApi, WalletSession } from './context';

const STORAGE_KEY = 'amongrugs.wallet';
const PENDING_KEY = 'amongrugs.pendingBurns';
const TOKEN_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const MOCK_SIGNATURE_RE = /^mock_[A-Za-z0-9]{8,64}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
/** How long login() waits for a late-injected provider before giving up. */
const PROVIDER_WAIT_MS = 1200;
/** burn(): keep confirming (the server answers 202 while the transaction isn't visible yet) this long. */
const CONFIRM_BUDGET_MS = 90_000;
const CONFIRM_RETRY_MS = 3_000;
/** The server stops accepting confirms a day after the intent; older pending entries are dropped. */
const PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_PENDING = 20;

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** SPL Token instruction index of BurnChecked. */
const BURN_CHECKED = 15;

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
  /** Burns only: the server-built, client-checked BurnChecked + Memo transaction. */
  signAndSendTransaction?(transaction: unknown): Promise<{ signature?: unknown; publicKey?: PhantomPublicKey | null } | undefined>;
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

/**
 * True for our Sign-In-With-Solana style login message (server/auth.ts loginMessage) bound to the
 * page's own host, this wallet and this nonce. A server or proxy asking us to sign anything else
 * (another site's login, or text with control characters) is refused before Phantom opens.
 */
function isOwnLoginMessage(message: string, address: string, nonce: string): boolean {
  if (typeof message !== 'string' || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(message)) return false;
  let host: string;
  try {
    host = window.location.host.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  const lines = message.split('\n');
  if (lines[0] !== `${host} wants you to sign in with your Solana account:` || lines[1] !== address) return false;
  const uri = lines.find((l) => l.startsWith('URI: '))?.slice('URI: '.length) ?? '';
  let uriHost = '';
  try {
    uriHost = new URL(uri).host;
  } catch {
    return false;
  }
  return uriHost === host && lines.includes(`Nonce: ${nonce}`);
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

/** A burn-time wallet failure as a short message. Never claims tokens were burned when they weren't. */
function friendlyBurnError(err: unknown, ticker: string): Error {
  if (err instanceof ApiError) return new Error(err.message);
  const code = (err as { code?: unknown } | null)?.code;
  const msg = err instanceof Error ? err.message : typeof (err as { message?: unknown })?.message === 'string' ? String((err as { message: string }).message) : '';
  if (code === 4001 || /reject|cancel|denied|declined/i.test(msg)) return new Error('You cancelled the burn in Phantom. Nothing was burned.');
  if (/custom program error: 0x1\b/i.test(msg)) return new Error(`Not enough ${ticker} in your wallet. Nothing was burned.`);
  if (/insufficient|prior credit|not enough sol|InsufficientFundsForFee/i.test(msg)) {
    return new Error('Not enough SOL to pay the network fee. Add a little SOL to your wallet and try again. Nothing was burned.');
  }
  if (/blockhash not found|block height exceeded|expired/i.test(msg)) return new Error('The burn request expired before it was sent. Try again.');
  if (code === 4100) return new Error('Phantom did not authorize this site. Connect Phantom again.');
  if (code === 4900) return new Error('Phantom is disconnected. Unlock Phantom and try again.');
  if (code === -32002) return new Error('Phantom already has a pending request. Open Phantom to finish it.');
  return new Error("Phantom couldn't send the burn. Nothing was burned. Try again.");
}

/** Whole tokens a purchase costs, from the public config. Mirrors server/burns.ts priceOf. */
export function expectedBurnAmount(burn: BurnConfig, request: BurnIntentRequest): number | null {
  if (request.purpose === 'ranked') return burn.rankedEntryPrice;
  const item = request.itemId ? cosmeticById(request.itemId) : undefined;
  return item ? Math.max(1, Math.round(item.price * burn.priceMultiplier)) : null;
}

/** The memo the server must bind this purchase to: `AMONGRUGS <purpose>[:<itemId>] <32 hex nonce>`. */
function memoMatches(memo: string, request: BurnIntentRequest): boolean {
  const m = /^AMONGRUGS (ranked|cosmetic:[a-z0-9_]{1,48}) [0-9a-f]{32}$/.exec(memo);
  return !!m && m[1] === (request.purpose === 'ranked' ? 'ranked' : `cosmetic:${request.itemId}`);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
  return v;
}

/** The parts of a web3.js VersionedTransaction the check reads (kept structural: web3.js loads lazily). */
interface TxLike {
  version: 0 | 'legacy';
  message: {
    header: { numRequiredSignatures: number };
    staticAccountKeys: Array<{ toBase58(): string }>;
    compiledInstructions: Array<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }>;
    addressTableLookups: unknown[];
  };
}

/**
 * Null when `tx` is exactly the burn we agreed to: v0, no lookup tables, the player as fee payer and
 * only signer, then BurnChecked(account, mint, owner = player, intent.amountRaw = intent.amount whole
 * tokens) on a token program, then the intent memo. Otherwise a reason (for the console).
 */
export function checkBurnTransaction(tx: TxLike, want: { owner: string; mint: string | null; intent: BurnIntent }): string | null {
  if (tx.version !== 0) return 'not a v0 transaction';
  const msg = tx.message;
  if (msg.addressTableLookups.length !== 0) return 'uses address lookup tables';
  if (msg.header.numRequiredSignatures !== 1) return 'asks for more than one signature';
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  if (keys[0] !== want.owner) return 'fee payer is not the signed-in wallet';
  if (msg.compiledInstructions.length !== 2) return 'unexpected instructions';
  const [burn, memo] = msg.compiledInstructions;

  const program = keys[burn.programIdIndex];
  if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) return 'first instruction is not a token program';
  const data = burn.data;
  if (data.length !== 10 || data[0] !== BURN_CHECKED) return 'first instruction is not BurnChecked';
  const raw = readU64LE(data, 1);
  const decimals = data[9];
  if (raw.toString() !== want.intent.amountRaw) return 'burn amount differs from the request';
  if (raw !== BigInt(want.intent.amount) * 10n ** BigInt(decimals)) return 'burn amount differs from the price';
  if (burn.accountKeyIndexes.length !== 3) return 'BurnChecked has unexpected accounts';
  const [account, mint, authority] = burn.accountKeyIndexes.map((i) => keys[i]);
  // A live burn always names the configured mint; no mint configured means nothing can be checked.
  if (!want.mint) return 'no token mint configured';
  if (mint !== want.mint) return 'burns a different token';
  if (authority !== want.owner) return 'burn authority is not the signed-in wallet';
  if (!account || account === want.owner || account === mint) return 'bad token account';

  if (keys[memo.programIdIndex] !== MEMO_PROGRAM) return 'second instruction is not a memo';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(memo.data);
  } catch {
    return 'memo is not text';
  }
  if (text !== want.intent.memo) return 'memo differs from the request';
  if (memo.accountKeyIndexes.some((i) => keys[i] !== want.owner)) return 'memo has unexpected signers';
  return null;
}

function randomAlphanumeric(n: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(n * 2);
  crypto.getRandomValues(bytes);
  let out = '';
  // 62 symbols: reject bytes >= 248 to stay uniform.
  for (const b of bytes) {
    if (b < 248) out += chars[b % 62];
    if (out.length === n) return out;
  }
  return out + randomAlphanumeric(n - out.length);
}

function signatureString(result: { signature?: unknown } | undefined | null): string | null {
  const raw = result?.signature;
  if (typeof raw === 'string') return SIGNATURE_RE.test(raw) && bs58.decodeUnsafe(raw)?.length === 64 ? raw : null;
  const bytes = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? Uint8Array.from(raw as number[]) : null;
  return bytes && bytes.length === 64 ? bs58.encode(bytes) : null;
}

// ---------- Pending burns (signed, not confirmed yet) ----------

interface PendingBurn {
  intentId: string;
  signature: string;
  address: string;
  purpose: BurnPurpose;
  itemId?: string;
  amount: number;
  at: number;
}

function readPending(): PendingBurn[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    return raw.filter(
      (e): e is PendingBurn =>
        !!e &&
        typeof e === 'object' &&
        typeof e.intentId === 'string' &&
        HEX32_RE.test(e.intentId) &&
        typeof e.signature === 'string' &&
        (SIGNATURE_RE.test(e.signature) || MOCK_SIGNATURE_RE.test(e.signature)) &&
        typeof e.address === 'string' &&
        ADDRESS_RE.test(e.address) &&
        (e.purpose === 'ranked' || e.purpose === 'cosmetic') &&
        typeof e.at === 'number' &&
        e.at > cutoff,
    );
  } catch {
    return [];
  }
}

function writePending(list: PendingBurn[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
  } catch {
    /* storage unavailable: the burn can't be resumed after a reload, but it still confirms now */
  }
}

function addPending(entry: PendingBurn): void {
  writePending([...readPending().filter((e) => e.signature !== entry.signature), entry]);
}

function removePending(signature: string): void {
  writePending(readPending().filter((e) => e.signature !== signature));
}

/** Server answers that end a burn for good: nothing more to retry. */
function isFinalStatus(status: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 409 || status === 410;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  return { token: s.token, profile: copyProfile(s.profile) };
}

function sameSession(a: WalletSession | null, b: WalletSession | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.token === b.token && JSON.stringify(a.profile) === JSON.stringify(b.profile);
}

// ---------- WalletApi ----------

export interface WalletOptions {
  /** burn(): how long to keep confirming before leaving the burn pending (default 90 s). */
  confirmBudgetMs?: number;
  /** Pause between confirm attempts (default 3 s). */
  confirmRetryMs?: number;
}

export function createWallet(options: WalletOptions = {}): WalletApi {
  const confirmBudgetMs = options.confirmBudgetMs ?? CONFIRM_BUDGET_MS;
  const confirmRetryMs = options.confirmRetryMs ?? CONFIRM_RETRY_MS;
  let session: WalletSession | null = readStoredSession();
  let pendingLogin: Promise<WalletSession> | null = null;
  let watchedProvider: PhantomProvider | null = null;
  let burning = false;
  let resuming: Promise<BurnReceipt[]> | null = null;
  let configCache: Promise<PublicConfig> | null = null;
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
    // Only ever sign our own plain-text login message for this site, this exact wallet and nonce.
    if (!isOwnLoginMessage(challenge.message, address, challenge.nonce)) {
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

  /** The server's public config (burn mode, mint, prices), fetched once per page. */
  function burnSettings(): Promise<PublicConfig> {
    if (!configCache) {
      configCache = fetchConfig().catch((err: unknown) => {
        configCache = null;
        throw err;
      });
    }
    return configCache;
  }

  /** A fresher profile from the server for the signed-in wallet. */
  function applyProfile(token: string, profile: Profile): void {
    if (session?.token === token && session.profile.address === profile.address) setSession({ token, profile });
  }

  /** Session gone server-side: sign out locally (pending burns stay stored for the next sign-in). */
  function sessionExpired(token: string, message = 'Session expired. Connect Phantom again.'): Error {
    if (session?.token === token) endSession({ revoke: false, disconnect: false });
    return new Error(message);
  }

  /**
   * POST /api/burn/confirm until it is confirmed, it fails for good, or `budgetMs` runs out (one
   * attempt when 0). Keeps the pending entry unless the burn is settled either way.
   */
  async function confirmPending(token: string, entry: PendingBurn, budgetMs: number): Promise<BurnReceipt> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      try {
        const res = await postBurnConfirm(token, { intentId: entry.intentId, signature: entry.signature });
        if (res.status === 'confirmed') {
          removePending(entry.signature);
          applyProfile(token, res.receipt.profile);
          return res.receipt;
        }
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 401) throw sessionExpired(token, 'Session expired. Connect Phantom again to finish confirming your burn.');
          if (isFinalStatus(err.status)) {
            removePending(entry.signature);
            throw new Error(err.message);
          }
          // 0 (offline), 429, 5xx: retry.
        } else {
          throw err;
        }
      }
      if (Date.now() + confirmRetryMs > deadline) {
        throw new Error('Your burn was sent but is not confirmed yet. It will be checked again; you can also retry in a minute.');
      }
      await sleep(confirmRetryMs);
    }
  }

  /** Phantom: same account as the session, then sign and send the checked transaction. Returns the signature. */
  async function signAndSend(s: WalletSession, intent: BurnIntent, config: PublicConfig): Promise<string> {
    const provider = getProvider();
    if (!provider) throw new Error('Phantom wallet not found. Open this page in Phantom (or install it) and try again.');
    if (typeof provider.signAndSendTransaction !== 'function') {
      throw new Error("This version of Phantom can't send transactions. Update Phantom and try again.");
    }
    let connected: string | null;
    try {
      // Already-approved sites reconnect silently; otherwise Phantom asks to connect.
      const resp = await provider.connect();
      connected = keyToString((resp && typeof resp === 'object' ? resp.publicKey : null) ?? provider.publicKey);
    } catch (err) {
      throw friendlyBurnError(err, config.ticker);
    }
    if (!connected) throw new Error("Phantom isn't connected. Unlock Phantom and try again.");
    watchProvider(provider);
    if (connected !== s.profile.address) {
      throw new Error(
        `Phantom is on another account (${shortAddress(connected)}). Switch Phantom to ${shortAddress(s.profile.address)}, the wallet you signed in with, and try again.`,
      );
    }

    let tx: TxLike;
    try {
      const { VersionedTransaction } = await import('@solana/web3.js');
      tx = VersionedTransaction.deserialize(base64ToBytes(intent.transaction!)) as unknown as TxLike;
    } catch {
      throw new Error("Couldn't prepare the burn transaction. Reload the page and try again.");
    }
    const problem = checkBurnTransaction(tx, { owner: s.profile.address, mint: config.burn.mint, intent });
    if (problem) {
      console.warn(`[wallet] refused to sign the burn transaction: ${problem}`);
      throw new Error('The server sent an unexpected transaction, so nothing was signed. Try again later.');
    }

    let result: { signature?: unknown } | undefined;
    try {
      result = await provider.signAndSendTransaction(tx);
    } catch (err) {
      throw friendlyBurnError(err, config.ticker);
    }
    const signature = signatureString(result);
    if (!signature) throw new Error("Phantom didn't return a transaction signature. Check your wallet activity before trying again.");
    return signature;
  }

  async function doBurn(request: BurnIntentRequest, onStage?: (stage: BurnStage) => void): Promise<BurnReceipt> {
    const stage = (st: BurnStage) => {
      try {
        onStage?.(st);
      } catch (err) {
        console.error('[wallet] onStage callback failed', err);
      }
    };
    const s = session;
    if (!s) throw new Error('Connect Phantom first.');
    if (!request || (request.purpose !== 'ranked' && request.purpose !== 'cosmetic')) throw new Error('Nothing to burn for.');
    if (request.purpose === 'cosmetic' && !(request.itemId && cosmeticById(request.itemId))) throw new Error('Unknown item.');
    const req: BurnIntentRequest = request.purpose === 'cosmetic' ? { purpose: 'cosmetic', itemId: request.itemId } : { purpose: 'ranked' };

    stage('preparing');
    let config: PublicConfig;
    let intent: BurnIntent;
    try {
      config = await burnSettings();
      if (config.burn.mode === 'off') throw new Error('Token burns are not available yet.');
      intent = await postBurnIntent(s.token, req);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw sessionExpired(s.token);
      if (err instanceof ApiError) throw new Error(err.message);
      throw err instanceof Error ? err : new Error("Couldn't start the burn. Try again.");
    }
    // The server must have priced and bound exactly what was asked for.
    if (intent.purpose !== req.purpose || intent.itemId !== req.itemId || !memoMatches(intent.memo, req)) {
      throw new Error('Unexpected answer from the server. Nothing was burned.');
    }
    if (intent.amount !== expectedBurnAmount(config.burn, req)) throw new Error('The price changed. Reload the page and try again.');

    let signature: string;
    if (intent.transaction === null) {
      if (config.burn.mode !== 'mock') throw new Error('Unexpected answer from the server. Nothing was burned.');
      signature = `mock_${randomAlphanumeric(24)}`;
    } else {
      if (config.burn.mode !== 'live') throw new Error('Unexpected answer from the server. Nothing was burned.');
      stage('signing');
      signature = await signAndSend(s, intent, config);
    }

    const entry: PendingBurn = { intentId: intent.intentId, signature, address: s.profile.address, purpose: intent.purpose, amount: intent.amount, at: Date.now() };
    if (intent.itemId) entry.itemId = intent.itemId;
    addPending(entry);
    stage('confirming');
    const receipt = await confirmPending(s.token, entry, confirmBudgetMs);
    stage('done');
    return receipt;
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
        return copyProfile(profile);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          if (session?.token === s.token) endSession({ revoke: false, disconnect: true });
          return null;
        }
        // Offline / server hiccup: keep the cached profile rather than signing the user out.
        return session ? copyProfile(session.profile) : null;
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
        return copyProfile(profile);
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

    async burn(request: BurnIntentRequest, onStage?: (stage: BurnStage) => void): Promise<BurnReceipt> {
      if (burning) throw new Error('A burn is already in progress.');
      burning = true;
      try {
        return await doBurn(request, onStage);
      } finally {
        burning = false;
      }
    },

    resumePendingBurns(): Promise<BurnReceipt[]> {
      if (!resuming) {
        resuming = (async () => {
          const s = session;
          if (!s) return [];
          const receipts: BurnReceipt[] = [];
          // Only this wallet's burns; another account's stay stored for when it signs in again.
          for (const entry of readPending().filter((e) => e.address === s.profile.address)) {
            if (session?.token !== s.token) break;
            try {
              receipts.push(await confirmPending(s.token, entry, 0));
            } catch {
              /* still pending, or settled as failed (then it was removed) */
            }
          }
          return receipts;
        })().finally(() => {
          resuming = null;
        });
      }
      return resuming;
    },

    async equip(slot: CosmeticSlot, itemId: string | null): Promise<Profile> {
      const s = session;
      if (!s) throw new Error('Connect Phantom first.');
      try {
        const profile = await postEquip(s.token, slot, itemId);
        applyProfile(s.token, profile);
        return copyProfile(profile);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw sessionExpired(s.token);
        throw err instanceof ApiError ? new Error(err.message) : new Error("Couldn't change your look. Try again.");
      }
    },
  };

  // Validate a stored session in the background (expired tokens sign out, names/stats refresh).
  if (session) setTimeout(() => void api.refreshProfile(), 0);

  return api;
}
