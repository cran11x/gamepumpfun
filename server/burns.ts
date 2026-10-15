// Burn service (SPEC "Burn flow"): intents, confirmation and grants. Routes live in server/api.ts.
//
//   createIntent(wallet, {purpose, itemId?})
//     validates the purchase, prices it server-side, binds it to a random nonce carried in the memo
//     `AMONGRUGS <purpose>[:<itemId>] <nonce>`, and (live) builds the unsigned BurnChecked + Memo
//     transaction from one of the player's token accounts holding enough.
//   confirm(wallet, {intentId, signature})
//     the intent must be the caller's, still confirmable and unpaid; the signature must never have paid
//     for anything else. Live: polls getTransaction (jsonParsed) for ~25 s and verifies it
//     semantically (server/solana.ts verifyBurn); not found yet -> pending (HTTP 202). Mock: the
//     signature must look like `mock_<alphanumerics>`. Then grants (ticket +1 or the cosmetic) and
//     records the burn in the store, all in one step. Re-confirming the same intent with the same
//     signature returns the original receipt.
//
// Nothing the client says about amounts or success is trusted: prices come from the server's config,
// and success only from the chain.
//
// Intents are kept in server/store.ts (memory + db.json), so a restart between "signed in Phantom"
// and "confirmed" doesn't lose a burn. Lifetime: open for INTENT_TTL_MS (the transaction's blockTime
// must fall in that window); unconfirmed intents can still be confirmed for UNCLAIMED_GRACE_MS after
// that, or for CLAIMED_RETENTION_MS after creation once the chain showed a transaction this wallet
// signed for it (or the chain could not be asked: an RPC outage must not cost anyone their burn).
//
// Abuse limits (a confirm makes the server poll its RPC): at most MAX_SIGNATURES_PER_INTENT distinct
// signatures per intent (bound before any lookup), MAX_STORED_INTENTS_PER_WALLET stored intents per
// wallet, and getTransaction lookups budgeted per wallet and in total. A confirm that runs out of
// budget answers pending (HTTP 202), and the client retries later.

import { randomBytes } from 'node:crypto';
import { cosmeticById } from '../shared/cosmetics';
import type { BurnConfig, BurnIntent, BurnPurpose, BurnReceipt, BurnRecord, BurnStats } from '../shared/protocol';
import { shortAddress } from '../shared/protocol';
import { getMintDecimals, getPublicConfig, getBurnSettings, setMintDecimals, type BurnSettings } from './config';
import {
  MintConfigError,
  buildBurnTransaction,
  createConnectionRpc,
  explorerTxUrl,
  isTransactionSignature,
  loadMintInfo,
  pickTokenAccount,
  serializeTransaction,
  toRawAmount,
  totalBalance,
  verifyBurn,
  type MintInfo,
  type SolanaRpc,
} from './solana';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  MAX_BURN_INTENTS,
  MAX_RANKED_TICKETS,
  bindBurnIntentSignature,
  countBurnIntents,
  deleteBurnIntent,
  getBurnByIntent,
  getBurnBySignature,
  getBurnIntent,
  getBurnTotals,
  getProfile,
  grantBurn,
  listBurnIntents,
  markBurnIntentClaimed,
  pruneBurnIntents,
  putBurnIntent,
  type StoredBurn,
  type StoredBurnIntent,
} from './store';

export const INTENT_TTL_MS = 10 * 60 * 1000;
/** An intent nobody tried to confirm can still be confirmed this long after it expired. */
export const UNCLAIMED_GRACE_MS = 15 * 60 * 1000;
/** An intent a confirm call named a signature for stays confirmable this long after creation. */
export const CLAIMED_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_OPEN_INTENTS_PER_WALLET = 5;
/** Every intent a wallet has stored (open, in its grace period, or claimed) counts toward this. */
export const MAX_STORED_INTENTS_PER_WALLET = 10;
/** Distinct signatures confirm calls may name for one intent (the first, plus one re-sign). */
export const MAX_SIGNATURES_PER_INTENT = 2;
/** getTransaction lookups per minute: per wallet, and for the whole server (token buckets). */
export const LOOKUPS_PER_WALLET_PER_MINUTE = 40;
export const LOOKUPS_PER_MINUTE = 1200;
/** A cosmetic intent is handed out again (with a fresh transaction) only with this much time left. */
const REUSE_MIN_LEFT_MS = 2 * 60 * 1000;
/** Allowed drift between this server's clock and the cluster's blockTime. */
export const BLOCK_TIME_SKEW_MS = 2 * 60 * 1000;
export const MEMO_PREFIX = 'AMONGRUGS';
export const MOCK_SIGNATURE_RE = /^mock_[A-Za-z0-9]{8,64}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const MAX_CONFIRMS_IN_FLIGHT = 200;
const MAX_CONFIRMS_IN_FLIGHT_PER_WALLET = 3;
const PRUNE_EVERY_MS = 30_000;

/** A refused burn request: HTTP status + a short message safe to show the player. */
export class BurnError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BurnError';
  }
}

export type ConfirmOutcome = { status: 'confirmed'; receipt: BurnReceipt } | { status: 'pending' };

export interface BurnService {
  readonly mode: BurnSettings['mode'];
  /** Live mode: start reading the mint (retried in the background). Idempotent. */
  start(): void;
  stop(): void;
  /** Resolves once the mint is known (live), immediately otherwise. False when it can't be. */
  ready(): Promise<boolean>;
  publicConfig(): BurnConfig;
  createIntent(wallet: string, body: unknown): Promise<BurnIntent>;
  confirm(wallet: string, body: unknown): Promise<ConfirmOutcome>;
  stats(): BurnStats;
}

export interface BurnServiceOptions {
  settings: BurnSettings;
  /** Live mode RPC (default: a Connection to settings.rpcUrl). */
  rpc?: SolanaRpc;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Ticker for messages (default: the public config's). */
  ticker?: () => string;
  /** How long one confirm call polls for the transaction (default 25 s) and how often. */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Mint read retry backoff bounds (default 2 s .. 60 s). */
  mintRetryMinMs?: number;
  mintRetryMaxMs?: number;
  /** getTransaction budgets (default LOOKUPS_PER_WALLET_PER_MINUTE / LOOKUPS_PER_MINUTE). */
  lookupsPerWalletPerMinute?: number;
  lookupsPerMinute?: number;
  log?: (...args: unknown[]) => void;
}

/** Token buckets refilled continuously at `perMinute`, holding at most `burst`. */
class LookupBudget {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {}

  private level(b: { tokens: number; at: number }, t: number): number {
    return Math.min(this.burst, b.tokens + (Math.max(0, t - b.at) * this.perMinute) / 60_000);
  }

  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = this.level(b, t);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) {
      // A full bucket is the same as no bucket.
      for (const [k, v] of this.buckets) if (this.level(v, t) >= this.burst) this.buckets.delete(k);
    }
    return true;
  }
}

/** The transaction is `signature`'s own (its first signature) and `wallet` signed it. */
function signedBy(tx: ParsedTransactionWithMeta, signature: string, wallet: string): boolean {
  if (tx.transaction?.signatures?.[0] !== signature) return false;
  return (tx.transaction.message?.accountKeys ?? []).some((k) => k.signer === true && k.pubkey?.toBase58?.() === wallet);
}

/** No signature was ever named for it and the chain never vouched for it: an abandoned Phantom prompt. */
function isIdle(i: StoredBurnIntent): boolean {
  return !i.claimed && !(i.signatures && i.signatures.length > 0);
}

/** Whole tokens one purchase costs. Mirrors client/src/wallet.ts expectedBurnAmount. */
export function priceOf(settings: Pick<BurnSettings, 'rankedEntryPrice' | 'priceMultiplier'>, purpose: BurnPurpose, itemId?: string): number | null {
  if (purpose === 'ranked') return settings.rankedEntryPrice;
  const item = itemId ? cosmeticById(itemId) : undefined;
  if (!item) return null;
  return Math.max(1, Math.round(item.price * settings.priceMultiplier));
}

export function burnMemo(purpose: BurnPurpose, itemId: string | undefined, nonce: string): string {
  return `${MEMO_PREFIX} ${purpose}${purpose === 'cosmetic' ? `:${itemId}` : ''} ${nonce}`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function field(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

/** Last moment `intent` can be confirmed. */
export function confirmDeadline(intent: Pick<StoredBurnIntent, 'createdAt' | 'expiresAt' | 'claimed'>): number {
  return intent.claimed ? intent.createdAt + CLAIMED_RETENTION_MS : intent.expiresAt + UNCLAIMED_GRACE_MS;
}

export function createBurnService(opts: BurnServiceOptions): BurnService {
  const settings = { ...opts.settings };
  const mode = settings.mode;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ticker = opts.ticker ?? (() => getPublicConfig().ticker);
  const pollTimeoutMs = opts.pollTimeoutMs ?? 25_000;
  const pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? 2_000);
  const retryMin = opts.mintRetryMinMs ?? 2_000;
  const retryMax = opts.mintRetryMaxMs ?? 60_000;
  const log = opts.log ?? ((...args: unknown[]) => console.warn('[burns]', ...args));
  const rpc: SolanaRpc | null = mode === 'live' ? (opts.rpc ?? createConnectionRpc(settings.rpcUrl)) : null;
  const walletPerMinute = Math.max(1, opts.lookupsPerWalletPerMinute ?? LOOKUPS_PER_WALLET_PER_MINUTE);
  const globalPerMinute = Math.max(1, opts.lookupsPerMinute ?? LOOKUPS_PER_MINUTE);
  const walletLookups = new LookupBudget(walletPerMinute, walletPerMinute, now);
  const globalLookups = new LookupBudget(globalPerMinute, Math.max(1, Math.ceil(globalPerMinute / 6)), now);

  if (mode === 'live' && !settings.mint) throw new Error('live burn mode needs a mint');

  // ---------- Mint ----------

  let mintInfo: MintInfo | null = null;
  let mintFatal: string | null = null;
  let mintLoad: Promise<boolean> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = retryMin;
  let stopped = false;

  function loadMint(): Promise<boolean> {
    if (mode !== 'live') return Promise.resolve(true);
    if (mintInfo) return Promise.resolve(true);
    if (mintFatal) return Promise.resolve(false);
    if (mintLoad) return mintLoad;
    mintLoad = loadMintInfo(rpc!, settings.mint!)
      .then((info) => {
        mintInfo = info;
        setMintDecimals(info.mint, info.decimals);
        retryDelay = retryMin;
        for (const risk of info.risks ?? []) log(`WARNING: ${risk}.`);
        return true;
      })
      .catch((err: unknown) => {
        if (err instanceof MintConfigError) {
          mintFatal = err.message;
          console.error(`[burns] ${err.message}. Token burns are disabled until this is fixed.`);
        } else {
          log(`could not read the mint yet (${(err as Error)?.message ?? err}); retrying in ${Math.round(retryDelay / 1000)} s`);
          scheduleMintRetry();
        }
        return false;
      })
      .finally(() => {
        mintLoad = null;
      });
    return mintLoad;
  }

  function scheduleMintRetry(): void {
    if (stopped || retryTimer || mintInfo || mintFatal) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void loadMint();
    }, retryDelay);
    retryTimer.unref?.();
    retryDelay = Math.min(retryMax, retryDelay * 2);
  }

  // ---------- Intent housekeeping ----------

  let lastPrune = -Infinity;

  function prune(t: number, force = false): void {
    if (!force && t - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = t;
    pruneBurnIntents((i) => t > confirmDeadline(i));
  }

  function isOpen(i: StoredBurnIntent, t: number): boolean {
    return t < i.expiresAt;
  }

  // ---------- Receipts ----------

  function explorerUrl(signature: string): string | null {
    return MOCK_SIGNATURE_RE.test(signature) ? null : explorerTxUrl(signature, settings.cluster);
  }

  function receiptFor(burn: StoredBurn, wallet: string): BurnReceipt {
    const profile = getProfile(wallet);
    if (!profile) throw new BurnError(401, 'Not signed in');
    const receipt: BurnReceipt = {
      status: 'confirmed',
      signature: burn.signature,
      amount: burn.amount,
      purpose: burn.purpose,
      explorerUrl: explorerUrl(burn.signature),
      profile,
    };
    if (burn.itemId !== undefined) receipt.itemId = burn.itemId;
    return receipt;
  }

  // ---------- Intents ----------

  async function createIntent(wallet: string, body: unknown): Promise<BurnIntent> {
    if (mode === 'off') throw new BurnError(503, 'Token burns are not enabled');
    const purpose = field(body, 'purpose');
    const rawItem = field(body, 'itemId');
    if (purpose !== 'ranked' && purpose !== 'cosmetic') throw new BurnError(400, 'purpose must be "ranked" or "cosmetic"');
    let itemId: string | undefined;
    if (purpose === 'cosmetic') {
      if (typeof rawItem !== 'string' || !cosmeticById(rawItem)) throw new BurnError(400, 'Unknown item');
      itemId = rawItem;
    } else if (rawItem !== undefined && rawItem !== null) {
      throw new BurnError(400, 'A ranked ticket has no item');
    }
    const amount = priceOf(settings, purpose, itemId)!;

    /** An intent of this wallet for the same cosmetic that can still be confirmed. */
    const sameItemIntent = (t: number): StoredBurnIntent | undefined =>
      purpose === 'cosmetic' ? listBurnIntents(wallet).find((i) => i.purpose === 'cosmetic' && i.itemId === itemId && t <= confirmDeadline(i)) : undefined;

    /** Re-run after every await: the profile or the open intents may have changed meanwhile. */
    const checkPurchasable = (): void => {
      const profile = getProfile(wallet);
      if (!profile) throw new BurnError(401, 'Not signed in');
      if (purpose === 'cosmetic' && profile.cosmetics.owned.includes(itemId!)) {
        throw new BurnError(409, `You already own ${cosmeticById(itemId!)!.name}`);
      }
      if (purpose === 'ranked' && profile.rankedTickets >= MAX_RANKED_TICKETS) throw new BurnError(409, 'You have the maximum number of tickets');
      // A second burn for an item that is already on its way would burn the price twice for one unlock.
      const same = sameItemIntent(now());
      if (same && !isIdle(same)) {
        throw new BurnError(409, `A burn for ${cosmeticById(itemId!)!.name} is already waiting to confirm. Give it a minute.`);
      }
    };
    checkPurchasable();

    let decimals: number;
    let mint: MintInfo | null = null;
    if (mode === 'live') {
      if (!(await loadMint())) {
        throw new BurnError(503, mintFatal ? 'Token burns are unavailable right now' : 'Solana RPC is unavailable. Try again in a moment.');
      }
      mint = mintInfo!;
      decimals = mint.decimals;
    } else {
      decimals = getMintDecimals(settings.mint);
    }
    let amountRaw: bigint;
    try {
      amountRaw = toRawAmount(amount, decimals);
    } catch {
      log(`price ${amount} with ${decimals} decimals does not fit a u64; check RANKED_ENTRY_PRICE / COSMETIC_PRICE_MULTIPLIER`);
      throw new BurnError(503, 'Token burns are unavailable right now');
    }

    // An open, untouched intent for the same cosmetic (a rejected Phantom prompt, another tab) is handed
    // out again with a fresh transaction rather than doubled: both carry the same memo, so they can pay
    // for the item only once.
    const candidate = sameItemIntent(now());
    const reuse =
      candidate && isIdle(candidate) && now() < candidate.expiresAt - REUSE_MIN_LEFT_MS && candidate.amountRaw === amountRaw.toString() && candidate.decimals === decimals
        ? candidate
        : null;
    const nonce = reuse ? reuse.nonce : randomBytes(16).toString('hex');
    const memo = reuse ? reuse.memo : burnMemo(purpose, itemId, nonce);

    let transaction: string | null = null;
    if (mode === 'live') {
      let accounts;
      let blockhash: string;
      try {
        accounts = await rpc!.getTokenAccountsByOwner(wallet, mint!.mint);
      } catch (err) {
        log('getTokenAccountsByOwner failed:', (err as Error)?.message ?? err);
        throw new BurnError(503, 'Solana RPC is unavailable. Try again in a moment.');
      }
      const account = pickTokenAccount(accounts, { owner: wallet, mint: mint!, amountRaw });
      if (!account) {
        const have = totalBalance(accounts, wallet, mint!.mint) / 10n ** BigInt(decimals);
        throw new BurnError(409, `Not enough ${ticker()}. This costs ${fmt(amount)}, your wallet has ${fmt(Number(have))}.`);
      }
      try {
        blockhash = (await rpc!.getLatestBlockhash()).blockhash;
      } catch (err) {
        log('getLatestBlockhash failed:', (err as Error)?.message ?? err);
        throw new BurnError(503, 'Solana RPC is unavailable. Try again in a moment.');
      }
      transaction = serializeTransaction(
        buildBurnTransaction({ owner: wallet, tokenAccount: account.pubkey, mint: mint!, amountRaw, memo, recentBlockhash: blockhash }),
      );
    }

    // Everything below is synchronous: the checks and the insert can't interleave with another request.
    checkPurchasable();
    const t = now();
    prune(t);

    if (reuse) {
      const again = getBurnIntent(reuse.id);
      // The transaction above carries this intent's memo; if the intent changed meanwhile, start over.
      if (!again || !isIdle(again) || t > confirmDeadline(again)) throw new BurnError(409, 'Your burn request changed. Try again.');
      const view: BurnIntent = {
        intentId: again.id,
        purpose,
        amount: again.amount,
        amountRaw: again.amountRaw,
        memo: again.memo,
        transaction,
        expiresAt: again.expiresAt,
      };
      if (itemId !== undefined) view.itemId = itemId;
      return view;
    }

    const open = listBurnIntents(wallet).filter((i) => isOpen(i, t));
    if (open.length >= MAX_OPEN_INTENTS_PER_WALLET) {
      // Make room by dropping the oldest intent nobody ever tried to confirm (an abandoned Phantom
      // prompt). Intents with a signature named for them are never dropped.
      const abandoned = open.find(isIdle);
      if (!abandoned) throw new BurnError(409, 'Too many burns in progress. Wait for them to confirm.');
      deleteBurnIntent(abandoned.id);
    }
    // Every stored intent counts, not only open ones, so nobody piles up intents a day at a time.
    const stored = listBurnIntents(wallet);
    if (stored.length >= MAX_STORED_INTENTS_PER_WALLET) {
      const idle = stored.filter(isIdle);
      for (const i of idle.slice(0, stored.length - MAX_STORED_INTENTS_PER_WALLET + 1)) deleteBurnIntent(i.id);
      if (listBurnIntents(wallet).length >= MAX_STORED_INTENTS_PER_WALLET) {
        throw new BurnError(409, 'Too many unconfirmed burns. Wait for them to confirm or expire.');
      }
    }
    if (countBurnIntents() >= MAX_BURN_INTENTS) {
      prune(t, true);
      if (countBurnIntents() >= MAX_BURN_INTENTS) throw new BurnError(503, 'Too many burns in progress. Try again in a few minutes.');
    }

    let id = randomBytes(16).toString('hex');
    while (getBurnIntent(id) || getBurnByIntent(id)) id = randomBytes(16).toString('hex');
    const record: StoredBurnIntent = {
      id,
      address: wallet,
      purpose,
      amount,
      amountRaw: amountRaw.toString(),
      decimals,
      nonce,
      memo,
      mode: mode === 'live' ? 'live' : 'mock',
      createdAt: t,
      expiresAt: t + INTENT_TTL_MS,
      claimed: false,
    };
    if (itemId !== undefined) record.itemId = itemId;
    if (!putBurnIntent(record)) throw new BurnError(500, 'Could not save the burn request');

    const intent: BurnIntent = {
      intentId: id,
      purpose,
      amount,
      amountRaw: record.amountRaw,
      memo,
      transaction,
      expiresAt: record.expiresAt,
    };
    if (itemId !== undefined) intent.itemId = itemId;
    return intent;
  }

  // ---------- Confirm ----------

  /** In-flight confirms by signature + wallet + intent: one caller can never block another's confirm. */
  const inFlight = new Map<string, Promise<ConfirmOutcome>>();
  const inFlightPerWallet = new Map<string, number>();

  /** The intent this confirm is for, after every ownership / state check. Throws BurnError. */
  function intentFor(wallet: string, intentId: string, signature: string): StoredBurnIntent | { receipt: BurnReceipt } {
    const used = getBurnBySignature(signature);
    if (used) {
      if (used.intentId === intentId && used.address === wallet) return { receipt: receiptFor(used, wallet) };
      throw new BurnError(409, 'This transaction was already used for another purchase.');
    }
    const intent = getBurnIntent(intentId);
    if (!intent) {
      const paid = getBurnByIntent(intentId);
      if (paid && paid.address === wallet) throw new BurnError(409, 'This burn was already confirmed with another transaction.');
      throw new BurnError(404, 'Burn request not found or expired. Start a new one.');
    }
    if (intent.address !== wallet) throw new BurnError(403, 'This burn request belongs to another wallet.');
    if (intent.mode !== (mode === 'live' ? 'live' : 'mock')) throw new BurnError(409, 'This burn request is no longer valid. Start a new one.');
    if (now() > confirmDeadline(intent)) throw new BurnError(409, 'This burn request expired. Start a new one.');
    return intent;
  }

  function grant(intent: StoredBurnIntent, signature: string, wallet: string): ConfirmOutcome {
    const result = grantBurn({
      signature,
      intentId: intent.id,
      address: wallet,
      purpose: intent.purpose,
      itemId: intent.itemId,
      amount: intent.amount,
      amountRaw: intent.amountRaw,
      at: now(),
    });
    if (!result.ok) {
      if (result.reason === 'signature_used') throw new BurnError(409, 'This transaction was already used for another purchase.');
      if (result.reason === 'intent_used') throw new BurnError(409, 'This burn was already confirmed with another transaction.');
      throw new BurnError(500, 'Could not record the burn');
    }
    deleteBurnIntent(intent.id);
    return { status: 'confirmed', receipt: receiptFor(result.burn, wallet) };
  }

  async function confirmLive(intent: StoredBurnIntent, signature: string, wallet: string): Promise<ConfirmOutcome> {
    const deadline = now() + pollTimeoutMs;
    let tx: ParsedTransactionWithMeta | null = null;
    /** The chain couldn't be asked (RPC error, or the server-wide lookup budget ran out). */
    let unasked = false;
    for (;;) {
      // Out of this wallet's own budget: pending, try later. Out of the server's: same, but it isn't
      // the player's doing, so their intent is kept as if the chain had vouched for it.
      if (!walletLookups.take(wallet)) break;
      if (!globalLookups.take('*')) {
        unasked = true;
        break;
      }
      try {
        tx = await rpc!.getParsedTransaction(signature);
      } catch (err) {
        log('getTransaction failed:', (err as Error)?.message ?? err);
        tx = null;
        unasked = true;
      }
      if (tx || stopped || now() + pollIntervalMs > deadline) break;
      await sleep(pollIntervalMs);
    }
    // Keep the intent confirmable for a day only when the chain shows this wallet signed this very
    // transaction, or when the chain couldn't be asked. Junk signatures never extend an intent.
    if (tx ? signedBy(tx, signature, wallet) : unasked) markBurnIntentClaimed(intent.id);
    if (!tx) return { status: 'pending' };
    const check = verifyBurn(tx, {
      signature,
      wallet,
      mint: settings.mint!,
      amountRaw: BigInt(intent.amountRaw),
      memo: intent.memo,
      notBefore: Math.floor((intent.createdAt - BLOCK_TIME_SKEW_MS) / 1000),
      notAfter: Math.ceil((intent.expiresAt + BLOCK_TIME_SKEW_MS) / 1000),
    });
    if (!check.ok) {
      if (check.reason === 'no_block_time' || check.reason === 'no_meta') return { status: 'pending' };
      throw new BurnError(400, `${check.message}.`);
    }
    // The world may have moved during the awaits: re-check, then grant synchronously.
    const fresh = intentFor(wallet, intent.id, signature);
    if ('receipt' in fresh) return { status: 'confirmed', receipt: fresh.receipt };
    return grant(fresh, signature, wallet);
  }

  async function confirm(wallet: string, body: unknown): Promise<ConfirmOutcome> {
    if (mode === 'off') throw new BurnError(503, 'Token burns are not enabled');
    const intentId = field(body, 'intentId');
    const signature = field(body, 'signature');
    if (typeof intentId !== 'string' || !HEX32_RE.test(intentId)) throw new BurnError(400, 'Invalid burn request id');
    const validSignature = mode === 'mock' ? typeof signature === 'string' && MOCK_SIGNATURE_RE.test(signature) : isTransactionSignature(signature);
    if (!validSignature) throw new BurnError(400, 'Invalid transaction signature');
    const sig = signature as string;
    prune(now());

    // The same confirm already running (a client retry): share its answer.
    const key = `${sig}|${wallet}|${intentId}`;
    const running = inFlight.get(key);
    if (running) return running;

    const found = intentFor(wallet, intentId, sig);
    if ('receipt' in found) return { status: 'confirmed', receipt: found.receipt };
    if (mode === 'mock') return grant(found, sig, wallet);

    if (inFlight.size >= MAX_CONFIRMS_IN_FLIGHT) throw new BurnError(503, 'Busy confirming burns. Try again in a moment.');
    const mine = inFlightPerWallet.get(wallet) ?? 0;
    if (mine >= MAX_CONFIRMS_IN_FLIGHT_PER_WALLET) throw new BurnError(429, 'Too many confirmations at once. Try again in a moment.');
    // Bound before the chain is asked: an intent only ever gets a couple of signatures looked up.
    const bound = bindBurnIntentSignature(found.id, sig, MAX_SIGNATURES_PER_INTENT);
    if (bound === 'missing') throw new BurnError(404, 'Burn request not found or expired. Start a new one.');
    if (bound === 'full') throw new BurnError(409, 'This burn request already has a transaction. Start a new one.');
    inFlightPerWallet.set(wallet, mine + 1);
    const promise = confirmLive(found, sig, wallet).finally(() => {
      inFlight.delete(key);
      const left = (inFlightPerWallet.get(wallet) ?? 1) - 1;
      if (left > 0) inFlightPerWallet.set(wallet, left);
      else inFlightPerWallet.delete(wallet);
    });
    inFlight.set(key, promise);
    return promise;
  }

  // ---------- Stats ----------

  function stats(): BurnStats {
    const totals = getBurnTotals(20);
    const recent: BurnRecord[] = totals.recent.map((b) => {
      const r: BurnRecord = {
        shortAddress: shortAddress(b.address),
        name: b.name,
        amount: b.amount,
        purpose: b.purpose,
        signature: b.signature,
        explorerUrl: explorerUrl(b.signature),
        at: b.at,
      };
      if (b.itemId !== undefined) r.itemId = b.itemId;
      if (b.nameEffect) r.cosmetics = { name: b.nameEffect };
      return r;
    });
    return { mode, totalBurned: totals.totalBurned, burns: totals.burns, recent };
  }

  function publicConfig(): BurnConfig {
    return {
      mode,
      cluster: settings.cluster,
      mint: mode === 'off' ? null : settings.mint,
      decimals: mintInfo?.decimals ?? getMintDecimals(settings.mint),
      rankedEntryPrice: settings.rankedEntryPrice,
      priceMultiplier: settings.priceMultiplier,
    };
  }

  return {
    mode,
    start() {
      stopped = false;
      if (mode === 'live') void loadMint();
    },
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
    ready: loadMint,
    publicConfig,
    createIntent,
    confirm,
    stats,
  };
}

let defaultService: BurnService | null = null;

/**
 * The process-wide burn service, built from the environment on first use and started.
 * Throws ConfigError for a configuration the server must refuse (mock mode in production).
 */
export function getBurnService(): BurnService {
  if (!defaultService) {
    const settings = getBurnSettings();
    if (settings.mode === 'mock') {
      console.warn('[burns] BURN_MODE=mock: fake burns are accepted. Local testing only, never in production.');
    }
    defaultService = createBurnService({ settings });
    defaultService.start();
  }
  return defaultService;
}
