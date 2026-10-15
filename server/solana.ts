// Solana access for token burns (SPEC "Burn flow"). The server never holds or asks for a key:
//
// - loadMintInfo():          reads the mint account once (decimals + owning program: Token or Token-2022)
// - pickTokenAccount():      chooses the player's token account to burn from
// - buildBurnTransaction():  the UNSIGNED v0 transaction the player signs in Phantom: exactly one
//                            BurnChecked (player's account, mint, owner = player) and one SPL Memo
//                            carrying the intent memo; fee payer = the player
// - verifyBurn():            semantic check of the landed transaction (jsonParsed), so wallet-added
//                            instructions (compute budget, Lighthouse guards...) don't matter
//
// RPC goes through the small SolanaRpc interface; createConnectionRpc() backs it with a web3.js
// Connection, and tests inject fakes (or a Connection with a fake fetch).

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** The legacy memo program. Never built by us, but a memo through it still counts when verifying. */
export const MEMO_V1_PROGRAM_ID = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');
const MEMO_PROGRAMS = new Set([MEMO_PROGRAM_ID.toBase58(), MEMO_V1_PROGRAM_ID.toBase58()]);
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
export const U64_MAX = (1n << 64n) - 1n;
const RPC_TIMEOUT_MS = 10_000;
const DIGITS_RE = /^[0-9]{1,20}$/;

// ---------- RPC ----------

export interface TokenAccountBalance {
  pubkey: string;
  /** Token program that owns the account. */
  programId: string;
  mint: string;
  owner: string;
  amountRaw: bigint;
  /** 'initialized' | 'frozen' | ... (jsonParsed account state). */
  state: string;
}

/** The RPC calls the burn flow makes. */
export interface SolanaRpc {
  getAccountInfo(address: string): Promise<AccountInfo<Buffer> | null>;
  /** The owner's token accounts for `mint` (any token program). */
  getTokenAccountsByOwner(owner: string, mint: string): Promise<TokenAccountBalance[]>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** getTransaction(signature, {commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed'}). */
  getParsedTransaction(signature: string): Promise<ParsedTransactionWithMeta | null>;
}

type FetchLike = typeof globalThis.fetch;

/** SolanaRpc over a web3.js Connection. Every request times out after 10 s. `fetch` is injectable for tests. */
export function createConnectionRpc(url: string, opts: { fetch?: FetchLike; timeoutMs?: number } = {}): SolanaRpc {
  const baseFetch: FetchLike = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  const timedFetch: FetchLike = (input, init) => baseFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const connection = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: timedFetch });

  return {
    getAccountInfo: (address) => connection.getAccountInfo(new PublicKey(address), 'confirmed'),

    async getTokenAccountsByOwner(owner, mint) {
      const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
      const out: TokenAccountBalance[] = [];
      for (const { pubkey, account } of res.value) {
        const parsed = (account.data as { parsed?: unknown }).parsed as
          | { type?: unknown; info?: { mint?: unknown; owner?: unknown; state?: unknown; tokenAmount?: { amount?: unknown } } }
          | undefined;
        const info = parsed?.info;
        const amount = info?.tokenAmount?.amount;
        if (parsed?.type !== 'account' || typeof info?.mint !== 'string' || typeof info.owner !== 'string') continue;
        if (typeof amount !== 'string' || !DIGITS_RE.test(amount)) continue;
        out.push({
          pubkey: pubkey.toBase58(),
          programId: account.owner.toBase58(),
          mint: info.mint,
          owner: info.owner,
          amountRaw: BigInt(amount),
          state: typeof info.state === 'string' ? info.state : 'unknown',
        });
      }
      return out;
    },

    getLatestBlockhash: () => connection.getLatestBlockhash('confirmed'),

    getParsedTransaction: (signature) =>
      connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
  };
}

// ---------- Mint ----------

export interface MintInfo {
  mint: string;
  decimals: number;
  /** Token program owning the mint: classic Token or Token-2022. */
  programId: string;
}

/** The mint account is missing or isn't a token mint: a configuration error, not worth retrying. */
export class MintConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MintConfigError';
  }
}

/** Read the mint: decimals and the owning token program. RPC failures throw as-is (retry them). */
export async function loadMintInfo(rpc: SolanaRpc, mint: string): Promise<MintInfo> {
  const mintKey = new PublicKey(mint);
  const info = await rpc.getAccountInfo(mint);
  if (!info) throw new MintConfigError(`TOKEN_MINT ${mint} does not exist on this cluster`);
  const programId = info.owner.toBase58();
  if (!TOKEN_PROGRAMS.has(programId)) throw new MintConfigError(`TOKEN_MINT ${mint} is not owned by the Token or Token-2022 program`);
  let decimals: number;
  try {
    const parsed = unpackMint(mintKey, info, info.owner);
    if (!parsed.isInitialized) throw new Error('not initialized');
    decimals = parsed.decimals;
  } catch (err) {
    throw new MintConfigError(`TOKEN_MINT ${mint} is not a valid token mint (${(err as Error).message})`);
  }
  return { mint, decimals, programId };
}

// ---------- Building ----------

/** Whole tokens -> base units. Throws when it does not fit a u64. */
export function toRawAmount(amount: number, decimals: number): bigint {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError('amount must be a positive whole number');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError('bad decimals');
  const raw = BigInt(amount) * 10n ** BigInt(decimals);
  if (raw > U64_MAX) throw new RangeError('amount does not fit in a u64');
  return raw;
}

/**
 * The account to burn from: an initialized account of the right program and mint, owned by
 * `owner`, holding at least `amountRaw`. Prefers the associated token account, then the biggest
 * balance. Null when no single account holds enough.
 */
export function pickTokenAccount(
  accounts: readonly TokenAccountBalance[],
  want: { owner: string; mint: MintInfo; amountRaw: bigint },
): TokenAccountBalance | null {
  let ata: string | null = null;
  try {
    ata = getAssociatedTokenAddressSync(new PublicKey(want.mint.mint), new PublicKey(want.owner), true, new PublicKey(want.mint.programId)).toBase58();
  } catch {
    ata = null;
  }
  const eligible = accounts.filter(
    (a) =>
      a.mint === want.mint.mint &&
      a.owner === want.owner &&
      a.programId === want.mint.programId &&
      a.state === 'initialized' &&
      a.amountRaw >= want.amountRaw,
  );
  eligible.sort(
    (a, b) =>
      Number(b.pubkey === ata) - Number(a.pubkey === ata) ||
      (b.amountRaw > a.amountRaw ? 1 : b.amountRaw < a.amountRaw ? -1 : 0) ||
      (a.pubkey < b.pubkey ? -1 : 1),
  );
  return eligible[0] ?? null;
}

/** Sum of the owner's balances for the mint (for a helpful "you have X" message). */
export function totalBalance(accounts: readonly TokenAccountBalance[], owner: string, mint: string): bigint {
  return accounts.filter((a) => a.owner === owner && a.mint === mint).reduce((sum, a) => sum + a.amountRaw, 0n);
}

export interface BurnTxParams {
  /** The player's wallet: fee payer, burn authority and memo signer. */
  owner: string;
  /** The player's token account (from pickTokenAccount). */
  tokenAccount: string;
  mint: MintInfo;
  amountRaw: bigint;
  memo: string;
  recentBlockhash: string;
}

/** The SPL Memo instruction, signed by `signer` (memo v2 checks every listed signer actually signed). */
export function createMemoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, 'utf8'),
  });
}

/** Unsigned v0 transaction: BurnChecked + Memo, nothing else. */
export function buildBurnTransaction(p: BurnTxParams): VersionedTransaction {
  if (p.amountRaw <= 0n || p.amountRaw > U64_MAX) throw new RangeError('amount out of range');
  const owner = new PublicKey(p.owner);
  const programId = new PublicKey(p.mint.programId);
  if (!TOKEN_PROGRAMS.has(programId.toBase58())) throw new Error('mint is not owned by a token program');
  const burn = createBurnCheckedInstruction(
    new PublicKey(p.tokenAccount),
    new PublicKey(p.mint.mint),
    owner,
    p.amountRaw,
    p.mint.decimals,
    [],
    programId,
  );
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: p.recentBlockhash,
    instructions: [burn, createMemoInstruction(p.memo, owner)],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** Base64 wire bytes of an (unsigned) transaction, for BurnIntent.transaction. */
export function serializeTransaction(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString('base64');
}

// ---------- Verifying ----------

/** A base58 string that decodes to a 64-byte ed25519 signature. */
export function isTransactionSignature(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value)) return false;
  return bs58.decodeUnsafe(value)?.length === 64;
}

export function explorerTxUrl(signature: string, cluster: 'mainnet-beta' | 'devnet'): string {
  return `https://solscan.io/tx/${signature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}

export interface BurnExpectation {
  signature: string;
  /** The player's wallet: must sign and be the burn authority. */
  wallet: string;
  mint: string;
  /** Minimum base units burned (summed). */
  amountRaw: bigint;
  /** The exact memo text the transaction must carry (it contains the intent nonce). */
  memo: string;
  /** Allowed blockTime range, unix seconds, inclusive. */
  notBefore: number;
  notAfter: number;
}

export type BurnRejectReason =
  | 'not_found' // a different transaction came back
  | 'no_meta'
  | 'failed' // meta.err set
  | 'not_signer'
  | 'no_memo'
  | 'no_burn' // nothing burned of this mint by this wallet
  | 'amount' // burned, but less than required
  | 'no_block_time' // can't check the window yet
  | 'window';

export type BurnCheck =
  | { ok: true; burnedRaw: bigint; blockTime: number }
  | { ok: false; reason: BurnRejectReason; message: string };

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction;

function keyString(k: unknown): string {
  if (typeof k === 'string') return k;
  if (k instanceof PublicKey) return k.toBase58();
  if (k && typeof (k as { toBase58?: unknown }).toBase58 === 'function') return (k as PublicKey).toBase58();
  return '';
}

function memoText(ix: AnyInstruction): string | null {
  if (!MEMO_PROGRAMS.has(keyString(ix.programId))) return null;
  if ('parsed' in ix) return typeof ix.parsed === 'string' ? ix.parsed : null;
  // Not parsed by the RPC: the data is the base58 memo bytes.
  const bytes = bs58.decodeUnsafe(ix.data);
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Check a landed burn transaction against an intent:
 * - it is the transaction asked for, with meta and `meta.err === null`;
 * - the wallet signed it;
 * - some memo instruction (top level or inner) is exactly the intent memo;
 * - parsed `burn` / `burnChecked` instructions (top level and inner) whose authority is the wallet
 *   and whose mint is the token's burn at least `amountRaw` in total. A plain `burn` has its mint
 *   resolved through `meta.preTokenBalances`; any instruction whose mint can't be pinned down, or
 *   disagrees with the token balances, is not counted;
 * - blockTime is inside the intent window.
 */
export function verifyBurn(tx: ParsedTransactionWithMeta | null, exp: BurnExpectation): BurnCheck {
  if (!tx) return { ok: false, reason: 'not_found', message: 'Transaction not found' };
  const signatures = tx.transaction?.signatures ?? [];
  if (!signatures.includes(exp.signature)) return { ok: false, reason: 'not_found', message: 'Transaction not found' };
  const meta = tx.meta;
  if (!meta) return { ok: false, reason: 'no_meta', message: 'The transaction has no status yet' };
  if (meta.err !== null) return { ok: false, reason: 'failed', message: 'The burn transaction failed on-chain' };

  const accountKeys = tx.transaction.message.accountKeys.map((k) => ({ pubkey: keyString(k.pubkey), signer: k.signer === true }));
  if (!accountKeys.some((k) => k.pubkey === exp.wallet && k.signer)) {
    return { ok: false, reason: 'not_signer', message: 'The transaction was not signed by your wallet' };
  }

  const all: AnyInstruction[] = [...tx.transaction.message.instructions];
  for (const inner of meta.innerInstructions ?? []) all.push(...inner.instructions);

  if (!all.some((ix) => memoText(ix) === exp.memo)) {
    return { ok: false, reason: 'no_memo', message: "The transaction doesn't carry this burn's memo" };
  }

  // account address -> mint, from the token balances before the transaction ran.
  const mintOf = new Map<string, string>();
  for (const b of meta.preTokenBalances ?? []) {
    const key = accountKeys[b.accountIndex]?.pubkey;
    if (key && typeof b.mint === 'string') mintOf.set(key, b.mint);
  }

  let burned = 0n;
  for (const ix of all) {
    if (!('parsed' in ix) || !TOKEN_PROGRAMS.has(keyString(ix.programId))) continue;
    const parsed = ix.parsed as { type?: unknown; info?: Record<string, unknown> } | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.info || typeof parsed.info !== 'object') continue;
    const info = parsed.info;
    if (parsed.type !== 'burn' && parsed.type !== 'burnChecked') continue;
    if (info.authority !== exp.wallet || typeof info.account !== 'string') continue;
    const balanceMint = mintOf.get(info.account);
    let mint: unknown;
    let amount: unknown;
    if (parsed.type === 'burnChecked') {
      mint = info.mint;
      amount = (info.tokenAmount as { amount?: unknown } | undefined)?.amount;
      if (balanceMint !== undefined && balanceMint !== mint) continue;
    } else {
      // Plain burn: the mint comes from the account's token balance; a parsed `mint`, when present, must agree.
      mint = balanceMint;
      if (info.mint !== undefined && info.mint !== mint) continue;
      amount = info.amount;
    }
    if (mint !== exp.mint || typeof amount !== 'string' || !DIGITS_RE.test(amount)) continue;
    burned += BigInt(amount);
  }
  if (burned === 0n) return { ok: false, reason: 'no_burn', message: "The transaction doesn't burn the token from your wallet" };
  if (burned < exp.amountRaw) return { ok: false, reason: 'amount', message: 'The transaction burned less than the price' };

  const blockTime = tx.blockTime;
  if (typeof blockTime !== 'number') return { ok: false, reason: 'no_block_time', message: 'Block time not available yet' };
  if (blockTime < exp.notBefore || blockTime > exp.notAfter) {
    return { ok: false, reason: 'window', message: 'The burn happened outside the time window of this request' };
  }
  return { ok: true, burnedRaw: burned, blockTime };
}
