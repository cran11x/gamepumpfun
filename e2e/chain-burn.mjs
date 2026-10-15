// On-chain end-to-end test of the burn flow against a running AMONG RUGS server.
// Works against a local `solana-test-validator` (recommended; unlimited airdrops) or devnet.
//
//   solana-test-validator --reset --quiet &
//   RPC=http://127.0.0.1:8899 node e2e/chain-burn.mjs setup [--token-2022]
//   TOKEN_MINT=<printed mint> SOLANA_RPC_URL=http://127.0.0.1:8899 SOLANA_CLUSTER=devnet \
//     PUBLIC_ORIGIN=http://localhost:8787 DATA_DIR=/tmp/chain-data node dist/server/index.js &
//   RPC=http://127.0.0.1:8899 node e2e/chain-burn.mjs run
//
// Phase "setup": fund a payer, create a test SPL mint (classic Token, or Token-2022 with
// --token-2022), give a player tokens. Writes /tmp/devnet.json.
// Phase "run": with the server running in live mode on that mint, sign in as the player, burn for a
// ranked ticket and a cosmetic through the real API, send the server-built transactions to devnet,
// confirm them, and check balances, supply, grants and replay protection.
import fs from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getMint, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const RPC = process.env.RPC || 'https://api.devnet.solana.com';
const STATE = '/tmp/devnet.json';
const conn = new Connection(RPC, 'confirmed');
const phase = process.argv[2];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function airdrop(pubkey, sol) {
  for (let i = 0; i < 6; i++) {
    try {
      const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
      return true;
    } catch (e) {
      log('airdrop failed', String(e.message || e).slice(0, 120));
      await sleep(4000 * (i + 1));
    }
  }
  return false;
}

if (phase === 'setup') {
  const payer = Keypair.generate();
  const player = Keypair.generate();
  log('payer', payer.publicKey.toBase58(), 'player', player.publicKey.toBase58());
  let funded = await airdrop(payer.publicKey, 1);
  if (!funded) funded = await airdrop(payer.publicKey, 0.5);
  if (!funded) { console.log('SETUP_FAILED airdrop'); process.exit(2); }
  log('payer balance', (await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL);
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: player.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })), [payer]);
  const programId = process.argv.includes('--token-2022') ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mint = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, programId);
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, player.publicKey, false, 'confirmed', undefined, programId);
  await mintTo(conn, payer, mint, ata.address, payer, 1_000_000n * 1_000_000n, [], undefined, programId);
  log('mint', mint.toBase58(), 'player ata', ata.address.toBase58());
  fs.writeFileSync(STATE, JSON.stringify({ mint: mint.toBase58(), player: Array.from(player.secretKey) }));
  console.log('SETUP_OK', mint.toBase58());
  process.exit(0);
}

if (phase === 'run') {
  const BASE = process.env.BASE || 'http://localhost:8787';
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const player = Keypair.fromSecretKey(Uint8Array.from(st.player));
  const address = player.publicKey.toBase58();
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok }); log(ok ? 'PASS' : 'FAIL', name, detail); };
  const api = async (path, opts = {}, token) => {
    const r = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } });
    let body = null; try { body = await r.json(); } catch { /* empty */ }
    return { status: r.status, body };
  };

  const cfg = await api('/api/config');
  check('config live on devnet mint', cfg.body?.burn?.mode === 'live' && cfg.body?.burn?.mint === st.mint && cfg.body?.burn?.cluster === 'devnet', JSON.stringify(cfg.body?.burn));

  // Sign in like Phantom would: sign the server's login message.
  const n = await api(`/api/auth/nonce?address=${address}`);
  const sig = nacl.sign.detached(new TextEncoder().encode(n.body.message), player.secretKey);
  const v = await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ address, nonce: n.body.nonce, signature: bs58.encode(sig) }) });
  const token = v.body?.token;
  check('sign-in', v.status === 200 && !!token, `tickets=${v.body?.profile?.rankedTickets}`);

  const mintPk = new PublicKey(st.mint);
  const prog = (await conn.getAccountInfo(mintPk)).owner;
  log('token program', prog.toBase58());
  const supplyBefore = (await getMint(conn, mintPk, 'confirmed', prog)).supply;
  const ataAddr = (await conn.getTokenAccountsByOwner(player.publicKey, { mint: mintPk })).value[0].pubkey;
  const balBefore = (await getAccount(conn, ataAddr, 'confirmed', prog)).amount;

  async function burnFor(request) {
    const intent = await api('/api/burn/intent', { method: 'POST', body: JSON.stringify(request) }, token);
    if (intent.status !== 200) throw new Error(`intent ${intent.status} ${JSON.stringify(intent.body)}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(intent.body.transaction, 'base64'));
    const ixs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58());
    tx.sign([player]);
    const signature = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(signature, 'confirmed');
    for (let i = 0; i < 12; i++) {
      const c = await api('/api/burn/confirm', { method: 'POST', body: JSON.stringify({ intentId: intent.body.intentId, signature }) }, token);
      if (c.status === 200) return { intent: intent.body, signature, receipt: c.body, programs: ixs };
      if (c.status !== 202) throw new Error(`confirm ${c.status} ${JSON.stringify(c.body)}`);
      await sleep(3000);
    }
    throw new Error('confirm stayed pending');
  }

  const ranked = await burnFor({ purpose: 'ranked' });
  log('ranked burn', ranked.signature, 'programs', ranked.programs.join(','));
  check('ranked ticket granted', ranked.receipt.profile.rankedTickets === 1, `tickets=${ranked.receipt.profile.rankedTickets}`);
  check('explorer link is devnet solscan', /solscan\.io\/tx\/.+cluster=devnet/.test(ranked.receipt.explorerUrl || ''), ranked.receipt.explorerUrl);
  check('memo bound to intent', ranked.intent.memo.startsWith('AMONGRUGS ranked '), ranked.intent.memo);

  const cos = await burnFor({ purpose: 'cosmetic', itemId: 'skin_candles' });
  check('cosmetic owned + auto-equipped', cos.receipt.profile.cosmetics.owned.includes('skin_candles') && cos.receipt.profile.cosmetics.equipped.skin === 'skin_candles');

  const supplyAfter = (await getMint(conn, mintPk, 'confirmed', prog)).supply;
  const balAfter = (await getAccount(conn, ataAddr, 'confirmed', prog)).amount;
  const expected = (50_000n + 15_000n) * 1_000_000n;
  check('on-chain balance decreased by exact price', balBefore - balAfter === expected, `${balBefore - balAfter}`);
  check('on-chain supply decreased (burned, not transferred)', supplyBefore - supplyAfter === expected, `${supplyBefore - supplyAfter}`);

  // Replay: reuse the ranked signature for a fresh intent.
  const fresh = await api('/api/burn/intent', { method: 'POST', body: JSON.stringify({ purpose: 'ranked' }) }, token);
  const replay = await api('/api/burn/confirm', { method: 'POST', body: JSON.stringify({ intentId: fresh.body.intentId, signature: ranked.signature }) }, token);
  check('replayed signature rejected', replay.status >= 400 && replay.status < 500, `${replay.status} ${JSON.stringify(replay.body)}`);
  // Idempotent: same intent + signature returns the original receipt, no double grant.
  const again = await api('/api/burn/confirm', { method: 'POST', body: JSON.stringify({ intentId: ranked.intent.intentId, signature: ranked.signature }) }, token);
  const me = await api('/api/me', {}, token);
  check('idempotent confirm, no double grant', again.status === 200 && me.body.rankedTickets === 1, `status=${again.status} tickets=${me.body.rankedTickets}`);

  const stats = await api('/api/burns/stats');
  check('burn stats totals', stats.body.totalBurned === 65_000 && stats.body.burns === 2, JSON.stringify({ total: stats.body.totalBurned, burns: stats.body.burns }));

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `DEVNET_E2E_FAIL ${failed.length}/${results.length}` : `DEVNET_E2E_PASS ${results.length}/${results.length}`);
  console.log('SIGNATURES', ranked.signature, cos.signature);
  process.exit(failed.length ? 1 : 0);
}
