// Token burns: transaction builder, chain verification, the burn service (live with a fake RPC, and
// mock), grants, equip, weekly ranked points, the HTTP routes and the client wallet's burn flow.
//
// Live-mode chain calls never leave the process: a fake JSON-RPC endpoint answers a real web3.js
// Connection (createConnectionRpc with an injected fetch) with realistic jsonParsed payloads, so the
// verifier sees exactly what web3.js hands it in production (PublicKey objects, parsed / partially
// decoded instructions, token balances...).

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_SIZE,
  ExtensionType,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import express from 'express';
import nacl from 'tweetnacl';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RANKED_POINTS } from '../shared/constants';
import { COSMETICS } from '../shared/cosmetics';
import type { BurnIntent, BurnReceipt, BurnStats, Profile, RankedLeaderboard } from '../shared/protocol';
import { shortAddress } from '../shared/protocol';
import { checkBurnTransaction, createWallet, expectedBurnAmount } from '../client/src/wallet';
import { createApiRouter } from '../server/api';
import {
  BLOCK_TIME_SKEW_MS,
  BurnError,
  CLAIMED_RETENTION_MS,
  INTENT_TTL_MS,
  MAX_OPEN_INTENTS_PER_WALLET,
  MAX_STORED_INTENTS_PER_WALLET,
  UNCLAIMED_GRACE_MS,
  burnMemo,
  createBurnService,
  priceOf,
  type BurnService,
  type BurnServiceOptions,
} from '../server/burns';
import { ConfigError, getBurnConfig, getBurnSettings, getPublicConfig, type BurnSettings } from '../server/config';
import {
  MEMO_PROGRAM_ID,
  MEMO_V1_PROGRAM_ID,
  MintConfigError,
  buildBurnTransaction,
  createConnectionRpc,
  loadMintInfo,
  pickTokenAccount,
  serializeTransaction,
  toRawAmount,
  verifyBurn,
  type BurnExpectation,
  type MintInfo,
  type TokenAccountBalance,
} from '../server/solana';
import {
  consumeRankedTickets,
  equipCosmetic,
  flushStore,
  getBurnBySignature,
  getBurnIntent,
  getBurnTotals,
  getProfile,
  getRankedLeaderboard,
  grantBurn,
  rankedPoints,
  rankedWeek,
  recordRankedResults,
  resetStore,
  upsertProfile,
  type RankedResultRecord,
} from '../server/store';

// ---------------------------------------------------------------- constants & small helpers

const RPC_URL = 'http://rpc.test';
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58();
const MEMO = MEMO_PROGRAM_ID.toBase58();
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
/** Phantom adds Lighthouse assertion instructions to mainnet transactions. */
const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
/** What the RPC really returns for u64::MAX rent epochs (JSON number). */
const MAX_RENT_EPOCH = 18446744073709552000;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0); // Wednesday 2026-10-14

/** An on-curve wallet address (a real ed25519 public key). */
const walletKey = () => bs58.encode(nacl.sign.keyPair().publicKey);
const randomKey = () => bs58.encode(nacl.randomBytes(32));
const randomSig = () => bs58.encode(nacl.randomBytes(64));
const mockSig = () => `mock_${bs58.encode(nacl.randomBytes(12)).replace(/[^A-Za-z0-9]/g, '')}`;

function uiTokenAmount(raw: bigint, decimals: number) {
  const ui = Number(raw) / 10 ** decimals;
  return { amount: raw.toString(), decimals, uiAmount: ui, uiAmountString: String(ui) };
}

const getBurnIntentSigs = (id: string): string[] => getBurnIntent(id)?.signatures ?? [];

async function burnError(p: Promise<unknown>): Promise<BurnError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BurnError);
    return err as BurnError;
  }
  throw new Error('expected a BurnError');
}

// ---------------------------------------------------------------- store isolation

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amongrugs-burns-'));
  process.env.DATA_DIR = dir;
  resetStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStore();
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

// ---------------------------------------------------------------- mint accounts

/**
 * Raw mint account data. Token-2022 mints get a MetadataPointer extension, like pump.fun's, and
 * optionally a PermanentDelegate one; `mintAuthority` leaves the mint authority live.
 */
function mintAccountData(decimals: number, token2022 = false, opts: { mintAuthority?: string; permanentDelegate?: string } = {}): Buffer {
  const base = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: opts.mintAuthority ? 1 : 0,
      mintAuthority: opts.mintAuthority ? new PublicKey(opts.mintAuthority) : PublicKey.default,
      supply: 1_000_000_000n * 10n ** BigInt(decimals),
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  );
  if (!token2022) return base;
  const tlv = Buffer.alloc(4 + 64);
  tlv.writeUInt16LE(ExtensionType.MetadataPointer, 0);
  tlv.writeUInt16LE(64, 2);
  Buffer.from(nacl.randomBytes(64)).copy(tlv, 4);
  const entries = [tlv];
  if (opts.permanentDelegate) {
    const pd = Buffer.alloc(4 + 32);
    pd.writeUInt16LE(ExtensionType.PermanentDelegate, 0);
    pd.writeUInt16LE(32, 2);
    new PublicKey(opts.permanentDelegate).toBuffer().copy(pd, 4);
    entries.push(pd);
  }
  // Mint, zero padding up to the token-account size, the account type byte (1 = mint), then TLV entries.
  return Buffer.concat([base, Buffer.alloc(ACCOUNT_SIZE - MINT_SIZE), Buffer.from([1]), ...entries]);
}

// ---------------------------------------------------------------- jsonParsed transaction fixtures

interface BurnTxFixture {
  signature: string;
  wallet: string;
  tokenAccount: string;
  mint: string;
  programId: string;
  decimals: number;
  amountRaw: bigint;
  memo: string | null;
  blockTime: number | null;
  kind?: 'burnChecked' | 'burn';
  /** Plain burn: include the parsed `mint` field (real RPCs do) or leave it out. */
  plainBurnMint?: boolean;
  /** Burn authority (default the wallet); a different one is a second signer. */
  authority?: string;
  err?: unknown;
  /** Phantom's compute budget + Lighthouse instructions (default true). */
  phantomExtras?: boolean;
  /** The burn runs as a CPI from another program (an inner instruction). */
  inner?: boolean;
  memoProgram?: string;
  /** Mint reported by the token balances (default `mint`). */
  balanceMint?: string;
  /** Leave the burned account out of pre/postTokenBalances. */
  noBalances?: boolean;
  /** Owner the token balances report for the burned account (default the wallet); null leaves it out. */
  balanceOwner?: string | null;
  recentBlockhash?: string;
}

type Json = Record<string, any>;

/** The `result` of getTransaction(sig, {encoding: 'jsonParsed', maxSupportedTransactionVersion: 0}). */
function burnTxFixture(f: BurnTxFixture): Json {
  const kind = f.kind ?? 'burnChecked';
  const authority = f.authority ?? f.wallet;
  const extras = f.phantomExtras ?? true;
  const memoProgram = f.memoProgram ?? MEMO;
  const keys: Array<{ pubkey: string; signer: boolean; source: 'transaction'; writable: boolean }> = [];
  const add = (pubkey: string, signer: boolean, writable: boolean): number => {
    const i = keys.findIndex((k) => k.pubkey === pubkey);
    if (i >= 0) return i;
    keys.push({ pubkey, signer, source: 'transaction', writable });
    return keys.length - 1;
  };
  add(f.wallet, true, true);
  if (authority !== f.wallet) add(authority, true, false);
  const accountIndex = add(f.tokenAccount, false, true);
  add(f.mint, false, true);

  const info: Json =
    kind === 'burnChecked'
      ? { account: f.tokenAccount, authority, mint: f.mint, tokenAmount: uiTokenAmount(f.amountRaw, f.decimals) }
      : { account: f.tokenAccount, amount: f.amountRaw.toString(), authority, ...(f.plainBurnMint === false ? {} : { mint: f.mint }) };
  const burnIx = {
    parsed: { info, type: kind },
    program: f.programId === TOKEN22 ? 'spl-token-2022' : 'spl-token',
    programId: f.programId,
    stackHeight: f.inner ? 2 : null,
  };

  const instructions: Json[] = [];
  const innerInstructions: Json[] = [];
  if (extras) {
    instructions.push({ accounts: [], data: bs58.encode(ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }).data), programId: COMPUTE_BUDGET, stackHeight: null });
    instructions.push({ accounts: [], data: bs58.encode(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 120_000 }).data), programId: COMPUTE_BUDGET, stackHeight: null });
  }
  if (f.inner) {
    const helper = randomKey();
    add(helper, false, false);
    innerInstructions.push({ index: instructions.length, instructions: [burnIx] });
    instructions.push({ accounts: [f.tokenAccount, f.mint, authority, f.programId], data: '3Bxs4h24hBtQy9rw', programId: helper, stackHeight: null });
  } else {
    instructions.push(burnIx);
  }
  if (f.memo !== null) instructions.push({ parsed: f.memo, program: 'spl-memo', programId: memoProgram, stackHeight: null });
  if (extras) instructions.push({ accounts: [f.tokenAccount], data: '2SxBYvbd5mCoKu', programId: LIGHTHOUSE, stackHeight: null });
  add(f.programId, false, false);
  if (f.memo !== null) add(memoProgram, false, false);
  if (extras) {
    add(COMPUTE_BUDGET, false, false);
    add(LIGHTHOUSE, false, false);
  }

  const before = f.amountRaw * 3n;
  const owner = f.balanceOwner === undefined ? f.wallet : f.balanceOwner;
  const balance = (raw: bigint) => ({
    accountIndex,
    mint: f.balanceMint ?? f.mint,
    ...(owner === null ? {} : { owner }),
    programId: f.programId,
    uiTokenAmount: uiTokenAmount(raw, f.decimals),
  });
  const fee = extras ? 8600 : 5000;
  const preBalances = keys.map((_, i) => (i === 0 ? 48_211_430 : i === accountIndex ? 2_039_280 : 1_461_600));
  const postBalances = preBalances.map((b, i) => (i === 0 ? b - fee : b));
  const burnLog = kind === 'burnChecked' ? 'Program log: Instruction: BurnChecked' : 'Program log: Instruction: Burn';
  return {
    blockTime: f.blockTime,
    meta: {
      computeUnitsConsumed: 22_418,
      err: f.err ?? null,
      fee,
      innerInstructions,
      logMessages: [
        `Program ${f.programId} invoke [1]`,
        burnLog,
        `Program ${f.programId} consumed 4531 of 30000 compute units`,
        `Program ${f.programId} success`,
        ...(f.memo !== null ? [`Program ${memoProgram} invoke [1]`, `Program log: Memo (len ${f.memo.length}): "${f.memo}"`, `Program ${memoProgram} success`] : []),
      ],
      postBalances,
      postTokenBalances: f.noBalances ? [] : [balance(f.err ? before : before - f.amountRaw)],
      preBalances,
      preTokenBalances: f.noBalances ? [] : [balance(before)],
      rewards: [],
      status: f.err ? { Err: f.err } : { Ok: null },
    },
    slot: 372_418_811,
    transaction: {
      message: { accountKeys: keys, addressTableLookups: [], instructions, recentBlockhash: f.recentBlockhash ?? randomKey() },
      signatures: [f.signature],
    },
    version: 0,
  };
}

// ---------------------------------------------------------------- fake chain behind a real Connection

interface FakeTokenAccount {
  pubkey: string;
  owner: string;
  mint: string;
  programId: string;
  amount: bigint;
  decimals: number;
  state?: string;
}

interface FakeChain {
  fetch: typeof fetch;
  calls: Array<{ method: string; params: any[] }>;
  mints: Map<string, { owner: string; data: Buffer }>;
  tokenAccounts: FakeTokenAccount[];
  txs: Map<string, Json>;
  /** Signatures that stay invisible to getTransaction until revealed. */
  hidden: Set<string>;
  /** Methods that answer HTTP 500. */
  failing: Set<string>;
  /** New transactions start hidden. */
  hideNew: boolean;
  blockhash: string;
  /** Unix seconds used as blockTime for landed transactions. */
  blockTime: () => number;
  /** "Send" a serialized transaction the way Phantom would (plus its extra instructions). */
  land(base64: string, opts?: Partial<BurnTxFixture>): string;
}

function createChain(blockTime: () => number = () => Math.floor(Date.now() / 1000)): FakeChain {
  const chain: FakeChain = {
    calls: [],
    mints: new Map(),
    tokenAccounts: [],
    txs: new Map(),
    hidden: new Set(),
    failing: new Set(),
    hideNew: false,
    blockhash: randomKey(),
    blockTime,
    fetch: async (_input, init) => {
      const req = JSON.parse(String(init?.body)) as { id: string | number; method: string; params: any[] };
      chain.calls.push({ method: req.method, params: req.params });
      if (chain.failing.has(req.method)) return new Response('upstream down', { status: 500, statusText: 'Internal Server Error' });
      const context = { apiVersion: '2.2.14', slot: 372_418_900 };
      let result: unknown;
      switch (req.method) {
        case 'getAccountInfo': {
          const m = chain.mints.get(req.params[0]);
          result = {
            context,
            value: m ? { data: [m.data.toString('base64'), 'base64'], executable: false, lamports: 1_461_600, owner: m.owner, rentEpoch: MAX_RENT_EPOCH, space: m.data.length } : null,
          };
          break;
        }
        case 'getTokenAccountsByOwner': {
          const [owner, filter] = req.params as [string, { mint: string }];
          result = {
            context,
            value: chain.tokenAccounts
              .filter((a) => a.owner === owner && a.mint === filter.mint)
              .map((a) => ({
                pubkey: a.pubkey,
                account: {
                  data: {
                    parsed: {
                      info: { isNative: false, mint: a.mint, owner: a.owner, state: a.state ?? 'initialized', tokenAmount: uiTokenAmount(a.amount, a.decimals) },
                      type: 'account',
                    },
                    program: a.programId === TOKEN22 ? 'spl-token-2022' : 'spl-token',
                    space: a.programId === TOKEN22 ? 170 : 165,
                  },
                  executable: false,
                  lamports: 2_039_280,
                  owner: a.programId,
                  rentEpoch: MAX_RENT_EPOCH,
                  space: a.programId === TOKEN22 ? 170 : 165,
                },
              })),
          };
          break;
        }
        case 'getLatestBlockhash':
          result = { context, value: { blockhash: chain.blockhash, lastValidBlockHeight: 350_123_456 } };
          break;
        case 'getTransaction': {
          const sig = req.params[0] as string;
          result = chain.hidden.has(sig) ? null : (chain.txs.get(sig) ?? null);
          break;
        }
        default:
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    land(base64, opts = {}) {
      const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
      const message = TransactionMessage.decompile(tx.message);
      const burnIx = message.instructions.find((ix) => ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID))!;
      const decoded = decodeBurnCheckedInstruction(burnIx, burnIx.programId);
      const memoIx = message.instructions.find((ix) => ix.programId.equals(MEMO_PROGRAM_ID));
      const signature = opts.signature ?? randomSig();
      chain.txs.set(
        signature,
        burnTxFixture({
          signature,
          wallet: message.payerKey.toBase58(),
          tokenAccount: decoded.keys.account.pubkey.toBase58(),
          mint: decoded.keys.mint.pubkey.toBase58(),
          programId: burnIx.programId.toBase58(),
          decimals: decoded.data.decimals,
          amountRaw: decoded.data.amount,
          memo: memoIx ? Buffer.from(memoIx.data).toString('utf8') : null,
          blockTime: chain.blockTime(),
          recentBlockhash: message.recentBlockhash,
          ...opts,
        }),
      );
      if (chain.hideNew) chain.hidden.add(signature);
      return signature;
    },
  };
  return chain;
}

/** Run a fixture through a real web3.js Connection, as the server would receive it. */
async function viaConnection(fixture: Json | null) {
  const chain = createChain();
  const sig = fixture?.transaction?.signatures?.[0] ?? randomSig();
  if (fixture) chain.txs.set(sig, fixture);
  return createConnectionRpc(RPC_URL, { fetch: chain.fetch }).getParsedTransaction(sig);
}

// ---------------------------------------------------------------- live service harness

interface Clock {
  now: number;
}

function liveSettings(mint: string, over: Partial<BurnSettings> = {}): BurnSettings {
  return { mode: 'live', cluster: 'mainnet-beta', mint, rpcUrl: RPC_URL, rankedEntryPrice: 50_000, priceMultiplier: 1, ...over };
}

function setupLive(opts: { token2022?: boolean; decimals?: number; service?: Partial<BurnServiceOptions> } = {}) {
  const clock: Clock = { now: T0 };
  const chain = createChain(() => Math.floor(clock.now / 1000));
  const mint = randomKey();
  const decimals = opts.decimals ?? 6;
  const programId = opts.token2022 ? TOKEN22 : TOKEN;
  chain.mints.set(mint, { owner: programId, data: mintAccountData(decimals, opts.token2022) });
  const service = createBurnService({
    settings: liveSettings(mint),
    rpc: createConnectionRpc(RPC_URL, { fetch: chain.fetch }),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    ticker: () => '$RUGS',
    pollTimeoutMs: 6_000,
    pollIntervalMs: 2_000,
    log: () => {},
    ...opts.service,
  });
  /** A signed-in player holding `whole` tokens in their associated token account. */
  const player = (whole = 1_000_000) => {
    const address = walletKey();
    upsertProfile(address, clock.now);
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(address), false, new PublicKey(programId)).toBase58();
    chain.tokenAccounts.push({ pubkey: ata, owner: address, mint, programId, amount: BigInt(whole) * 10n ** BigInt(decimals), decimals });
    return { address, ata };
  };
  return { clock, chain, mint, decimals, programId, service, player };
}

// ================================================================= builder

describe('burn transaction builder', () => {
  function decode(base64: string) {
    const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
    const message = TransactionMessage.decompile(tx.message);
    return { tx, message };
  }

  it.each([
    ['classic Token', TOKEN_PROGRAM_ID],
    ['Token-2022', TOKEN_2022_PROGRAM_ID],
  ])('builds exactly BurnChecked + Memo, unsigned, paid by the player (%s)', (_label, program) => {
    const owner = walletKey();
    const mint: MintInfo = { mint: randomKey(), decimals: 6, programId: program.toBase58() };
    const tokenAccount = getAssociatedTokenAddressSync(new PublicKey(mint.mint), new PublicKey(owner), false, program).toBase58();
    const memo = burnMemo('cosmetic', 'skin_gold', 'ab'.repeat(16));
    const recentBlockhash = randomKey();
    const amountRaw = toRawAmount(60_000, 6);
    const b64 = serializeTransaction(buildBurnTransaction({ owner, tokenAccount, mint, amountRaw, memo, recentBlockhash }));

    const { tx, message } = decode(b64);
    expect(tx.version).toBe(0);
    expect(tx.message.addressTableLookups).toEqual([]);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(owner); // fee payer
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0].every((b) => b === 0)).toBe(true); // unsigned
    expect(message.payerKey.toBase58()).toBe(owner);
    expect(message.recentBlockhash).toBe(recentBlockhash);
    expect(message.instructions).toHaveLength(2);

    const [burn, memoIx] = message.instructions;
    expect(burn.programId.toBase58()).toBe(program.toBase58());
    const decoded = decodeBurnCheckedInstruction(burn, program);
    expect(decoded.data.amount).toBe(60_000_000_000n);
    expect(decoded.data.decimals).toBe(6);
    expect(decoded.keys.account.pubkey.toBase58()).toBe(tokenAccount);
    expect(decoded.keys.account.isWritable).toBe(true);
    expect(decoded.keys.mint.pubkey.toBase58()).toBe(mint.mint);
    expect(decoded.keys.owner.pubkey.toBase58()).toBe(owner);
    expect(decoded.keys.owner.isSigner).toBe(true);
    expect(decoded.keys.multiSigners).toEqual([]);

    expect(memoIx.programId.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    expect(Buffer.from(memoIx.data).toString('utf8')).toBe(`AMONGRUGS cosmetic:skin_gold ${'ab'.repeat(16)}`);
    // The memo's only account is the player as signer (writable here only because it is the fee payer).
    expect(memoIx.keys.map((k) => [k.pubkey.toBase58(), k.isSigner])).toEqual([[owner, true]]);

    // The client accepts exactly this transaction for this intent.
    const intent: BurnIntent = { intentId: 'cd'.repeat(16), purpose: 'cosmetic', itemId: 'skin_gold', amount: 60_000, amountRaw: '60000000000', memo, transaction: b64, expiresAt: 0 };
    expect(checkBurnTransaction(tx, { owner, mint: mint.mint, intent })).toBeNull();
    // The client never signs a burn it can't pin to the configured mint.
    expect(checkBurnTransaction(tx, { owner, mint: null, intent })).toBe('no token mint configured');
    expect(checkBurnTransaction(tx, { owner, mint: randomKey(), intent })).toBe('burns a different token');
  });

  it('prices purchases server-side and keeps raw amounts inside a u64', () => {
    const s = { rankedEntryPrice: 50_000, priceMultiplier: 1 };
    expect(priceOf(s, 'ranked')).toBe(50_000);
    expect(priceOf(s, 'cosmetic', 'skin_holo')).toBe(100_000);
    expect(priceOf({ ...s, priceMultiplier: 0.25 }, 'cosmetic', 'rug_persian')).toBe(2_500);
    expect(priceOf({ ...s, priceMultiplier: 1e-9 }, 'cosmetic', 'rug_persian')).toBe(1);
    expect(priceOf(s, 'cosmetic', 'nope')).toBeNull();
    // Client and server agree on every catalog price.
    for (const item of COSMETICS) {
      for (const m of [1, 0.5, 2.5, 0.001]) {
        expect(expectedBurnAmount({ ...s, mode: 'live', cluster: 'mainnet-beta', mint: null, decimals: 6, priceMultiplier: m }, { purpose: 'cosmetic', itemId: item.id })).toBe(
          priceOf({ ...s, priceMultiplier: m }, 'cosmetic', item.id),
        );
      }
    }
    expect(toRawAmount(1, 0)).toBe(1n);
    expect(toRawAmount(50_000, 9)).toBe(50_000_000_000_000n);
    expect(() => toRawAmount(20_000_000_000, 9)).toThrow(RangeError); // 2e19 > u64::MAX
    expect(() => toRawAmount(0, 6)).toThrow(RangeError);
    expect(() => toRawAmount(1.5, 6)).toThrow(RangeError);
  });

  it('picks an initialized account with enough balance, preferring the ATA', () => {
    const owner = walletKey();
    const mint: MintInfo = { mint: randomKey(), decimals: 6, programId: TOKEN };
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint.mint), new PublicKey(owner)).toBase58();
    const acct = (pubkey: string, amountRaw: bigint, patch: Partial<TokenAccountBalance> = {}): TokenAccountBalance => ({
      pubkey,
      programId: TOKEN,
      mint: mint.mint,
      owner,
      amountRaw,
      state: 'initialized',
      ...patch,
    });
    const big = randomKey();
    const accounts = [acct(big, 900n), acct(ata, 500n), acct(randomKey(), 10_000n, { state: 'frozen' }), acct(randomKey(), 10_000n, { programId: TOKEN22 })];
    expect(pickTokenAccount(accounts, { owner, mint, amountRaw: 400n })?.pubkey).toBe(ata);
    expect(pickTokenAccount(accounts, { owner, mint, amountRaw: 600n })?.pubkey).toBe(big);
    expect(pickTokenAccount(accounts, { owner, mint, amountRaw: 901n })).toBeNull();
    expect(pickTokenAccount([acct(randomKey(), 10_000n, { owner: walletKey() })], { owner, mint, amountRaw: 1n })).toBeNull();
  });
});

// ================================================================= mint introspection

describe('mint introspection', () => {
  it('reads decimals and the token program (classic Token)', async () => {
    const chain = createChain();
    const mint = randomKey();
    chain.mints.set(mint, { owner: TOKEN, data: mintAccountData(6) });
    expect(await loadMintInfo(createConnectionRpc(RPC_URL, { fetch: chain.fetch }), mint)).toEqual({ mint, decimals: 6, programId: TOKEN });
    expect(chain.calls[0].method).toBe('getAccountInfo');
  });

  it('reads a Token-2022 mint with extensions', async () => {
    const chain = createChain();
    const mint = randomKey();
    chain.mints.set(mint, { owner: TOKEN22, data: mintAccountData(9, true) });
    expect(await loadMintInfo(createConnectionRpc(RPC_URL, { fetch: chain.fetch }), mint)).toEqual({ mint, decimals: 9, programId: TOKEN22 });
  });

  it('reports a live mint authority and a Token-2022 permanent delegate as risks', async () => {
    const chain = createChain();
    const rpc = createConnectionRpc(RPC_URL, { fetch: chain.fetch });
    const authority = randomKey();
    const delegate = randomKey();
    const minted = randomKey();
    chain.mints.set(minted, { owner: TOKEN, data: mintAccountData(6, false, { mintAuthority: authority }) });
    const a = await loadMintInfo(rpc, minted);
    expect(a.risks).toHaveLength(1);
    expect(a.risks![0]).toMatch(/mint authority/);
    const pd = randomKey();
    chain.mints.set(pd, { owner: TOKEN22, data: mintAccountData(6, true, { permanentDelegate: delegate }) });
    const b = await loadMintInfo(rpc, pd);
    expect(b.decimals).toBe(6);
    expect(b.risks).toEqual([expect.stringMatching(new RegExp(`permanent delegate \\(${delegate}\\)`))]);
    // The burn service says so loudly once the mint is read.
    const logs: string[] = [];
    const service = createBurnService({ settings: liveSettings(pd), rpc, log: (...args) => logs.push(args.join(' ')) });
    expect(await service.ready()).toBe(true);
    expect(logs.some((l) => /WARNING: .*permanent delegate/.test(l))).toBe(true);
  });

  it('separates configuration errors from RPC outages', async () => {
    const chain = createChain();
    const rpc = createConnectionRpc(RPC_URL, { fetch: chain.fetch });
    await expect(loadMintInfo(rpc, randomKey())).rejects.toBeInstanceOf(MintConfigError);
    const notMint = randomKey();
    chain.mints.set(notMint, { owner: SystemProgram.programId.toBase58(), data: Buffer.alloc(0) });
    await expect(loadMintInfo(rpc, notMint)).rejects.toBeInstanceOf(MintConfigError);
    const garbage = randomKey();
    chain.mints.set(garbage, { owner: TOKEN, data: Buffer.alloc(MINT_SIZE) }); // not initialized
    await expect(loadMintInfo(rpc, garbage)).rejects.toBeInstanceOf(MintConfigError);
    chain.failing.add('getAccountInfo');
    const err = await loadMintInfo(rpc, garbage).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MintConfigError);
  });
});

// ================================================================= verification

describe('verifyBurn (jsonParsed through a web3.js Connection)', () => {
  const wallet = walletKey();
  const mint = randomKey();
  const tokenAccount = randomKey();
  const nonce = '0f'.repeat(16);
  const memo = burnMemo('ranked', undefined, nonce);
  const amountRaw = 50_000_000_000n;
  const blockTime = Math.floor(T0 / 1000) + 30;

  function fixture(patch: Partial<BurnTxFixture> = {}): Json {
    return burnTxFixture({ signature: randomSig(), wallet, tokenAccount, mint, programId: TOKEN, decimals: 6, amountRaw, memo, blockTime, ...patch });
  }
  function expectation(fx: Json, patch: Partial<BurnExpectation> = {}): BurnExpectation {
    return {
      signature: fx.transaction.signatures[0],
      wallet,
      mint,
      amountRaw,
      memo,
      notBefore: Math.floor(T0 / 1000) - 120,
      notAfter: Math.floor(T0 / 1000) + 600 + 120,
      ...patch,
    };
  }
  async function check(fx: Json, patch: Partial<BurnExpectation> = {}) {
    return verifyBurn(await viaConnection(fx), expectation(fx, patch));
  }

  it('accepts a burnChecked with Phantom-added compute budget and Lighthouse instructions', async () => {
    const fx = fixture();
    expect(fx.transaction.message.instructions.map((i: Json) => i.programId)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, TOKEN, MEMO, LIGHTHOUSE]);
    const parsed = await viaConnection(fx);
    // What web3.js hands over: PublicKey objects, parsed and partially decoded instructions.
    expect(parsed!.transaction.message.accountKeys[0].pubkey).toBeInstanceOf(PublicKey);
    expect(verifyBurn(parsed, expectation(fx))).toEqual({ ok: true, burnedRaw: amountRaw, blockTime });
  });

  it('accepts a plain burn, resolving its mint through preTokenBalances', async () => {
    expect((await check(fixture({ kind: 'burn', plainBurnMint: false }))).ok).toBe(true);
    expect((await check(fixture({ kind: 'burn' }))).ok).toBe(true);
    // Without a token balance for the account, the mint can't be pinned down: not counted.
    expect(await check(fixture({ kind: 'burn', plainBurnMint: false, noBalances: true }))).toMatchObject({ ok: false, reason: 'no_burn' });
    // Balances say another mint: not counted, whatever the instruction claims.
    expect(await check(fixture({ kind: 'burn', balanceMint: randomKey() }))).toMatchObject({ ok: false, reason: 'no_burn' });
  });

  it('accepts Token-2022, inner-instruction burns, the legacy memo program and no wallet extras', async () => {
    expect((await check(fixture({ programId: TOKEN22 }))).ok).toBe(true);
    expect((await check(fixture({ inner: true }))).ok).toBe(true);
    expect((await check(fixture({ memoProgram: MEMO_V1_PROGRAM_ID.toBase58() }))).ok).toBe(true);
    expect((await check(fixture({ phantomExtras: false }))).ok).toBe(true);
    // More than the price is fine.
    expect(await check(fixture({ amountRaw: amountRaw * 2n }))).toMatchObject({ ok: true, burnedRaw: amountRaw * 2n });
  });

  it('rejects a burn of another mint', async () => {
    expect(await check(fixture({ mint: randomKey() }))).toMatchObject({ ok: false, reason: 'no_burn' });
    // burnChecked whose token balance disagrees with the instruction's mint.
    expect(await check(fixture({ balanceMint: randomKey() }))).toMatchObject({ ok: false, reason: 'no_burn' });
  });

  it('rejects a burn by another authority, and a wallet that did not sign', async () => {
    expect(await check(fixture({ authority: walletKey() }))).toMatchObject({ ok: false, reason: 'no_burn' });
    const fx = fixture();
    fx.transaction.message.accountKeys[0].signer = false;
    expect(await check(fx)).toMatchObject({ ok: false, reason: 'not_signer' });
  });

  it('rejects too small an amount', async () => {
    expect(await check(fixture({ amountRaw: amountRaw - 1n }))).toMatchObject({ ok: false, reason: 'amount' });
  });

  it('rejects a missing or mismatched memo', async () => {
    expect(await check(fixture({ memo: null }))).toMatchObject({ ok: false, reason: 'no_memo' });
    expect(await check(fixture({ memo: burnMemo('ranked', undefined, 'aa'.repeat(16)) }))).toMatchObject({ ok: false, reason: 'no_memo' });
    expect(await check(fixture({ memo: burnMemo('cosmetic', 'skin_gold', nonce) }))).toMatchObject({ ok: false, reason: 'no_memo' });
    expect(await check(fixture({ memo: `${memo} ` }))).toMatchObject({ ok: false, reason: 'no_memo' });
  });

  it('rejects a failed transaction (meta.err set)', async () => {
    const fx = fixture({ err: { InstructionError: [2, { Custom: 1 }] } });
    expect(await check(fx)).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('enforces the blockTime window', async () => {
    const exp = { notBefore: blockTime - 10, notAfter: blockTime + 10 };
    expect((await check(fixture({ blockTime: blockTime + 10 }), exp)).ok).toBe(true);
    expect(await check(fixture({ blockTime: blockTime + 11 }), exp)).toMatchObject({ ok: false, reason: 'window' });
    expect(await check(fixture({ blockTime: blockTime - 11 }), exp)).toMatchObject({ ok: false, reason: 'window' });
    expect(await check(fixture({ blockTime: null }), exp)).toMatchObject({ ok: false, reason: 'no_block_time' });
  });

  it('rejects a transaction that is not the one asked for', async () => {
    const fx = fixture();
    expect(verifyBurn(await viaConnection(fx), expectation(fx, { signature: randomSig() }))).toMatchObject({ ok: false, reason: 'not_found' });
    expect(verifyBurn(null, expectation(fx))).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it("rejects a burn from someone else's token account (a delegate, or a Token-2022 permanent delegate)", async () => {
    // The wallet is the burn authority and signer, but the balances say the tokens belong to a victim.
    const victim = walletKey();
    expect(await check(fixture({ balanceOwner: victim }))).toMatchObject({ ok: false, reason: 'no_burn' });
    expect(await check(fixture({ balanceOwner: victim, programId: TOKEN22 }))).toMatchObject({ ok: false, reason: 'no_burn' });
    expect(await check(fixture({ balanceOwner: victim, kind: 'burn' }))).toMatchObject({ ok: false, reason: 'no_burn' });
    // No owner reported, or no balance at all for the account: fail closed.
    expect(await check(fixture({ balanceOwner: null }))).toMatchObject({ ok: false, reason: 'no_burn' });
    expect(await check(fixture({ noBalances: true }))).toMatchObject({ ok: false, reason: 'no_burn' });
  });

  it('only accepts the transaction id (signatures[0]), never a co-signer signature', async () => {
    const fx = fixture();
    const coSigner = walletKey();
    const second = randomSig();
    fx.transaction.message.accountKeys.splice(1, 0, { pubkey: coSigner, signer: true, source: 'transaction', writable: false });
    for (const b of [...fx.meta.preTokenBalances, ...fx.meta.postTokenBalances]) b.accountIndex += 1;
    fx.meta.preBalances.splice(1, 0, 1_000_000);
    fx.meta.postBalances.splice(1, 0, 1_000_000);
    fx.transaction.signatures.push(second);
    // An indexer that also resolves secondary signatures hands back the same transaction.
    const parsed = await viaConnection(fx);
    expect(verifyBurn(parsed, expectation(fx))).toMatchObject({ ok: true });
    expect(verifyBurn(parsed, expectation(fx, { signature: second }))).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('needs exactly one memo, so one transaction can never pay for two intents', async () => {
    const otherIntent = burnMemo('ranked', undefined, 'ab'.repeat(16));
    const two = fixture();
    two.transaction.message.instructions.push({ parsed: otherIntent, program: 'spl-memo', programId: MEMO, stackHeight: null });
    expect(await check(two)).toMatchObject({ ok: false, reason: 'no_memo' });
    // The same memo twice, or a second one as an inner instruction, is refused too.
    const twice = fixture();
    twice.transaction.message.instructions.push({ parsed: memo, program: 'spl-memo', programId: MEMO, stackHeight: null });
    expect(await check(twice)).toMatchObject({ ok: false, reason: 'no_memo' });
    const inner = fixture();
    inner.meta.innerInstructions.push({ index: 0, instructions: [{ parsed: otherIntent, program: 'spl-memo', programId: MEMO, stackHeight: 2 }] });
    expect(await check(inner)).toMatchObject({ ok: false, reason: 'no_memo' });
  });
});

// ================================================================= burn service: live

describe('burn service (live, fake RPC)', () => {
  it('creates an intent with the unsigned BurnChecked + Memo from the player\'s token account', async () => {
    const { service, chain, player, mint } = setupLive();
    const p = player();
    const intent = await service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'skin_gold' });
    expect(intent).toMatchObject({ purpose: 'cosmetic', itemId: 'skin_gold', amount: 60_000, amountRaw: '60000000000', expiresAt: T0 + INTENT_TTL_MS });
    expect(intent.intentId).toMatch(/^[0-9a-f]{32}$/);
    expect(intent.memo).toMatch(/^AMONGRUGS cosmetic:skin_gold [0-9a-f]{32}$/);

    const tx = VersionedTransaction.deserialize(Buffer.from(intent.transaction!, 'base64'));
    expect(checkBurnTransaction(tx, { owner: p.address, mint, intent })).toBeNull();
    const message = TransactionMessage.decompile(tx.message);
    expect(message.recentBlockhash).toBe(chain.blockhash);
    expect(decodeBurnCheckedInstruction(message.instructions[0], TOKEN_PROGRAM_ID).keys.account.pubkey.toBase58()).toBe(p.ata);

    const methods = chain.calls.map((c) => c.method);
    expect(methods).toEqual(['getAccountInfo', 'getTokenAccountsByOwner', 'getLatestBlockhash']);
    expect(chain.calls[1].params).toEqual([p.address, { mint }, { commitment: 'confirmed', encoding: 'jsonParsed' }]);
    expect(chain.calls[2].params).toEqual([{ commitment: 'confirmed' }]);
  });

  it('uses the Token-2022 program and the mint decimals read from chain', async () => {
    const { service, player, mint } = setupLive({ token2022: true, decimals: 9 });
    const p = player();
    const intent = await service.createIntent(p.address, { purpose: 'ranked' });
    expect(intent.amountRaw).toBe('50000000000000');
    expect(service.publicConfig()).toMatchObject({ mode: 'live', mint, decimals: 9 });
    const tx = VersionedTransaction.deserialize(Buffer.from(intent.transaction!, 'base64'));
    const ix = TransactionMessage.decompile(tx.message).instructions[0];
    expect(ix.programId.toBase58()).toBe(TOKEN22);
    expect(decodeBurnCheckedInstruction(ix, TOKEN_2022_PROGRAM_ID).data).toMatchObject({ amount: 50_000_000_000_000n, decimals: 9 });
  });

  it('validates the purchase', async () => {
    const { service, player } = setupLive();
    const p = player(10_000);
    expect((await burnError(service.createIntent(p.address, { purpose: 'gift' }))).status).toBe(400);
    expect((await burnError(service.createIntent(p.address, { purpose: 'cosmetic' }))).status).toBe(400);
    expect((await burnError(service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'skin_nope' }))).status).toBe(400);
    expect((await burnError(service.createIntent(p.address, { purpose: 'ranked', itemId: 'skin_gold' }))).status).toBe(400);
    expect((await burnError(service.createIntent(p.address, null))).status).toBe(400);
    // 10,000 tokens can't buy a 50,000 ticket.
    const poor = await burnError(service.createIntent(p.address, { purpose: 'ranked' }));
    expect(poor.status).toBe(409);
    expect(poor.message).toBe('Not enough $RUGS. This costs 50,000, your wallet has 10,000.');
    // A cosmetic that is already owned.
    grantBurn({ signature: mockSig(), intentId: 'ee'.repeat(16), address: p.address, purpose: 'cosmetic', itemId: 'rug_persian', amount: 1, amountRaw: '1', at: T0 });
    const owned = await burnError(service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'rug_persian' }));
    expect(owned.status).toBe(409);
    expect(owned.message).toMatch(/already own Persian Classic/);
  });

  it('confirms a ranked burn: ticket +1, receipt, stats', async () => {
    const { service, chain, player, clock } = setupLive();
    const p = player();
    const intent = await service.createIntent(p.address, { purpose: 'ranked' });
    clock.now += 20_000;
    const sig = chain.land(intent.transaction!);
    const out = await service.confirm(p.address, { intentId: intent.intentId, signature: sig });
    expect(out.status).toBe('confirmed');
    const receipt = (out as { receipt: BurnReceipt }).receipt;
    expect(receipt).toMatchObject({ status: 'confirmed', signature: sig, amount: 50_000, purpose: 'ranked', explorerUrl: `https://solscan.io/tx/${sig}` });
    expect(receipt.profile.rankedTickets).toBe(1);
    expect(getProfile(p.address)!.rankedTickets).toBe(1);
    const getTx = chain.calls.find((c) => c.method === 'getTransaction')!;
    expect(getTx.params).toEqual([sig, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);

    const stats = service.stats();
    expect(stats).toMatchObject({ mode: 'live', totalBurned: 50_000, burns: 1 });
    expect(stats.recent[0]).toEqual({
      shortAddress: shortAddress(p.address),
      name: shortAddress(p.address),
      amount: 50_000,
      purpose: 'ranked',
      signature: sig,
      explorerUrl: `https://solscan.io/tx/${sig}`,
      at: clock.now,
    });
  });

  it('grants a cosmetic: owned, auto-equipped only into an empty slot', async () => {
    const { service, chain, player } = setupLive();
    const p = player();
    for (const itemId of ['skin_gold', 'skin_crown', 'name_fire']) {
      const intent = await service.createIntent(p.address, { purpose: 'cosmetic', itemId });
      const out = await service.confirm(p.address, { intentId: intent.intentId, signature: chain.land(intent.transaction!) });
      expect(out).toMatchObject({ status: 'confirmed', receipt: { purpose: 'cosmetic', itemId } });
    }
    expect(getProfile(p.address)!.cosmetics).toEqual({ owned: ['skin_gold', 'skin_crown', 'name_fire'], equipped: { skin: 'skin_gold', name: 'name_fire' } });
    expect(service.stats()).toMatchObject({ totalBurned: 60_000 + 75_000 + 60_000, burns: 3 });
  });

  it('answers pending (202) while the transaction is not visible, then confirms', async () => {
    const { service, chain, player, clock } = setupLive();
    const p = player();
    const intent = await service.createIntent(p.address, { purpose: 'ranked' });
    chain.hideNew = true;
    const sig = chain.land(intent.transaction!);
    const start = clock.now;
    expect(await service.confirm(p.address, { intentId: intent.intentId, signature: sig })).toEqual({ status: 'pending' });
    expect(clock.now - start).toBeGreaterThanOrEqual(4_000); // it polled for the configured window
    expect(chain.calls.filter((c) => c.method === 'getTransaction').length).toBeGreaterThan(1);
    expect(getProfile(p.address)!.rankedTickets).toBe(0);
    // RPC errors while polling are pending too, never a failure.
    chain.failing.add('getTransaction');
    expect(await service.confirm(p.address, { intentId: intent.intentId, signature: sig })).toEqual({ status: 'pending' });
    chain.failing.clear();
    chain.hidden.clear();
    expect(await service.confirm(p.address, { intentId: intent.intentId, signature: sig })).toMatchObject({ status: 'confirmed' });
    expect(getProfile(p.address)!.rankedTickets).toBe(1);
  });

  it('is idempotent for the same intent and signature, and never grants twice', async () => {
    const { service, chain, player } = setupLive();
    const p = player();
    const intent = await service.createIntent(p.address, { purpose: 'ranked' });
    const sig = chain.land(intent.transaction!);
    const req = { intentId: intent.intentId, signature: sig };
    // Two confirms racing (client retry + resume): one grant, both get the receipt.
    const [a, b] = await Promise.all([service.confirm(p.address, req), service.confirm(p.address, req)]);
    expect(a).toMatchObject({ status: 'confirmed', receipt: { signature: sig } });
    expect(b).toMatchObject({ status: 'confirmed', receipt: { signature: sig } });
    const again = await service.confirm(p.address, req);
    expect(again).toMatchObject({ status: 'confirmed', receipt: { signature: sig, amount: 50_000, purpose: 'ranked' } });
    expect(getProfile(p.address)!.rankedTickets).toBe(1);
    expect(service.stats().burns).toBe(1);
  });

  it('rejects a replayed signature for another intent, and a second signature for a paid intent', async () => {
    const { service, chain, player } = setupLive();
    const p = player();
    const first = await service.createIntent(p.address, { purpose: 'ranked' });
    const second = await service.createIntent(p.address, { purpose: 'ranked' });
    const sig = chain.land(first.transaction!);
    await service.confirm(p.address, { intentId: first.intentId, signature: sig });
    const replay = await burnError(service.confirm(p.address, { intentId: second.intentId, signature: sig }));
    expect(replay.status).toBe(409);
    expect(replay.message).toMatch(/already used/);
    // The first intent is paid; another (valid-looking) transaction can't pay it again.
    const sig2 = chain.land(second.transaction!);
    expect((await burnError(service.confirm(p.address, { intentId: first.intentId, signature: sig2 }))).status).toBe(409);
    expect(getProfile(p.address)!.rankedTickets).toBe(1);
    // The second intent still confirms with its own transaction.
    expect(await service.confirm(p.address, { intentId: second.intentId, signature: sig2 })).toMatchObject({ status: 'confirmed' });
    expect(getProfile(p.address)!.rankedTickets).toBe(2);
  });

  it("rejects a signature whose transaction belongs to a different intent", async () => {
    const { service, chain, player } = setupLive();
    const p = player();
    const a = await service.createIntent(p.address, { purpose: 'ranked' });
    const b = await service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'skin_holo' });
    // Burn for the cheap ticket, try to claim the expensive skin with it.
    const sigA = chain.land(a.transaction!);
    const err = await burnError(service.confirm(p.address, { intentId: b.intentId, signature: sigA }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/memo/);
    expect(getProfile(p.address)!.cosmetics.owned).toEqual([]);
    // Nothing was spent: the burn still pays for its own intent.
    expect(await service.confirm(p.address, { intentId: a.intentId, signature: sigA })).toMatchObject({ status: 'confirmed' });
  });

  it("rejects another user's intent and another user's transaction", async () => {
    const { service, chain, player } = setupLive();
    const alice = player();
    const mallory = player();
    const intent = await service.createIntent(alice.address, { purpose: 'ranked' });
    const sig = chain.land(intent.transaction!);
    const err = await burnError(service.confirm(mallory.address, { intentId: intent.intentId, signature: sig }));
    expect(err.status).toBe(403);
    expect(getProfile(mallory.address)!.rankedTickets).toBe(0);
    // Mallory's own intent can't be paid with Alice's burn (wrong signer/authority, wrong memo).
    const own = await service.createIntent(mallory.address, { purpose: 'ranked' });
    expect((await burnError(service.confirm(mallory.address, { intentId: own.intentId, signature: sig }))).status).toBe(400);
    // While Alice's confirm is in flight, Mallory naming the same signature neither rides on it nor
    // blocks it (the old in-flight lock answered a final 409 that made Alice's client drop the burn).
    chain.hideNew = true;
    const intent2 = await service.createIntent(alice.address, { purpose: 'ranked' });
    const sig2 = chain.land(intent2.transaction!);
    const inFlight = service.confirm(alice.address, { intentId: intent2.intentId, signature: sig2 });
    const own2 = await service.createIntent(mallory.address, { purpose: 'ranked' });
    expect(await service.confirm(mallory.address, { intentId: own2.intentId, signature: sig2 })).toEqual({ status: 'pending' });
    expect(await inFlight).toEqual({ status: 'pending' });
    chain.hidden.clear();
    expect((await burnError(service.confirm(mallory.address, { intentId: own2.intentId, signature: sig2 }))).status).toBe(400);
    expect(await service.confirm(alice.address, { intentId: intent2.intentId, signature: sig2 })).toMatchObject({ status: 'confirmed' });
    // Alice's own burn still pays for her own intent.
    expect(await service.confirm(alice.address, { intentId: intent.intentId, signature: sig })).toMatchObject({ status: 'confirmed' });
    expect(getProfile(mallory.address)!.rankedTickets).toBe(0);
    expect(getProfile(alice.address)!.rankedTickets).toBe(2);
  });

  it('rejects failed transactions, short burns and burns outside the window', async () => {
    const { service, chain, player, clock } = setupLive();
    const p = player();
    const failed = await service.createIntent(p.address, { purpose: 'ranked' });
    const sigFailed = chain.land(failed.transaction!, { err: { InstructionError: [2, { Custom: 1 }] } });
    expect((await burnError(service.confirm(p.address, { intentId: failed.intentId, signature: sigFailed }))).message).toMatch(/failed on-chain/);

    const short = await service.createIntent(p.address, { purpose: 'ranked' });
    const sigShort = chain.land(short.transaction!, { amountRaw: 49_999_999_999n });
    expect((await burnError(service.confirm(p.address, { intentId: short.intentId, signature: sigShort }))).message).toMatch(/less than the price/);

    const late = await service.createIntent(p.address, { purpose: 'ranked' });
    const sigLate = chain.land(late.transaction!, { blockTime: Math.ceil((late.expiresAt + BLOCK_TIME_SKEW_MS) / 1000) + 1 });
    expect((await burnError(service.confirm(p.address, { intentId: late.intentId, signature: sigLate }))).message).toMatch(/time window/);

    const early = await service.createIntent(p.address, { purpose: 'ranked' });
    const sigEarly = chain.land(early.transaction!, { blockTime: Math.floor((clock.now - BLOCK_TIME_SKEW_MS) / 1000) - 1 });
    expect((await burnError(service.confirm(p.address, { intentId: early.intentId, signature: sigEarly }))).status).toBe(400);
    expect(getProfile(p.address)!.rankedTickets).toBe(0);
    expect(service.stats().burns).toBe(0);
  });

  it('expires intents: unclaimed ones after the grace, claimed ones after a day', async () => {
    const { service, chain, player, clock } = setupLive();
    const p = player();
    const unclaimed = await service.createIntent(p.address, { purpose: 'ranked' });
    const claimed = await service.createIntent(p.address, { purpose: 'ranked' });
    const junked = await service.createIntent(p.address, { purpose: 'ranked' });
    // The chain shows the signed transaction but has no block time yet: pending, and claimed.
    const sigClaimed = chain.land(claimed.transaction!, { blockTime: null });
    chain.hideNew = true;
    const sigUnclaimed = chain.land(unclaimed.transaction!);
    expect(await service.confirm(p.address, { intentId: claimed.intentId, signature: sigClaimed })).toEqual({ status: 'pending' });
    // A signature the chain has never seen does not extend an intent.
    expect(await service.confirm(p.address, { intentId: junked.intentId, signature: randomSig() })).toEqual({ status: 'pending' });

    clock.now = T0 + INTENT_TTL_MS + UNCLAIMED_GRACE_MS + 1;
    chain.hidden.clear();
    chain.txs.get(sigClaimed)!.blockTime = Math.floor(T0 / 1000) + 5;
    const gone = await burnError(service.confirm(p.address, { intentId: unclaimed.intentId, signature: sigUnclaimed }));
    expect([404, 409]).toContain(gone.status);
    expect([404, 409]).toContain((await burnError(service.confirm(p.address, { intentId: junked.intentId, signature: randomSig() }))).status);
    // The claimed one is still confirmable (its burn landed inside the window).
    expect(await service.confirm(p.address, { intentId: claimed.intentId, signature: sigClaimed })).toMatchObject({ status: 'confirmed' });

    // An RPC outage can't tell whether the burn landed, so it keeps the intent too.
    chain.hideNew = false;
    const third = await service.createIntent(p.address, { purpose: 'ranked' });
    const sig3 = chain.land(third.transaction!);
    chain.failing.add('getTransaction');
    expect(await service.confirm(p.address, { intentId: third.intentId, signature: sig3 })).toEqual({ status: 'pending' });
    chain.failing.delete('getTransaction');
    clock.now += INTENT_TTL_MS + UNCLAIMED_GRACE_MS + 1;
    chain.txs.get(sig3)!.blockTime = Math.floor((clock.now - INTENT_TTL_MS - UNCLAIMED_GRACE_MS) / 1000);
    expect(await service.confirm(p.address, { intentId: third.intentId, signature: sig3 })).toMatchObject({ status: 'confirmed' });

    const fourth = await service.createIntent(p.address, { purpose: 'ranked' });
    const sig4 = chain.land(fourth.transaction!, { blockTime: null });
    expect(await service.confirm(p.address, { intentId: fourth.intentId, signature: sig4 })).toEqual({ status: 'pending' });
    clock.now += CLAIMED_RETENTION_MS + 1;
    expect([404, 409]).toContain((await burnError(service.confirm(p.address, { intentId: fourth.intentId, signature: sig4 }))).status);
  });

  it('binds at most two signatures to an intent before asking the chain', async () => {
    const { service, chain, player } = setupLive();
    const p = player();
    const intent = await service.createIntent(p.address, { purpose: 'ranked' });
    const lookups = () => chain.calls.filter((c) => c.method === 'getTransaction').length;
    expect(await service.confirm(p.address, { intentId: intent.intentId, signature: randomSig() })).toEqual({ status: 'pending' });
    expect(await service.confirm(p.address, { intentId: intent.intentId, signature: randomSig() })).toEqual({ status: 'pending' });
    const before = lookups();
    const third = await burnError(service.confirm(p.address, { intentId: intent.intentId, signature: randomSig() }));
    expect(third.status).toBe(409);
    expect(third.message).toMatch(/already has a transaction/);
    expect(lookups()).toBe(before);
    // The bound signatures stay usable (a client retry).
    expect(await service.confirm(p.address, { intentId: intent.intentId, signature: getBurnIntentSigs(intent.intentId)[0] })).toEqual({ status: 'pending' });
  });

  it('caps every stored intent of a wallet, not only open ones', async () => {
    const { service, player, clock } = setupLive();
    const p = player();
    const bindJunk = async () => {
      const intent = await service.createIntent(p.address, { purpose: 'ranked' });
      expect(await service.confirm(p.address, { intentId: intent.intentId, signature: randomSig() })).toEqual({ status: 'pending' });
    };
    for (let i = 0; i < MAX_OPEN_INTENTS_PER_WALLET; i++) await bindJunk();
    // Past the open window but inside the grace: none is open, all five are still stored.
    clock.now += INTENT_TTL_MS + 1;
    for (let i = 0; i < MAX_OPEN_INTENTS_PER_WALLET - 1; i++) await bindJunk();
    clock.now += INTENT_TTL_MS + 1;
    await bindJunk();
    expect(MAX_STORED_INTENTS_PER_WALLET).toBe(2 * MAX_OPEN_INTENTS_PER_WALLET);
    // One open intent, ten stored: the stored cap refuses.
    const capped = await burnError(service.createIntent(p.address, { purpose: 'ranked' }));
    expect(capped.status).toBe(409);
    expect(capped.message).toMatch(/Too many unconfirmed burns/);
    // Once the old ones expire there is room again.
    clock.now += UNCLAIMED_GRACE_MS;
    expect((await service.createIntent(p.address, { purpose: 'ranked' })).intentId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('budgets getTransaction lookups per wallet and server-wide', async () => {
    const { service, chain, player, clock } = setupLive({ service: { lookupsPerWalletPerMinute: 3, lookupsPerMinute: 1000 } });
    const p = player();
    const lookups = () => chain.calls.filter((c) => c.method === 'getTransaction').length;
    const a = await service.createIntent(p.address, { purpose: 'ranked' });
    expect(await service.confirm(p.address, { intentId: a.intentId, signature: randomSig() })).toEqual({ status: 'pending' });
    expect(lookups()).toBe(3);
    // Out of budget: answered pending without asking the chain, and the junk intent isn't kept longer.
    const b = await service.createIntent(p.address, { purpose: 'ranked' });
    expect(await service.confirm(p.address, { intentId: b.intentId, signature: randomSig() })).toEqual({ status: 'pending' });
    expect(lookups()).toBe(3);
    // The budget refills with time; a real burn then confirms.
    clock.now += 60_000;
    const c = await service.createIntent(p.address, { purpose: 'ranked' });
    expect(await service.confirm(p.address, { intentId: c.intentId, signature: chain.land(c.transaction!) })).toMatchObject({ status: 'confirmed' });

    // Server-wide budget: when it runs out the player's intent is kept (it isn't their doing).
    const tight = setupLive({ service: { lookupsPerMinute: 6 } });
    const q = tight.player();
    const r = tight.player();
    const qi = await tight.service.createIntent(q.address, { purpose: 'ranked' });
    expect(await tight.service.confirm(q.address, { intentId: qi.intentId, signature: randomSig() })).toEqual({ status: 'pending' });
    const ri = await tight.service.createIntent(r.address, { purpose: 'ranked' });
    tight.chain.hideNew = true;
    const rsig = tight.chain.land(ri.transaction!);
    expect(await tight.service.confirm(r.address, { intentId: ri.intentId, signature: rsig })).toEqual({ status: 'pending' });
    tight.clock.now += INTENT_TTL_MS + UNCLAIMED_GRACE_MS + 1;
    tight.chain.hidden.clear();
    tight.chain.txs.get(rsig)!.blockTime = Math.floor(T0 / 1000) + 5;
    expect(await tight.service.confirm(r.address, { intentId: ri.intentId, signature: rsig })).toMatchObject({ status: 'confirmed' });
  });

  it('hands out the same intent for the same cosmetic, and refuses one already on its way', async () => {
    const { service, chain, player } = setupLive();
    const p = player();
    const first = await service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'skin_holo' });
    // A rejected Phantom prompt, or a second tab: same intent and memo, fresh transaction.
    chain.blockhash = randomKey();
    const again = await service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'skin_holo' });
    expect(again).toMatchObject({ intentId: first.intentId, memo: first.memo, amountRaw: first.amountRaw, expiresAt: first.expiresAt });
    expect(again.transaction).not.toBe(first.transaction);
    // Other items and tickets are separate.
    expect((await service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'rug_galaxy' })).intentId).not.toBe(first.intentId);
    // Once a signature was named for it, another burn for the same item is refused before signing.
    chain.hideNew = true;
    const sig = chain.land(again.transaction!);
    expect(await service.confirm(p.address, { intentId: first.intentId, signature: sig })).toEqual({ status: 'pending' });
    const dup = await burnError(service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'skin_holo' }));
    expect(dup.status).toBe(409);
    expect(dup.message).toMatch(/already waiting to confirm/);
    chain.hidden.clear();
    expect(await service.confirm(p.address, { intentId: first.intentId, signature: sig })).toMatchObject({ status: 'confirmed' });
    expect((await burnError(service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'skin_holo' }))).message).toMatch(/already own/);
  });

  it('caps open intents per wallet, dropping abandoned ones first', async () => {
    const { service, chain, player } = setupLive();
    const p = player();
    const intents: BurnIntent[] = [];
    for (let i = 0; i < MAX_OPEN_INTENTS_PER_WALLET; i++) intents.push(await service.createIntent(p.address, { purpose: 'ranked' }));
    // A sixth replaces the oldest one nobody tried to confirm.
    intents.push(await service.createIntent(p.address, { purpose: 'ranked' }));
    const dropped = await burnError(service.confirm(p.address, { intentId: intents[0].intentId, signature: randomSig() }));
    expect(dropped.status).toBe(404);
    // Once every open intent has a confirm in flight, nothing more is opened.
    chain.hideNew = true;
    for (const intent of intents.slice(1)) {
      const sig = chain.land(intent.transaction!);
      expect(await service.confirm(p.address, { intentId: intent.intentId, signature: sig })).toEqual({ status: 'pending' });
    }
    const capped = await burnError(service.createIntent(p.address, { purpose: 'ranked' }));
    expect(capped.status).toBe(409);
    expect(capped.message).toMatch(/Too many burns in progress/);
  });

  it('survives a restart between signing and confirming', async () => {
    const { service, chain, player, mint, clock } = setupLive();
    const p = player();
    const intent = await service.createIntent(p.address, { purpose: 'cosmetic', itemId: 'name_rainbow' });
    const sig = chain.land(intent.transaction!);
    flushStore();
    resetStore(); // the process restarts; a new service reads the intent back from db.json
    const restarted = createBurnService({
      settings: liveSettings(mint),
      rpc: createConnectionRpc(RPC_URL, { fetch: chain.fetch }),
      now: () => clock.now,
      sleep: async (ms) => void (clock.now += ms),
      log: () => {},
    });
    expect(await restarted.confirm(p.address, { intentId: intent.intentId, signature: sig })).toMatchObject({ status: 'confirmed', receipt: { itemId: 'name_rainbow' } });
    expect(getProfile(p.address)!.cosmetics.equipped).toEqual({ name: 'name_rainbow' });
  });

  it('answers 503 while the RPC is down and for a misconfigured mint', async () => {
    const { service, chain, player } = setupLive({ service: { mintRetryMinMs: 60_000 } });
    const p = player();
    chain.failing.add('getAccountInfo');
    expect((await burnError(service.createIntent(p.address, { purpose: 'ranked' }))).status).toBe(503);
    service.stop();
    chain.failing.clear();
    chain.failing.add('getLatestBlockhash');
    expect((await burnError(service.createIntent(p.address, { purpose: 'ranked' }))).status).toBe(503);
    chain.failing.clear();
    expect((await service.createIntent(p.address, { purpose: 'ranked' })).transaction).toBeTruthy();

    const bad = createBurnService({ settings: liveSettings(randomKey()), rpc: createConnectionRpc(RPC_URL, { fetch: chain.fetch }), log: () => {} });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await bad.ready()).toBe(false);
    expect((await burnError(bad.createIntent(p.address, { purpose: 'ranked' }))).status).toBe(503);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rejects malformed confirm requests', async () => {
    const { service, player } = setupLive();
    const p = player();
    const intent = await service.createIntent(p.address, { purpose: 'ranked' });
    for (const body of [{}, { intentId: intent.intentId }, { intentId: 'x', signature: randomSig() }, { intentId: intent.intentId, signature: 'abc' }]) {
      expect((await burnError(service.confirm(p.address, body))).status).toBe(400);
    }
    // Mock signatures mean nothing in live mode.
    expect((await burnError(service.confirm(p.address, { intentId: intent.intentId, signature: mockSig() }))).status).toBe(400);
    expect((await burnError(service.confirm(p.address, { intentId: 'ab'.repeat(16), signature: randomSig() }))).status).toBe(404);
  });
});

// ================================================================= burn service: mock & off

describe('burn service (mock and off)', () => {
  const mockSettings: BurnSettings = { mode: 'mock', cluster: 'devnet', mint: null, rpcUrl: RPC_URL, rankedEntryPrice: 50_000, priceMultiplier: 2 };

  it('mock: no transaction, mock_ signatures, same grant rules', async () => {
    const service = createBurnService({ settings: mockSettings });
    const address = walletKey();
    upsertProfile(address);
    const intent = await service.createIntent(address, { purpose: 'cosmetic', itemId: 'rug_galaxy' });
    expect(intent).toMatchObject({ transaction: null, amount: 160_000, amountRaw: '160000000000' });
    for (const signature of ['mock_', 'mock_short', `mock_${'x'.repeat(65)}`, 'mock_with-dash1', randomSig(), 'MOCK_abcdefgh']) {
      expect((await burnError(service.confirm(address, { intentId: intent.intentId, signature }))).status).toBe(400);
    }
    const sig = mockSig();
    const out = await service.confirm(address, { intentId: intent.intentId, signature: sig });
    expect(out).toMatchObject({ status: 'confirmed', receipt: { signature: sig, explorerUrl: null, itemId: 'rug_galaxy', amount: 160_000 } });
    expect(getProfile(address)!.cosmetics).toEqual({ owned: ['rug_galaxy'], equipped: { rug: 'rug_galaxy' } });
    // Same rules as live: single use, ownership.
    const other = await service.createIntent(address, { purpose: 'ranked' });
    expect((await burnError(service.confirm(address, { intentId: other.intentId, signature: sig }))).status).toBe(409);
    const stranger = walletKey();
    upsertProfile(stranger);
    expect((await burnError(service.confirm(stranger, { intentId: other.intentId, signature: mockSig() }))).status).toBe(403);
    expect(service.stats()).toMatchObject({ mode: 'mock', totalBurned: 160_000, burns: 1, recent: [{ explorerUrl: null }] });
    expect(service.publicConfig()).toEqual({ mode: 'mock', cluster: 'devnet', mint: null, decimals: 6, rankedEntryPrice: 50_000, priceMultiplier: 2 });
  });

  it('off: every burn call is refused with 503', async () => {
    const service = createBurnService({ settings: { ...mockSettings, mode: 'off' } });
    const address = walletKey();
    upsertProfile(address);
    expect((await burnError(service.createIntent(address, { purpose: 'ranked' }))).status).toBe(503);
    expect((await burnError(service.confirm(address, { intentId: 'ab'.repeat(16), signature: mockSig() }))).status).toBe(503);
    expect(service.publicConfig().mode).toBe('off');
  });

  it('refuses mock mode in production', () => {
    expect(() => getBurnSettings({ BURN_MODE: 'mock', NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(getBurnConfig({ BURN_MODE: 'mock', NODE_ENV: 'production' }).mode).toBe('off');
    expect(getBurnSettings({ BURN_MODE: 'mock' }).mode).toBe('mock');
    expect(getBurnSettings({ BURN_MODE: 'mock', NODE_ENV: 'development' }).mode).toBe('mock');
    // Matched loosely: a capital or a stray space can't slip past.
    expect(() => getBurnSettings({ BURN_MODE: ' Mock ', NODE_ENV: 'Production ' })).toThrow(ConfigError);
    // Never next to a real token mint (or a mistyped one), whatever NODE_ENV says.
    expect(() => getBurnSettings({ BURN_MODE: 'mock', TOKEN_MINT: randomKey() })).toThrow(/TOKEN_MINT/);
    expect(() => getBurnSettings({ BURN_MODE: 'mock', TOKEN_MINT: 'typo', NODE_ENV: 'development' })).toThrow(ConfigError);
    expect(getBurnConfig({ BURN_MODE: 'mock', TOKEN_MINT: randomKey() }).mode).toBe('off');

    // The API router builds the process-wide service at startup, so the server refuses to start.
    const saved = { BURN_MODE: process.env.BURN_MODE, NODE_ENV: process.env.NODE_ENV };
    try {
      process.env.BURN_MODE = 'mock';
      process.env.NODE_ENV = 'production';
      expect(() => createApiRouter({ getRoomsInfo: () => ({ publicLobbies: 0, playersOnline: 0 }) })).toThrow(ConfigError);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('keeps mock-mode data in its own file, so nothing fake carries over to live burns', () => {
    const saved = process.env.BURN_MODE;
    const address = walletKey();
    try {
      process.env.BURN_MODE = 'mock';
      resetStore();
      upsertProfile(address, T0);
      expect(grantBurn({ signature: mockSig(), intentId: 'aa'.repeat(16), address, purpose: 'ranked', amount: 50_000, amountRaw: '50000000000', at: T0 }).ok).toBe(true);
      flushStore();
      expect(fs.existsSync(path.join(dir, 'db.mock.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'db.json'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.BURN_MODE;
      else process.env.BURN_MODE = saved;
    }
    // A live (or off) server reads db.json: the mock ticket is not there.
    resetStore();
    expect(getProfile(address)).toBeNull();
    expect(getBurnTotals().burns).toBe(0);
  });

  it('reads the burn configuration from the environment', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mint = randomKey();
    expect(getBurnSettings({})).toMatchObject({ mode: 'off', mint: null, cluster: 'mainnet-beta', rankedEntryPrice: 50_000, priceMultiplier: 1 });
    expect(getBurnSettings({ TOKEN_MINT: mint })).toMatchObject({ mode: 'live', mint, rpcUrl: 'https://api.mainnet-beta.solana.com' });
    expect(getBurnSettings({ TOKEN_MINT: mint, BURN_MODE: 'off' }).mode).toBe('off');
    // The token's mint doubles as the displayed contract address unless one is configured.
    expect(getPublicConfig({ TOKEN_MINT: mint }).contractAddress).toBe(mint);
    const ca = randomKey();
    expect(getPublicConfig({ TOKEN_MINT: mint, CONTRACT_ADDRESS: ca }).contractAddress).toBe(ca);
    expect(getBurnSettings({ TOKEN_MINT: 'not-a-mint' }).mode).toBe('off');
    expect(
      getBurnSettings({ TOKEN_MINT: mint, SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'https://rpc.example/?api-key=k', RANKED_ENTRY_PRICE: '75_000', COSMETIC_PRICE_MULTIPLIER: '0.5' }),
    ).toMatchObject({ cluster: 'devnet', rpcUrl: 'https://rpc.example/?api-key=k', rankedEntryPrice: 75_000, priceMultiplier: 0.5 });
    expect(getBurnSettings({ RANKED_ENTRY_PRICE: '-3', COSMETIC_PRICE_MULTIPLIER: 'cheap', SOLANA_CLUSTER: 'testnet', SOLANA_RPC_URL: 'ftp://x' })).toMatchObject({
      rankedEntryPrice: 50_000,
      priceMultiplier: 1,
      cluster: 'mainnet-beta',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    });
    // The RPC URL (it may hold an API key) is never public.
    const pub = getBurnConfig({ TOKEN_MINT: mint, SOLANA_RPC_URL: 'https://rpc.example/?api-key=secret' });
    expect(JSON.stringify(pub)).not.toContain('secret');
    expect(pub).toEqual({ mode: 'live', cluster: 'mainnet-beta', mint, decimals: 6, rankedEntryPrice: 50_000, priceMultiplier: 1 });
    warn.mockRestore();
  });
});

// ================================================================= grants, tickets, equip (store)

describe('grants, tickets and equip', () => {
  const grant = (address: string, patch: Partial<Parameters<typeof grantBurn>[0]> = {}) =>
    grantBurn({ signature: mockSig(), intentId: Buffer.from(nacl.randomBytes(16)).toString('hex'), address, purpose: 'ranked', amount: 50_000, amountRaw: '50000000000', at: T0, ...patch });

  it('grants tickets and cosmetics exactly once per signature and per intent', () => {
    const a = walletKey();
    upsertProfile(a);
    const sig = mockSig();
    const intentId = 'aa'.repeat(16);
    const first = grant(a, { signature: sig, intentId });
    expect(first).toMatchObject({ ok: true, duplicate: false, profile: { rankedTickets: 1 } });
    expect(grant(a, { signature: sig, intentId })).toMatchObject({ ok: true, duplicate: true, profile: { rankedTickets: 1 } });
    expect(grant(a, { signature: sig })).toEqual({ ok: false, reason: 'signature_used' });
    expect(grant(walletKey(), { signature: sig, intentId })).toEqual({ ok: false, reason: 'signature_used' });
    expect(grant(a, { intentId })).toEqual({ ok: false, reason: 'intent_used' });
    expect(grant(a, { purpose: 'cosmetic', itemId: 'skin_nope' })).toEqual({ ok: false, reason: 'invalid' });
    expect(grant(a, { amount: 0 })).toEqual({ ok: false, reason: 'invalid' });
    expect(getProfile(a)!.rankedTickets).toBe(1);
    expect(getBurnBySignature(sig)).toMatchObject({ intentId, address: a, amount: 50_000 });
    // Survives a reload.
    flushStore();
    resetStore();
    expect(getProfile(a)!.rankedTickets).toBe(1);
    expect(grant(a, { signature: sig })).toEqual({ ok: false, reason: 'signature_used' });
  });

  it('consumes ranked tickets all or nothing', () => {
    const [a, b, c] = [walletKey(), walletKey(), walletKey()];
    for (const x of [a, b, c]) upsertProfile(x);
    grant(a);
    grant(a);
    grant(b);
    expect(consumeRankedTickets([a, b, c])).toEqual({ ok: false, missing: [c] });
    expect([a, b, c].map((x) => getProfile(x)!.rankedTickets)).toEqual([2, 1, 0]);
    expect(consumeRankedTickets([a, b, a])).toEqual({ ok: true });
    expect([a, b].map((x) => getProfile(x)!.rankedTickets)).toEqual([1, 0]);
    expect(consumeRankedTickets([a, b, 'nope'])).toEqual({ ok: false, missing: [b, 'nope'] });
    expect(getProfile(a)!.rankedTickets).toBe(1);
    expect(consumeRankedTickets([])).toEqual({ ok: true });
  });

  it('equips only owned items into their own slot', () => {
    const a = walletKey();
    upsertProfile(a);
    grant(a, { purpose: 'cosmetic', itemId: 'skin_gold' });
    grant(a, { purpose: 'cosmetic', itemId: 'skin_laser' });
    expect(getProfile(a)!.cosmetics.equipped).toEqual({ skin: 'skin_gold' });
    expect(equipCosmetic(a, 'skin', 'skin_laser')).toMatchObject({ ok: true, profile: { cosmetics: { equipped: { skin: 'skin_laser' } } } });
    expect(equipCosmetic(a, 'skin', 'skin_holo')).toEqual({ ok: false, error: 'not_owned' });
    expect(equipCosmetic(a, 'rug', 'skin_laser')).toEqual({ ok: false, error: 'wrong_slot' });
    expect(equipCosmetic(a, 'skin', 'skin_bogus')).toEqual({ ok: false, error: 'unknown_item' });
    expect(equipCosmetic(a, 'hat' as never, 'skin_laser')).toEqual({ ok: false, error: 'bad_slot' });
    expect(equipCosmetic(walletKey(), 'skin', 'skin_laser')).toEqual({ ok: false, error: 'no_profile' });
    expect(equipCosmetic(a, 'skin', null)).toMatchObject({ ok: true, profile: { cosmetics: { equipped: {} } } });
    expect(getProfile(a)!.cosmetics.owned).toEqual(['skin_gold', 'skin_laser']);
  });
});

// ================================================================= weekly ranked

describe('weekly ranked points', () => {
  const rec = (address: string, patch: Partial<RankedResultRecord> = {}): RankedResultRecord => ({
    address,
    role: 'holder',
    won: false,
    rugs: 0,
    tasksDone: 0,
    correctVotes: 0,
    survived: false,
    leftEarly: false,
    ...patch,
  });

  it('uses ISO weeks starting Monday 00:00 UTC', () => {
    const monday = Date.UTC(2026, 9, 12);
    expect(rankedWeek(Date.UTC(2026, 9, 15, 9))).toEqual({ weekId: '2026-W42', weekStart: monday, weekEnd: monday + 7 * 86_400_000 });
    expect(rankedWeek(monday).weekId).toBe('2026-W42');
    expect(rankedWeek(monday - 1).weekId).toBe('2026-W41'); // Sunday 23:59:59.999
    expect(rankedWeek(monday + 7 * 86_400_000 - 1).weekId).toBe('2026-W42');
    expect(rankedWeek(Date.UTC(2026, 0, 1)).weekId).toBe('2026-W01'); // Thursday
    expect(rankedWeek(Date.UTC(2025, 11, 29)).weekId).toBe('2026-W01'); // Monday of that week
    expect(rankedWeek(Date.UTC(2027, 0, 1)).weekId).toBe('2026-W53'); // Friday after a 53-week year
    expect(rankedWeek(Date.UTC(2024, 11, 30)).weekId).toBe('2025-W01');
    expect(rankedWeek(Date.UTC(2021, 0, 3)).weekId).toBe('2020-W53');
  });

  it('scores games with RANKED_POINTS', () => {
    const a = walletKey();
    expect(rankedPoints(rec(a, { won: true, tasksDone: 5, correctVotes: 1, survived: true }))).toBe(
      RANKED_POINTS.holderWin + 5 * RANKED_POINTS.perTask + RANKED_POINTS.perCorrectVote + RANKED_POINTS.survived,
    );
    expect(rankedPoints(rec(a, { role: 'rugger', won: true, rugs: 3, survived: true }))).toBe(RANKED_POINTS.ruggerWin + 3 * RANKED_POINTS.perRug);
    expect(rankedPoints(rec(a, { won: false, tasksDone: 4, survived: true }))).toBe(4);
    expect(rankedPoints(rec(a, { won: true, tasksDone: 5, rugs: 2, leftEarly: true }))).toBe(RANKED_POINTS.leftEarly);
    // Garbage counters are clamped per game.
    expect(rankedPoints(rec(a, { role: 'rugger', won: true, rugs: 1e9, tasksDone: -4, correctVotes: Number.NaN }))).toBe(RANKED_POINTS.ruggerWin + 9 * RANKED_POINTS.perRug);
  });

  it('builds the current and previous weekly leaderboards', () => {
    const [a, b, c, d] = [walletKey(), walletKey(), walletKey(), walletKey()];
    const lastSunday = Date.UTC(2026, 9, 11, 23, 59);
    const now = Date.UTC(2026, 9, 14, 12);
    recordRankedResults([rec(a, { role: 'rugger', won: true, rugs: 2 })], lastSunday); // previous week
    recordRankedResults(
      [rec(a, { won: true, tasksDone: 5, survived: true }), rec(b, { role: 'rugger', won: false, rugs: 1 }), rec(c, { won: true, tasksDone: 2 }), rec(d, { leftEarly: true })],
      now - 1000,
    );
    recordRankedResults([rec(b, { role: 'rugger', won: true, rugs: 1 }), rec(c, { won: false, tasksDone: 4, correctVotes: 1 })], now);
    recordRankedResults([rec(a), rec(a)], now); // duplicate in one game: counted once

    const current = getRankedLeaderboard('current', now);
    expect(current).toMatchObject({ weekId: '2026-W42', weekStart: Date.UTC(2026, 9, 12), weekEnd: Date.UTC(2026, 9, 19) });
    expect(current.entries.map((e) => [e.address, e.points, e.games, e.wins])).toEqual([
      [b, 5 + 40 + 5, 2, 1],
      [c, 32 + 9, 2, 1],
      [a, 40, 2, 1],
    ]);
    // d only left early (negative points): not on the board.
    expect(current.entries.some((e) => e.address === d)).toBe(false);
    expect(current.entries[0]).toMatchObject({ shortAddress: shortAddress(b), name: shortAddress(b), rugs: 2, correctVotes: 0 });
    expect(current.entries[1].correctVotes).toBe(1);

    const previous = getRankedLeaderboard('previous', now);
    expect(previous.weekId).toBe('2026-W41');
    expect(previous.entries).toEqual([expect.objectContaining({ address: a, points: 50, games: 1, wins: 1, rugs: 2 })]);
    // A week later, this week becomes "previous".
    expect(getRankedLeaderboard('previous', now + 7 * 86_400_000).entries.map((e) => e.address)).toEqual([b, c, a]);
    expect(getRankedLeaderboard('current', now + 7 * 86_400_000).entries).toEqual([]);
  });

  it('ties break on wins, then fewer games, then who got there first; at most 50 entries', () => {
    const now = Date.UTC(2026, 9, 14, 12);
    const [x, y, z, v] = [walletKey(), walletKey(), walletKey(), walletKey()];
    recordRankedResults([rec(x, { won: true })], now); // 30 points, 1 win, 1 game
    for (let i = 0; i < 3; i++) recordRankedResults([rec(y, { tasksDone: 10 })], now); // 30 points, no win
    recordRankedResults([rec(v)], now); // 0 points...
    recordRankedResults([rec(v, { won: true })], now); // ...then 30: 1 win in 2 games
    recordRankedResults([rec(z, { won: true })], now + 1); // like x, but later
    const lb = getRankedLeaderboard('current', now + 2);
    expect(lb.entries.map((e) => e.points)).toEqual([30, 30, 30, 30]);
    expect(lb.entries.map((e) => e.address)).toEqual([x, z, v, y]);
    for (let i = 0; i < 60; i++) recordRankedResults([rec(walletKey(), { won: true, tasksDone: 1 })], now);
    expect(getRankedLeaderboard('current', now + 2).entries).toHaveLength(50);
  });
});

// ================================================================= HTTP routes

interface Signer {
  address: string;
  sign(message: string): string;
}
function newSigner(): Signer {
  const kp = nacl.sign.keyPair();
  return { address: bs58.encode(kp.publicKey), sign: (m) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(m), kp.secretKey)) };
}

async function startApi(burns: BurnService): Promise<{ base: string; close(): Promise<void> }> {
  const app = express();
  app.use('/api', express.json({ limit: '16kb' }), createApiRouter({ getRoomsInfo: () => ({ publicLobbies: 0, playersOnline: 0 }), burns }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('HTTP burn, equip and ranked routes (mock mode)', () => {
  let api: { base: string; close(): Promise<void> };
  let service: BurnService;

  beforeEach(async () => {
    service = createBurnService({ settings: { mode: 'mock', cluster: 'mainnet-beta', mint: null, rpcUrl: RPC_URL, rankedEntryPrice: 50_000, priceMultiplier: 1 } });
    api = await startApi(service);
  });
  afterEach(async () => {
    await api.close();
  });

  const call = (method: 'GET' | 'POST', p: string, body?: unknown, token?: string) =>
    fetch(api.base + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function login(): Promise<{ token: string; address: string }> {
    const w = newSigner();
    const { nonce, message } = (await (await call('GET', `/auth/nonce?address=${w.address}`)).json()) as { nonce: string; message: string };
    const res = await call('POST', '/auth/verify', { address: w.address, nonce, signature: w.sign(message) });
    expect(res.status).toBe(200);
    return { token: ((await res.json()) as { token: string }).token, address: w.address };
  }

  it('config advertises mock mode; burns need a session', async () => {
    const cfg = (await (await call('GET', '/config')).json()) as { burn: unknown };
    expect(cfg.burn).toEqual({ mode: 'mock', cluster: 'mainnet-beta', mint: null, decimals: 6, rankedEntryPrice: 50_000, priceMultiplier: 1 });
    expect((await call('POST', '/burn/intent', { purpose: 'ranked' })).status).toBe(401);
    expect((await call('POST', '/burn/confirm', { intentId: 'ab'.repeat(16), signature: mockSig() })).status).toBe(401);
    expect((await call('POST', '/me/equip', { slot: 'skin', itemId: null })).status).toBe(401);
  });

  it('intent -> confirm -> profile, stats and idempotent receipts', async () => {
    const { token, address } = await login();
    const intentRes = await call('POST', '/burn/intent', { purpose: 'ranked' }, token);
    expect(intentRes.status).toBe(200);
    const intent = (await intentRes.json()) as BurnIntent;
    expect(intent).toMatchObject({ purpose: 'ranked', amount: 50_000, transaction: null });
    const signature = mockSig();
    const ok = await call('POST', '/burn/confirm', { intentId: intent.intentId, signature }, token);
    expect(ok.status).toBe(200);
    const receipt = (await ok.json()) as BurnReceipt;
    expect(receipt).toMatchObject({ status: 'confirmed', signature, amount: 50_000, purpose: 'ranked', explorerUrl: null, profile: { address, rankedTickets: 1 } });
    const again = await call('POST', '/burn/confirm', { intentId: intent.intentId, signature }, token);
    expect(((await again.json()) as BurnReceipt).signature).toBe(signature);
    expect(((await (await call('GET', '/me', undefined, token)).json()) as Profile).rankedTickets).toBe(1);

    const stats = (await (await call('GET', '/burns/stats')).json()) as BurnStats;
    expect(stats).toMatchObject({ mode: 'mock', totalBurned: 50_000, burns: 1 });
    expect(stats.recent[0]).toMatchObject({ signature, purpose: 'ranked', shortAddress: shortAddress(address) });

    const bad = await call('POST', '/burn/confirm', { intentId: intent.intentId, signature: 'nope' }, token);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBeTruthy();
    expect((await call('POST', '/burn/intent', { purpose: 'cosmetic', itemId: 'nope' }, token)).status).toBe(400);
  });

  it('POST /me/equip validates ownership and slot', async () => {
    const { token } = await login();
    const intent = (await (await call('POST', '/burn/intent', { purpose: 'cosmetic', itemId: 'rug_frog' }, token)).json()) as BurnIntent;
    await call('POST', '/burn/confirm', { intentId: intent.intentId, signature: mockSig() }, token);
    expect((await call('POST', '/burn/intent', { purpose: 'cosmetic', itemId: 'rug_frog' }, token)).status).toBe(409);

    const unequip = await call('POST', '/me/equip', { slot: 'rug', itemId: null }, token);
    expect(unequip.status).toBe(200);
    expect(((await unequip.json()) as Profile).cosmetics.equipped).toEqual({});
    const equip = await call('POST', '/me/equip', { slot: 'rug', itemId: 'rug_frog' }, token);
    expect(((await equip.json()) as Profile).cosmetics.equipped).toEqual({ rug: 'rug_frog' });
    for (const body of [{ slot: 'rug', itemId: 'rug_gold' }, { slot: 'skin', itemId: 'rug_frog' }, { slot: 'hat', itemId: 'rug_frog' }, { slot: 'rug', itemId: 5 }, { slot: 'rug' }]) {
      expect((await call('POST', '/me/equip', body, token)).status).toBe(400);
    }
  });

  it('GET /leaderboard/ranked serves this week and last week', async () => {
    const a = walletKey();
    recordRankedResults([{ address: a, role: 'rugger', won: true, rugs: 1, tasksDone: 0, correctVotes: 0, survived: true, leftEarly: false }]);
    const cur = (await (await call('GET', '/leaderboard/ranked?week=current')).json()) as RankedLeaderboard;
    expect(cur.weekId).toBe(rankedWeek().weekId);
    expect(cur.entries).toEqual([expect.objectContaining({ address: a, points: 45, games: 1, wins: 1 })]);
    expect(((await (await call('GET', '/leaderboard/ranked')).json()) as RankedLeaderboard).weekId).toBe(cur.weekId);
    expect(((await (await call('GET', '/leaderboard/ranked?week=previous')).json()) as RankedLeaderboard).entries).toEqual([]);
    expect((await call('GET', '/leaderboard/ranked?week=next')).status).toBe(400);
  });

  it('rate limits burn intents per IP', async () => {
    const { token } = await login();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await call('POST', '/burn/intent', { purpose: 'ranked' }, token)).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

// ================================================================= client wallet burns

describe('client wallet burns', () => {
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
  const savedOrigin = process.env.PUBLIC_ORIGIN;
  let api: { base: string; close(): Promise<void> } | null = null;
  let win: { location: { href: string; origin: string; host: string }; addEventListener(): void; phantom?: unknown };

  interface FakePhantom {
    provider: Record<string, any>;
    address: string;
    calls: string[];
    sent: unknown[];
  }

  /** Phantom with a real keypair. signAndSendTransaction lands the transaction on the fake chain. */
  function fakePhantom(chain: FakeChain | null, opts: { connectAs?: string; sendError?: unknown } = {}): FakePhantom {
    const kp = nacl.sign.keyPair();
    const address = bs58.encode(kp.publicKey);
    const calls: string[] = [];
    const sent: unknown[] = [];
    const provider: Record<string, any> = {
      isPhantom: true,
      publicKey: null,
      async connect() {
        calls.push('connect');
        const key = opts.connectAs && calls.filter((c) => c === 'connect').length > 1 ? opts.connectAs : address;
        provider.publicKey = { toString: () => key };
        return { publicKey: provider.publicKey };
      },
      async signMessage(message: Uint8Array) {
        calls.push('signMessage');
        return { signature: nacl.sign.detached(message, kp.secretKey), publicKey: provider.publicKey };
      },
      async signAndSendTransaction(tx: VersionedTransaction) {
        calls.push('signAndSendTransaction');
        sent.push(tx);
        if (opts.sendError) throw opts.sendError;
        expect(tx).toBeInstanceOf(VersionedTransaction);
        const signature = chain!.land(Buffer.from(tx.serialize()).toString('base64'));
        return { signature, publicKey: provider.publicKey };
      },
      signTransaction: () => {
        calls.push('signTransaction');
        throw new Error('never');
      },
      on() {},
    };
    return { provider, address, calls, sent };
  }

  async function setup(burns: BurnService, phantom: FakePhantom, intercept?: (path: string, res: Response) => Promise<Response>) {
    api = await startApi(burns);
    const base = api.base;
    storage.clear();
    process.env.PUBLIC_ORIGIN = 'https://rugs.example';
    win = { location: { href: 'https://rugs.example/', origin: 'https://rugs.example', host: 'rugs.example' }, addEventListener() {}, phantom: { solana: phantom.provider } };
    vi.stubGlobal('window', win);
    vi.stubGlobal('localStorage', memoryStorage);
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const p = String(input).replace(/^\/api/, '');
      const res = await realFetch(base + p, init);
      return intercept ? intercept(p, res) : res;
    });
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (savedOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = savedOrigin;
    if (api) await api.close();
    api = null;
  });

  /** A live service on the real clock (the client's timers are real), polling quickly. */
  function liveWorld(over: Partial<BurnServiceOptions> = {}) {
    const chain = createChain();
    const mint = randomKey();
    chain.mints.set(mint, { owner: TOKEN, data: mintAccountData(6) });
    const service = createBurnService({
      settings: liveSettings(mint),
      rpc: createConnectionRpc(RPC_URL, { fetch: chain.fetch }),
      pollTimeoutMs: 150,
      pollIntervalMs: 25,
      log: () => {},
      ...over,
    });
    const fund = (address: string, whole = 1_000_000) => {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(address)).toBase58();
      chain.tokenAccounts.push({ pubkey: ata, owner: address, mint, programId: TOKEN, amount: BigInt(whole) * 1_000_000n, decimals: 6 });
    };
    return { chain, mint, service, fund };
  }

  it('mock mode: burns without any Phantom transaction call', async () => {
    const service = createBurnService({ settings: { mode: 'mock', cluster: 'mainnet-beta', mint: null, rpcUrl: RPC_URL, rankedEntryPrice: 50_000, priceMultiplier: 1 } });
    const phantom = fakePhantom(null);
    await setup(service, phantom);
    const wallet = createWallet();
    await wallet.login();
    phantom.calls.length = 0;
    const stages: string[] = [];
    const receipt = await wallet.burn({ purpose: 'ranked' }, (s) => stages.push(s));
    expect(phantom.calls).toEqual([]);
    expect(stages).toEqual(['preparing', 'confirming', 'done']);
    expect(receipt.signature).toMatch(/^mock_[A-Za-z0-9]{24}$/);
    expect(receipt.explorerUrl).toBeNull();
    expect(wallet.getSession()!.profile.rankedTickets).toBe(1);
    expect(storage.has('amongrugs.pendingBurns')).toBe(false);

    const skin = await wallet.burn({ purpose: 'cosmetic', itemId: 'skin_diamond' });
    expect(skin.profile.cosmetics.equipped).toEqual({ skin: 'skin_diamond' });
    expect((await wallet.equip('skin', null)).cosmetics.equipped).toEqual({});
    expect(wallet.getSession()!.profile.cosmetics).toEqual({ owned: ['skin_diamond'], equipped: {} });
    await expect(wallet.equip('skin', 'skin_gold')).rejects.toThrow(/don't own/);
    await expect(wallet.burn({ purpose: 'cosmetic', itemId: 'skin_diamond' })).rejects.toThrow(/already own/);
  });

  it('live: checks the transaction, Phantom signs and sends it, the server confirms it', async () => {
    const { chain, service, fund, mint } = liveWorld();
    const phantom = fakePhantom(chain);
    fund(phantom.address);
    await setup(service, phantom);
    const wallet = createWallet();
    await wallet.login();
    phantom.calls.length = 0;
    const stages: string[] = [];
    const receipt = await wallet.burn({ purpose: 'cosmetic', itemId: 'name_glitch' }, (s) => stages.push(s));
    expect(stages).toEqual(['preparing', 'signing', 'confirming', 'done']);
    expect(phantom.calls).toEqual(['connect', 'signAndSendTransaction']);
    expect(receipt).toMatchObject({ purpose: 'cosmetic', itemId: 'name_glitch', amount: 30_000, explorerUrl: `https://solscan.io/tx/${receipt.signature}` });
    expect(wallet.getSession()!.profile.cosmetics.equipped).toEqual({ name: 'name_glitch' });
    const tx = phantom.sent[0] as VersionedTransaction;
    const ix = TransactionMessage.decompile(tx.message).instructions[0];
    expect(decodeBurnCheckedInstruction(ix, TOKEN_PROGRAM_ID).keys.mint.pubkey.toBase58()).toBe(mint);
    expect(storage.has('amongrugs.pendingBurns')).toBe(false);
  });

  it('live: refuses when Phantom is on another account', async () => {
    const { chain, service, fund } = liveWorld();
    const phantom = fakePhantom(chain, { connectAs: walletKey() });
    fund(phantom.address);
    await setup(service, phantom);
    const wallet = createWallet();
    await wallet.login();
    await expect(wallet.burn({ purpose: 'ranked' })).rejects.toThrow(/another account .*Switch Phantom to/);
    expect(phantom.calls).not.toContain('signAndSendTransaction');
  });

  it.each([
    [{ code: 4001, message: 'User rejected the request.' }, /cancelled the burn/],
    [{ code: -32603, message: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.' }, /Not enough SOL/],
    [{ code: -32603, message: 'Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1' }, /Not enough \$RUGS/],
    [{ code: -32603, message: 'Blockhash not found' }, /expired/],
  ])('live: turns Phantom errors into friendly messages (%o)', async (error, expected) => {
    const { chain, service, fund } = liveWorld();
    const phantom = fakePhantom(chain, { sendError: error });
    fund(phantom.address);
    await setup(service, phantom);
    const wallet = createWallet();
    await wallet.login();
    await expect(wallet.burn({ purpose: 'ranked' })).rejects.toThrow(expected);
    expect(storage.has('amongrugs.pendingBurns')).toBe(false);
  });

  it('live: shows the server error when the wallet lacks tokens', async () => {
    const { chain, service, fund } = liveWorld();
    const phantom = fakePhantom(chain);
    fund(phantom.address, 100);
    await setup(service, phantom);
    const wallet = createWallet();
    await wallet.login();
    await expect(wallet.burn({ purpose: 'ranked' })).rejects.toThrow('Not enough $RUGS. This costs 50,000, your wallet has 100.');
    expect(phantom.calls).not.toContain('signAndSendTransaction');
  });

  it.each([
    ['an extra transfer', 'transfer'],
    ['a bigger amount', 'amount'],
    ['another mint', 'mint'],
    ['another memo', 'memo'],
  ])('live: never signs a transaction with %s', async (_label, attack) => {
    const { chain, service, fund } = liveWorld();
    const phantom = fakePhantom(chain);
    fund(phantom.address);
    const thief = walletKey();
    await setup(service, phantom, async (p, res) => {
      if (p !== '/burn/intent' || !res.ok) return res;
      const intent = (await res.json()) as BurnIntent;
      const tx = VersionedTransaction.deserialize(Buffer.from(intent.transaction!, 'base64'));
      const msg = TransactionMessage.decompile(tx.message);
      const owner = msg.payerKey;
      if (attack === 'transfer') msg.instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(thief), lamports: 1_000_000_000 }));
      if (attack === 'amount') msg.instructions[0].data.writeBigUInt64LE(BigInt(intent.amountRaw) * 10n, 1);
      if (attack === 'mint') msg.instructions[0].keys[1].pubkey = new PublicKey(randomKey());
      if (attack === 'memo') msg.instructions[1].data = Buffer.from(intent.memo.slice(0, -1) + (intent.memo.endsWith('0') ? '1' : '0'));
      const forged = serializeTransaction(new VersionedTransaction(msg.compileToV0Message()));
      return new Response(JSON.stringify({ ...intent, transaction: forged }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wallet = createWallet();
    await wallet.login();
    await expect(wallet.burn({ purpose: 'ranked' })).rejects.toThrow(/nothing was signed/);
    expect(phantom.calls).not.toContain('signAndSendTransaction');
    warn.mockRestore();
  });

  it('keeps an unconfirmed burn in localStorage and resumes it later', async () => {
    const { chain, service, fund } = liveWorld();
    const phantom = fakePhantom(chain);
    fund(phantom.address);
    await setup(service, phantom);
    const wallet = createWallet({ confirmBudgetMs: 400, confirmRetryMs: 50 });
    await wallet.login();
    chain.hideNew = true; // sent, but the RPC doesn't see it yet
    await expect(wallet.burn({ purpose: 'ranked' })).rejects.toThrow(/not confirmed yet/);
    const pending = JSON.parse(storage.get('amongrugs.pendingBurns')!) as Array<{ intentId: string; signature: string; address: string }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ address: phantom.address, intentId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(wallet.getSession()!.profile.rankedTickets).toBe(0);

    // A reload later: the transaction is visible now.
    chain.hidden.clear();
    const reloaded = createWallet();
    const receipts = await reloaded.resumePendingBurns();
    expect(receipts.map((r) => r.signature)).toEqual([pending[0].signature]);
    expect(reloaded.getSession()!.profile.rankedTickets).toBe(1);
    expect(storage.has('amongrugs.pendingBurns')).toBe(false);
    expect(await reloaded.resumePendingBurns()).toEqual([]);
  });

  it('drops a pending burn the server rejects for good', async () => {
    const { chain, service, fund } = liveWorld();
    const phantom = fakePhantom(chain);
    fund(phantom.address);
    await setup(service, phantom);
    const wallet = createWallet();
    const session = await wallet.login();
    storage.set(
      'amongrugs.pendingBurns',
      JSON.stringify([{ intentId: 'ab'.repeat(16), signature: randomSig(), address: session.profile.address, purpose: 'ranked', amount: 50_000, at: Date.now() }]),
    );
    expect(await wallet.resumePendingBurns()).toEqual([]);
    expect(storage.has('amongrugs.pendingBurns')).toBe(false);
  });
});
