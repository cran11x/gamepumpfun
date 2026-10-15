import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_NAME_LENGTH } from '../shared/constants';
import { shortAddress } from '../shared/protocol';
import {
  LEADERBOARD_SORTS,
  SESSION_TTL_MS,
  consumeRankedTickets,
  createSession,
  deleteSession,
  equipCosmetic,
  flushStore,
  getBurnByIntent,
  getBurnBySignature,
  getBurnIntent,
  getBurnTotals,
  getEquippedCosmetics,
  getLeaderboard,
  getProfile,
  getRankedLeaderboard,
  getSessionAddress,
  grantBurn,
  listBurnIntents,
  pruneBurnIntents,
  putBurnIntent,
  recordGameResults,
  recordRankedResults,
  resetStore,
  sanitizeProfileName,
  setProfileName,
  upsertProfile,
  type GameResultRecord,
  type StoredBurnIntent,
} from '../server/store';

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
let dir: string;

const newAddress = () => bs58.encode(nacl.randomBytes(32));
const dbFile = () => path.join(dir, 'db.json');

function rec(address: string, patch: Partial<GameResultRecord> = {}): GameResultRecord {
  return { address, role: 'holder', won: false, rugs: 0, tasksDone: 0, correctVotes: 0, wasRugged: false, ...patch };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amongrugs-store-'));
  process.env.DATA_DIR = dir;
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
  resetStore();
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

describe('profiles', () => {
  it('upsertProfile creates a default profile once and returns copies', () => {
    const a = newAddress();
    expect(getProfile(a)).toBeNull();
    const p = upsertProfile(a, 1234);
    expect(p).toEqual({
      address: a,
      name: shortAddress(a),
      stats: { gamesPlayed: 0, wins: 0, holderWins: 0, ruggerWins: 0, rugs: 0, timesRugged: 0, tasksDone: 0, correctVotes: 0 },
      createdAt: 1234,
      cosmetics: { owned: [], equipped: {} },
      rankedTickets: 0,
    });
    p.name = 'mutated';
    p.stats.wins = 99;
    const again = upsertProfile(a, 9999);
    expect(again.name).toBe(shortAddress(a));
    expect(again.stats.wins).toBe(0);
    expect(again.createdAt).toBe(1234);
    expect(Object.keys(again).sort()).toEqual(['address', 'cosmetics', 'createdAt', 'name', 'rankedTickets', 'stats']);
  });

  it('rejects addresses that are not 32-byte base58 keys', () => {
    expect(() => upsertProfile('not-an-address')).toThrow();
    expect(() => upsertProfile(bs58.encode(nacl.randomBytes(31)))).toThrow();
    expect(() => upsertProfile('0OIl' + 'a'.repeat(40))).toThrow();
  });

  it('setProfileName sanitizes and falls back to the short address', () => {
    const a = newAddress();
    upsertProfile(a);
    expect(setProfileName(a, '  degen\u0000\u200b king \n')?.name).toBe('degen king');
    expect(setProfileName(a, 'x'.repeat(40))?.name).toBe('x'.repeat(MAX_NAME_LENGTH));
    // Emoji are cut by code point, never split into broken surrogates.
    const emoji = setProfileName(a, '🚀'.repeat(20))!.name;
    expect(Array.from(emoji)).toHaveLength(MAX_NAME_LENGTH);
    expect(emoji).toBe('🚀'.repeat(MAX_NAME_LENGTH));
    expect(setProfileName(a, '\u202e\u0007   ')?.name).toBe(shortAddress(a));
    expect(setProfileName(newAddress(), 'ghost')).toBeNull();
    expect(sanitizeProfileName('a\tb\r\nc')).toBe('a b c');
    expect(sanitizeProfileName(42)).toBe('');
  });
});

describe('recordGameResults', () => {
  it('aggregates stats across games', () => {
    const alice = newAddress();
    const bob = newAddress();
    const carol = newAddress();
    for (const a of [alice, bob, carol]) upsertProfile(a);

    // Game 1: holders win. Alice and Carol are holders, Bob rugged Carol.
    recordGameResults([
      rec(alice, { role: 'holder', won: true, tasksDone: 5, correctVotes: 1 }),
      rec(bob, { role: 'rugger', won: false, rugs: 1 }),
      rec(carol, { role: 'holder', won: true, tasksDone: 2, wasRugged: true }),
    ]);
    // Game 2: ruggers win. Alice is the rugger.
    recordGameResults([
      rec(alice, { role: 'rugger', won: true, rugs: 3 }),
      rec(bob, { role: 'holder', won: false, tasksDone: 4, wasRugged: true }),
      rec(carol, { role: 'holder', won: false, tasksDone: 1, correctVotes: 2, wasRugged: true }),
    ]);

    expect(getProfile(alice)!.stats).toEqual({
      gamesPlayed: 2,
      wins: 2,
      holderWins: 1,
      ruggerWins: 1,
      rugs: 3,
      timesRugged: 0,
      tasksDone: 5,
      correctVotes: 1,
    });
    expect(getProfile(bob)!.stats).toEqual({
      gamesPlayed: 2,
      wins: 0,
      holderWins: 0,
      ruggerWins: 0,
      rugs: 1,
      timesRugged: 1,
      tasksDone: 4,
      correctVotes: 0,
    });
    expect(getProfile(carol)!.stats).toEqual({
      gamesPlayed: 2,
      wins: 1,
      holderWins: 1,
      ruggerWins: 0,
      rugs: 0,
      timesRugged: 2,
      tasksDone: 3,
      correctVotes: 2,
    });
  });

  it('skips invalid records, dedupes addresses and clamps counters', () => {
    const a = newAddress();
    const fresh = newAddress(); // no profile yet
    upsertProfile(a);
    recordGameResults([
      rec(a, { won: true, tasksDone: 3 }),
      rec(a, { won: true, tasksDone: 3 }), // duplicate in the same game: ignored
      rec('bogus'),
      { ...rec(newAddress()), role: 'admin' as never },
      null as unknown as GameResultRecord,
      rec(fresh, { role: 'rugger', rugs: -5, tasksDone: Number.NaN, correctVotes: 1e12 }),
    ]);
    expect(getProfile(a)!.stats).toMatchObject({ gamesPlayed: 1, wins: 1, holderWins: 1, tasksDone: 3 });
    const f = getProfile(fresh)!;
    expect(f.name).toBe(shortAddress(fresh));
    expect(f.stats).toMatchObject({ gamesPlayed: 1, wins: 0, rugs: 0, tasksDone: 0 });
    expect(f.stats.correctVotes).toBeLessThanOrEqual(1000);
    recordGameResults([]);
    recordGameResults(undefined as unknown as GameResultRecord[]);
    expect(getProfile(a)!.stats.gamesPlayed).toBe(1);
  });
});

describe('getLeaderboard', () => {
  function seed() {
    const addr = { w: newAddress(), x: newAddress(), y: newAddress(), z: newAddress(), idle: newAddress() };
    upsertProfile(addr.idle); // never played: never listed
    // w: 3 games, 2 holder wins, 1 correct vote
    recordGameResults([rec(addr.w, { won: true, correctVotes: 1 })], 1);
    recordGameResults([rec(addr.w, { won: true })], 2);
    recordGameResults([rec(addr.w)], 3);
    // x: 2 games, 2 rugger wins, 6 rugs
    recordGameResults([rec(addr.x, { role: 'rugger', won: true, rugs: 4 })], 4);
    recordGameResults([rec(addr.x, { role: 'rugger', won: true, rugs: 2 })], 5);
    // y: 1 game, 0 wins, 3 correct votes
    recordGameResults([rec(addr.y, { correctVotes: 3 })], 6);
    // z: 3 games, 2 holder wins (same wins as w and same games: tie broken by who got there first)
    recordGameResults([rec(addr.z, { won: true })], 7);
    recordGameResults([rec(addr.z, { won: true })], 8);
    recordGameResults([rec(addr.z)], 9);
    return addr;
  }

  it('sorts by each key, descending, with deterministic tie-breaks', () => {
    const a = seed();
    const order = (sort: (typeof LEADERBOARD_SORTS)[number]) => getLeaderboard(sort).map((e) => e.address);

    // wins: x (2 wins, 2 games) before w and z (2 wins, 3 games); w finished its last game first.
    expect(order('wins')).toEqual([a.x, a.w, a.z, a.y]);
    expect(order('ruggerWins')).toEqual([a.x, a.w, a.z, a.y]);
    expect(order('holderWins')).toEqual([a.w, a.z, a.x, a.y]);
    expect(order('rugs')).toEqual([a.x, a.w, a.z, a.y]);
    expect(order('correctVotes')).toEqual([a.y, a.w, a.x, a.z]);
    expect(order('wins')).not.toContain(a.idle);
  });

  it('returns entries with short addresses, names and stats, honoring the limit', () => {
    const a = seed();
    setProfileName(a.x, 'rug lord');
    const top = getLeaderboard('rugs', 2);
    expect(top).toHaveLength(2);
    expect(top[0]).toEqual({
      address: a.x,
      shortAddress: shortAddress(a.x),
      name: 'rug lord',
      stats: expect.objectContaining({ rugs: 6, ruggerWins: 2, gamesPlayed: 2 }),
    });
    expect(getLeaderboard('wins', 0)).toHaveLength(1);
    expect(getLeaderboard('wins', 1000)).toHaveLength(4);
    expect(getLeaderboard('nope' as never).map((e) => e.address)).toEqual(getLeaderboard('wins').map((e) => e.address));
  });

  it('reflects new results immediately and returns copies', () => {
    const a = seed();
    const before = getLeaderboard('rugs');
    before[0].stats.rugs = -1;
    before[0].name = 'tampered';
    recordGameResults([rec(a.y, { role: 'rugger', won: true, rugs: 10 })], 10);
    const after = getLeaderboard('rugs');
    expect(after[0].address).toBe(a.y);
    expect(after[1]).toMatchObject({ address: a.x, stats: expect.objectContaining({ rugs: 6 }) });
    expect(after[1].name).toBe(shortAddress(a.x));
  });
});

describe('sessions', () => {
  it('creates random hex tokens with a 30-day expiry', () => {
    const a = newAddress();
    upsertProfile(a);
    const t0 = 1_000_000;
    const token = createSession(a, t0);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(createSession(a, t0)).not.toBe(token);
    expect(getSessionAddress(token, t0 + 1)).toBe(a);
    expect(getSessionAddress(token, t0 + SESSION_TTL_MS - 1)).toBe(a);
    expect(getSessionAddress(token, t0 + SESSION_TTL_MS)).toBeNull();
    // An expired session is gone for good.
    expect(getSessionAddress(token, t0 + 1)).toBeNull();
  });

  it('deleteSession revokes, and garbage tokens never resolve', () => {
    const a = newAddress();
    upsertProfile(a);
    const token = createSession(a);
    expect(deleteSession(token)).toBe(true);
    expect(deleteSession(token)).toBe(false);
    expect(getSessionAddress(token)).toBeNull();
    expect(getSessionAddress('')).toBeNull();
    expect(getSessionAddress('zz'.repeat(32))).toBeNull();
    expect(getSessionAddress(undefined as unknown as string)).toBeNull();
  });

  it('keeps at most 10 sessions per wallet (oldest dropped) and needs a profile', () => {
    const a = newAddress();
    upsertProfile(a);
    const tokens = Array.from({ length: 11 }, (_, i) => createSession(a, 1000 + i));
    expect(getSessionAddress(tokens[0], 2000)).toBeNull();
    for (const t of tokens.slice(1)) expect(getSessionAddress(t, 2000)).toBe(a);
    expect(() => createSession(newAddress())).toThrow();
  });
});

describe('persistence', () => {
  it('debounces writes, then saves atomically without plaintext tokens', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = newAddress();
    upsertProfile(a);
    const token = createSession(a);
    recordGameResults([rec(a, { won: true, tasksDone: 4 })]);
    expect(fs.existsSync(dbFile())).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(fs.existsSync(dbFile())).toBe(true);

    const raw = fs.readFileSync(dbFile(), 'utf8');
    expect(raw).not.toContain(token);
    const db = JSON.parse(raw);
    expect(db.version).toBe(2);
    expect(db.profiles[a].stats.wins).toBe(1);
    expect(Object.keys(db.sessions)).toHaveLength(1);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('reloads everything from disk', () => {
    const a = newAddress();
    upsertProfile(a);
    setProfileName(a, 'diamond hands');
    recordGameResults([rec(a, { role: 'rugger', won: true, rugs: 2 })]);
    const token = createSession(a);
    flushStore();

    resetStore(); // forget memory; next call reads db.json
    expect(getProfile(a)).toMatchObject({ name: 'diamond hands', stats: expect.objectContaining({ ruggerWins: 1, rugs: 2 }) });
    expect(getSessionAddress(token)).toBe(a);
    expect(getLeaderboard('rugs')[0].address).toBe(a);
  });

  it('flushStore is a no-op when nothing changed', () => {
    getProfile(newAddress());
    flushStore();
    expect(fs.existsSync(dbFile())).toBe(false);
  });

  it('moves a corrupt db aside and starts empty; removes stale tmp files', () => {
    fs.writeFileSync(dbFile(), '{"profiles": {nope');
    fs.writeFileSync(path.join(dir, 'db.json.123.4.tmp'), 'half-written');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = newAddress();
    expect(getProfile(a)).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.startsWith('db.json.corrupt-'))).toBe(true);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);

    upsertProfile(a);
    flushStore();
    resetStore();
    expect(getProfile(a)?.address).toBe(a);
  });

  it('ignores malformed entries in an otherwise valid file', () => {
    const good = newAddress();
    fs.writeFileSync(
      dbFile(),
      JSON.stringify({
        version: 1,
        profiles: {
          [good]: { address: good, name: 'ok\u0000', stats: { wins: 2, gamesPlayed: 3, rugs: 'many' }, createdAt: 5 },
          'bad-address': { name: 'x', stats: {} },
        },
        sessions: { nothex: { address: good, expiresAt: Date.now() + 1000 } },
      }),
    );
    const p = getProfile(good)!;
    expect(p.name).toBe('ok');
    expect(p.stats).toMatchObject({ wins: 2, gamesPlayed: 3, rugs: 0, correctVotes: 0 });
    expect(getProfile('bad-address')).toBeNull();
  });
});

describe('migration and burn data', () => {
  const hex = (n = 16) => Buffer.from(nacl.randomBytes(n)).toString('hex');
  const mockSig = () => `mock_${hex(8)}`;

  it('loads version 1 files: profiles get no cosmetics and no tickets, and are written back as version 2', () => {
    const a = newAddress();
    fs.writeFileSync(
      dbFile(),
      JSON.stringify({
        version: 1,
        profiles: { [a]: { address: a, name: 'old timer', stats: { gamesPlayed: 4, wins: 2 }, createdAt: 77, lastPlayedAt: 99 } },
        sessions: {},
      }),
    );
    const p = getProfile(a)!;
    expect(p).toMatchObject({ name: 'old timer', createdAt: 77, cosmetics: { owned: [], equipped: {} }, rankedTickets: 0 });
    expect(p.stats).toMatchObject({ gamesPlayed: 4, wins: 2 });
    expect(getEquippedCosmetics(a)).toEqual({});

    grantBurn({ signature: mockSig(), intentId: hex(), address: a, purpose: 'cosmetic', itemId: 'skin_gold', amount: 60_000, amountRaw: '60000000000', at: 5 });
    flushStore();
    const db = JSON.parse(fs.readFileSync(dbFile(), 'utf8'));
    expect(db.version).toBe(2);
    expect(db.profiles[a]).toMatchObject({ name: 'old timer', rankedTickets: 0, cosmetics: { owned: ['skin_gold'], equipped: { skin: 'skin_gold' } } });
    expect(db.burns).toHaveLength(1);
  });

  it('normalizes stored cosmetics and keeps retired items on disk without serving them', () => {
    const a = newAddress();
    fs.writeFileSync(
      dbFile(),
      JSON.stringify({
        version: 2,
        profiles: {
          [a]: {
            address: a,
            name: 'x',
            stats: {},
            createdAt: 1,
            rankedTickets: 3.7,
            cosmetics: {
              owned: ['skin_gold', 'skin_gold', 'rug_frog', 'skin_retired_2025', 'BAD ID', 42, 'name_fire'],
              // rug_gold is not owned; name slot holds a skin; skin slot is fine.
              equipped: { skin: 'skin_gold', rug: 'rug_gold', name: 'skin_gold', hat: 'skin_gold' },
            },
          },
        },
      }),
    );
    expect(getProfile(a)).toMatchObject({ rankedTickets: 3, cosmetics: { owned: ['skin_gold', 'rug_frog', 'name_fire'], equipped: { skin: 'skin_gold' } } });
    expect(equipCosmetic(a, 'rug', 'rug_frog').ok).toBe(true);
    flushStore();
    const stored = JSON.parse(fs.readFileSync(dbFile(), 'utf8')).profiles[a].cosmetics;
    expect(stored.owned).toEqual(['skin_gold', 'rug_frog', 'skin_retired_2025', 'name_fire']);
    expect(stored.equipped).toEqual({ skin: 'skin_gold', rug: 'rug_frog' });
  });

  it('refuses a db.json written by a newer version instead of overwriting it', () => {
    const text = JSON.stringify({ version: 99, profiles: {}, sessions: {}, somethingNew: [1, 2, 3] });
    fs.writeFileSync(dbFile(), text);
    expect(() => getProfile(newAddress())).toThrow(/newer/);
    expect(fs.readFileSync(dbFile(), 'utf8')).toBe(text);
    expect(fs.readdirSync(dir).some((f) => f.includes('corrupt'))).toBe(false);
  });

  it('persists burns, intents, tickets and weekly ranked stats', () => {
    const a = newAddress();
    upsertProfile(a);
    const sig = mockSig();
    const intentId = hex();
    expect(grantBurn({ signature: sig, intentId, address: a, purpose: 'ranked', amount: 50_000, amountRaw: '50000000000', at: 10 }).ok).toBe(true);
    const nonce = hex();
    const intent: StoredBurnIntent = {
      id: hex(),
      address: a,
      purpose: 'cosmetic',
      itemId: 'rug_galaxy',
      amount: 80_000,
      amountRaw: '80000000000',
      decimals: 6,
      nonce,
      memo: `AMONGRUGS cosmetic:rug_galaxy ${nonce}`,
      mode: 'live',
      createdAt: 100,
      expiresAt: 700,
      claimed: false,
    };
    expect(putBurnIntent(intent)).toBe(true);
    expect(putBurnIntent({ ...intent, id: 'nope' })).toBe(false);
    expect(putBurnIntent({ ...intent, id: hex(), memo: 'AMONGRUGS cosmetic:rug_galaxy other' })).toBe(false);
    const week = Date.UTC(2026, 9, 14);
    recordRankedResults([{ address: a, role: 'rugger', won: true, rugs: 2, tasksDone: 0, correctVotes: 0, survived: true, leftEarly: false }], week);
    flushStore();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    resetStore();
    expect(getProfile(a)!.rankedTickets).toBe(1);
    expect(getBurnBySignature(sig)).toMatchObject({ intentId, amount: 50_000 });
    expect(getBurnByIntent(intentId)?.signature).toBe(sig);
    expect(getBurnTotals()).toMatchObject({ totalBurned: 50_000, burns: 1, recent: [{ signature: sig, name: shortAddress(a) }] });
    expect(getBurnIntent(intent.id)).toEqual(intent);
    expect(listBurnIntents(a)).toEqual([intent]);
    expect(getRankedLeaderboard('current', week).entries).toEqual([expect.objectContaining({ address: a, points: 50, rugs: 2 })]);
    expect(consumeRankedTickets([a])).toEqual({ ok: true });
    expect(pruneBurnIntents((i) => i.expiresAt < 1000)).toBe(1);
    expect(getBurnIntent(intent.id)).toBeNull();
  });

  it('skips corrupt burn records and lets the first record of a signature win', () => {
    const a = newAddress();
    const sig = mockSig();
    const first = { signature: sig, intentId: hex(), address: a, purpose: 'ranked', amount: 5, amountRaw: '5000000', at: 1 };
    fs.writeFileSync(
      dbFile(),
      JSON.stringify({
        version: 2,
        profiles: {},
        sessions: {},
        burns: [
          first,
          { ...first, intentId: hex(), amount: 999 }, // same signature again
          { ...first, signature: mockSig(), intentId: first.intentId }, // same intent again
          { ...first, signature: mockSig(), intentId: hex(), purpose: 'cosmetic' }, // cosmetic without an item
          { ...first, signature: 'x', intentId: hex() },
          null,
        ],
      }),
    );
    expect(getBurnTotals()).toMatchObject({ totalBurned: 5, burns: 1 });
    expect(getBurnBySignature(sig)?.amount).toBe(5);
  });
});
