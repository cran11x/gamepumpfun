#!/usr/bin/env node
// AMONG RUGS end-to-end test: token burns (mock mode), the cosmetics shop and a full RANKED game.
//
//   npm run build && npm run e2e        (runs e2e/smoke.mjs, then this)
//   node e2e/ranked.mjs                 (this suite only)
//
// The production server from dist/ runs with BURN_MODE=mock and RANKED_ENTRY_PRICE=50000 on a free port
// with a throwaway DATA_DIR. (First it checks that BURN_MODE=mock with NODE_ENV=production refuses to start.)
// Four Chromium contexts (three desktop, one iPhone-sized touch device) each get a fake
// window.phantom.solana backed by a real tweetnacl ed25519 keypair held in Node (page.exposeFunction):
// connect() returns the public key, signMessage() really signs, and signAndSendTransaction() records the
// call and throws: mock mode must never ask Phantom for a transaction. Then, all through the real UI:
//   - everyone signs in with Phantom and renames
//   - the SHOP: burn for cosmetics (skin, name effect, rugs), auto-equip, UNEQUIP / EQUIP live in the lobby,
//     and other players' snapshots show the look
//   - ranked tickets are burned through the burn modal (GET TICKET, RANKED with 0 tickets, and the
//     NEED_TICKET modal after a ticketless JOIN); the server refuses ticketless and walletless entries
//   - the ranked lobby: RANKED chip, ticket badges, locked settings, no ADD BOT (and addBot / settings
//     refused with RANKED_LOCKED)
//   - START consumes one ticket each; the rugger rugs a holder wearing a rug (BodyView.rug is the
//     victim's own rug), a holder reports, and the living holders vote the rugger out: GRADUATED
//   - GET /api/leaderboard/ranked?week=current has everyone with RANKED_POINTS-exact points, and the
//     leaderboard modal shows them; burn stats add up
// Any page error or console error fails the run. Screenshots go to e2e/screenshots/ranked/ (gitignored).
//
// Env: E2E_HEADED=1, E2E_TIMEOUT_MS (default 240000), E2E_REAL_FONTS=1, E2E_SHOTS_DIR,
//      E2E_DESKTOP=1440x900 (the host's viewport; the other desktops use 1280x800), E2E_PHONE=390x844.

import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { chromium, devices } from 'playwright';
import nacl from 'tweetnacl';
import WebSocket from 'ws';
import { Failure, HEADED, Player, ROOT, T0, check, dist, loadShared, log, requireDist, size, sleep, startServer, stubFonts, until, wsHook } from './lib.mjs';

const SHOTS = path.resolve(process.env.E2E_SHOTS_DIR || path.join(ROOT, 'e2e', 'screenshots', 'ranked'));
const BUDGET_MS = Number(process.env.E2E_TIMEOUT_MS) || 240_000;
const ENTRY_PRICE = 50_000;
const SERVER_ENV = { BURN_MODE: 'mock', RANKED_ENTRY_PRICE: String(ENTRY_PRICE), NODE_ENV: undefined, TOKEN_MINT: undefined, COSMETIC_PRICE_MULTIPLIER: undefined };

const fmt = (n) => n.toLocaleString('en-US');

// ---------------------------------------------------------------- fake Phantom

/**
 * Init script: a minimal Phantom provider. Keys never enter the page: connect/signMessage call into Node
 * (context.exposeFunction), where the tweetnacl keypair lives.
 */
function phantomInit() {
  let publicKey = null;
  const key = (s) => ({ toString: () => s, toBase58: () => s, toJSON: () => s });
  const listeners = {};
  const refuseTx = async (method) => {
    await window.__e2ePhantomTx(method);
    throw new Error(`e2e fake Phantom: ${method} must never be called in mock mode`);
  };
  const provider = {
    isPhantom: true,
    isConnected: false,
    get publicKey() {
      return publicKey;
    },
    async connect() {
      publicKey = key(await window.__e2ePhantomConnect());
      provider.isConnected = true;
      return { publicKey };
    },
    async disconnect() {
      publicKey = null;
      provider.isConnected = false;
    },
    async signMessage(message, display) {
      if (!publicKey) throw Object.assign(new Error('Not connected'), { code: 4100 });
      if (!(message instanceof Uint8Array)) throw new Error('signMessage expects a Uint8Array');
      const sig = await window.__e2ePhantomSignMessage(Array.from(message), display ?? null);
      return { signature: new Uint8Array(sig), publicKey };
    },
    signAndSendTransaction: () => refuseTx('signAndSendTransaction'),
    signTransaction: () => refuseTx('signTransaction'),
    signAllTransactions: () => refuseTx('signAllTransactions'),
    on(ev, fn) {
      (listeners[ev] ??= []).push(fn);
    },
    off() {},
    removeListener() {},
  };
  Object.defineProperty(window, 'phantom', { value: Object.freeze({ solana: provider }), configurable: false });
}

class RankedPlayer extends Player {
  constructor(label, name, context, page, touch, shotsDir, wallet) {
    super(label, name, context, page, touch, shotsDir);
    this.wallet = wallet;
    this.address = wallet.address;
    this.token = null;
  }

  /** The app's stored session token (localStorage 'amongrugs.wallet'). */
  readToken() {
    return this.page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('amongrugs.wallet') ?? 'null')?.token ?? null;
      } catch {
        return null;
      }
    });
  }

  /** This player as seen in `viewer`'s latest snapshot. */
  async seenBy(viewer) {
    const s = await viewer.snap();
    return s?.players?.find((x) => x.id === this.id) ?? null;
  }
}

/** One wallet per context: a real ed25519 keypair; every signature request is logged. */
function makeWallet() {
  const kp = nacl.sign.keyPair();
  return { kp, address: bs58.encode(kp.publicKey), signed: [], txCalls: [] };
}

// ---------------------------------------------------------------- HTTP + raw WebSocket probes

async function api(base, p, { token, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}/api${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, json };
}

/** A fresh WebSocket that sends one entry message and returns the first welcome/error answer. */
async function wsProbe(base, msg) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const answer = new Promise((resolve) => {
      ws.on('message', (d) => {
        try {
          const m = JSON.parse(String(d));
          if (m.t === 'error' || m.t === 'welcome') resolve(m);
        } catch {
          /* ignore */
        }
      });
    });
    ws.send(JSON.stringify(msg));
    return await Promise.race([answer, sleep(5000).then(() => null)]);
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------- the test

const livePlayers = [];

async function main(G, server) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.png')) fs.rmSync(path.join(SHOTS, f));
  const host = new URL(server.base).host;

  // ---------- Config
  const cfg = (await api(server.base, '/config')).json;
  check(cfg?.burn?.mode === 'mock', `burn mode should be mock, got ${JSON.stringify(cfg?.burn)}`);
  check(cfg.burn.rankedEntryPrice === ENTRY_PRICE, `rankedEntryPrice ${cfg.burn.rankedEntryPrice}`);
  check(cfg.burn.priceMultiplier === 1, `priceMultiplier ${cfg.burn.priceMultiplier}`);
  const ticker = cfg.ticker;
  const priceOf = (id) => Math.max(1, Math.round(G.cosmeticById(id).price * cfg.burn.priceMultiplier));

  const browser = await chromium.launch({ headless: !HEADED });
  const players = livePlayers;
  try {
    const open = async (label, name, opts, touch) => {
      const context = await browser.newContext(opts);
      const wallet = makeWallet();
      await context.exposeFunction('__e2ePhantomConnect', () => wallet.address);
      await context.exposeFunction('__e2ePhantomSignMessage', (bytes, display) => {
        const msg = Uint8Array.from(bytes);
        wallet.signed.push({ text: Buffer.from(msg).toString('utf8'), display });
        return Array.from(nacl.sign.detached(msg, wallet.kp.secretKey));
      });
      await context.exposeFunction('__e2ePhantomTx', (method) => {
        wallet.txCalls.push(method);
      });
      await context.addInitScript(phantomInit);
      await context.addInitScript(wsHook);
      await stubFonts(context, 'e2e/ranked.mjs');
      const page = await context.newPage();
      const p = new RankedPlayer(label, name, context, page, touch, SHOTS, wallet);
      players.push(p);
      return p;
    };
    const desktopBig = { viewport: size(process.env.E2E_DESKTOP) ?? { width: 1440, height: 900 }, deviceScaleFactor: 1 };
    const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
    const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'];
    iphone.viewport = size(process.env.E2E_PHONE) ?? { width: 390, height: 844 };
    const alpha = await open('alpha', 'Alpha', desktopBig, false);
    const bravo = await open('bravo', 'Bravo', desktop, false);
    const charlie = await open('charlie', 'Charlie', desktop, false);
    const phone = await open('phone', 'Delta', iphone, true);
    const humans = [alpha, bravo, charlie, phone];
    const all = (fn) => Promise.all(humans.map(fn));
    const me = (p) => api(server.base, '/me', { token: p.token }).then((r) => r.json);

    // ---------- Home: TEST MODE badge, burn counter, Phantom sign-in + rename
    log('everyone: open the home screen, sign in with Phantom');
    await all(async (p) => {
      await p.page.goto(server.base, { waitUntil: 'load' });
      await p.page.locator('#btn-phantom').waitFor();
      await until(`${p.label} TEST MODE badge`, () => p.visible('.home .test-badge'));
      check((await p.text('.home .test-badge'))?.includes('TEST MODE: no real tokens'), `${p.label}: test badge text`);
      await until(`${p.label} burn counter`, () => p.visible('#burn-counter'));
      check((await p.text('#burn-counter .home-burns-n')) === '0', `${p.label}: burn counter should start at 0`);
      check(await p.visible('#btn-ranked'), `${p.label}: no RANKED button`);
    });
    await alpha.settle();
    await alpha.shot('01-home');
    await phone.shot('01-home');

    await all(async (p) => {
      await p.press('#btn-phantom');
      await until(`${p.label} signed in`, () => p.visible('.wallet-chip'), { timeout: 10_000 });
      check(p.wallet.signed.length === 1, `${p.label}: expected one signMessage, got ${p.wallet.signed.length}`);
      const lines = p.wallet.signed[0].text.split('\n');
      check(lines[0] === `${host} wants you to sign in with your Solana account:` && lines[1] === p.address, `${p.label}: signed something other than our login message: ${JSON.stringify(lines.slice(0, 2))}`);
      p.token = await p.readToken();
      check(/^[0-9a-f]{64}$/.test(p.token ?? ''), `${p.label}: no session token stored`);
      // Rename through the UI.
      await p.press('.wallet-chip button[aria-label="Rename"]');
      const input = p.page.locator('.rename input');
      await input.fill(p.name);
      await p.press('.rename button[type="submit"]');
      await until(`${p.label} renamed`, async () => (await p.text('.wallet-chip-name')) === p.name);
      await until(`${p.label} rename modal to close`, async () => !(await p.page.$('.rename')));
      const prof = await me(p);
      check(prof?.address === p.address && prof.name === p.name, `${p.label}: /api/me ${JSON.stringify(prof)}`);
      check(prof.rankedTickets === 0 && prof.cosmetics.owned.length === 0, `${p.label}: a new profile should have no tickets and no cosmetics`);
      check((await p.text('#btn-ranked .btn-chip')) === '0', `${p.label}: ticket chip should say 0`);
    });

    // ---------- SHOP: burn for cosmetics
    /** Opens the shop (home or lobby button), burns for `itemId` through the burn modal, closes both. */
    const burnCosmetic = async (p, itemId, { opener = '#btn-shop', shots = false } = {}) => {
      const item = G.cosmeticById(itemId);
      await p.press(opener);
      await p.page.locator('#shop-modal').waitFor({ state: 'visible' });
      await p.press(`.shop-tab[data-slot="${item.slot}"]`);
      const card = `.shop-card[data-item="${itemId}"]`;
      await p.page.locator(card).waitFor({ state: 'visible' });
      const price = await p.text(`${card} .shop-price-n`);
      check(price === fmt(priceOf(itemId)), `${p.label}: ${itemId} card price "${price}", expected ${fmt(priceOf(itemId))}`);
      if (shots) {
        await p.settle();
        await p.shot('10-shop');
      }
      await p.press(`${card} .shop-buy`);
      const modal = `#burn-modal[data-purpose="cosmetic"][data-item="${itemId}"]`;
      await p.page.locator(modal).waitFor({ state: 'visible' });
      const copy = await p.text(`${modal} .burn-copy`);
      const want = `Burn ${fmt(priceOf(itemId))} ${ticker}. Tokens are destroyed forever. Nobody receives them. You get: ${item.name} (${{ skin: 'pill skin', rug: 'rug pattern', name: 'name effect' }[item.slot]}).`;
      check(copy === want, `${p.label}: burn copy\n  got:  ${copy}\n  want: ${want}`);
      check(await p.visible(`${modal} .test-badge`), `${p.label}: burn modal has no TEST MODE badge`);
      if (shots) {
        await p.settle();
        await p.shot('11-burn-cosmetic');
      }
      await p.press('#btn-burn-confirm');
      await until(`${p.label} ${itemId} burn to confirm`, () => p.page.evaluate((m) => document.querySelector(m)?.dataset.state, modal).then((s) => (s === 'error' ? 'error' : s === 'done')), { timeout: 15_000 }).then((r) => {
        if (r === 'error') throw new Failure(`${p.label}: burn for ${itemId} failed in the UI`);
      });
      const err = await p.text(`${modal} .burn-msg`);
      check(!err, `${p.label}: unexpected burn message "${err}"`);
      check(await p.page.evaluate(() => document.querySelector('.burn-stage[data-stage="signing"]')?.classList.contains('is-skipped')), `${p.label}: the Phantom stage should be skipped in mock mode`);
      const result = await p.text(`${modal} .burn-result`);
      check(result?.includes(`${fmt(priceOf(itemId))} ${ticker} burned`), `${p.label}: burn result "${result}"`);
      check(!(await p.page.$(`${modal} .burn-explorer`)), `${p.label}: a mock burn must not link to an explorer`);
      if (shots) {
        await p.settle();
        await p.shot('12-burn-cosmetic-done');
      }
      await p.press('#btn-burn-done');
      await until(`${p.label} burn modal to close`, async () => !(await p.page.$('#burn-modal')));
      await until(`${p.label} ${itemId} card to show OWNED/EQUIPPED`, () => p.page.evaluate((c) => document.querySelector(c)?.classList.contains('is-owned'), card));
      const prof = await me(p);
      check(prof.cosmetics.owned.includes(itemId), `${p.label}: ${itemId} not owned after the burn`);
      return prof;
    };

    log('alpha: SHOP -> burn for Whale Crown (auto-equipped)');
    let prof = await burnCosmetic(alpha, 'skin_crown', { shots: true });
    check(prof.cosmetics.equipped.skin === 'skin_crown', 'alpha: the first skin should auto-equip into the empty slot');
    check(await alpha.page.evaluate(() => document.querySelector('.shop-card[data-item="skin_crown"]')?.classList.contains('is-equipped')), 'alpha: card should say EQUIPPED');
    check((await alpha.text('.shop-card[data-item="skin_crown"] .shop-equip')) === 'UNEQUIP', 'alpha: equipped card should offer UNEQUIP');
    await alpha.press('.modal--shop .modal-x');
    await until('alpha shop to close', async () => !(await alpha.page.$('#shop-modal')));

    log('phone: SHOP -> burn for On Fire (name effect)');
    prof = await burnCosmetic(phone, 'name_fire', { shots: true });
    check(prof.cosmetics.equipped.name === 'name_fire', 'phone: name effect should auto-equip');
    // A second item in the same slot is owned but not equipped: EQUIP it, then go back to On Fire.
    await phone.press('.modal--shop .modal-x');
    await until('phone shop to close', async () => !(await phone.page.$('#shop-modal')));

    log('bravo + charlie: SHOP -> burn for rug patterns');
    await Promise.all([burnCosmetic(bravo, 'rug_galaxy'), burnCosmetic(charlie, 'rug_persian')]);
    for (const p of [bravo, charlie]) {
      await p.press('.modal--shop .modal-x');
      await until(`${p.label} shop to close`, async () => !(await p.page.$('#shop-modal')));
    }
    // Owning an item twice is refused server-side (no double burn).
    {
      const r = await api(server.base, '/burn/intent', { token: alpha.token, method: 'POST', body: { purpose: 'cosmetic', itemId: 'skin_crown' } });
      check(r.status === 409, `burning for an owned item should be 409, got ${r.status}`);
      const eq = await api(server.base, '/me/equip', { token: bravo.token, method: 'POST', body: { slot: 'skin', itemId: 'skin_crown' } });
      check(eq.status >= 400 && eq.status < 500, `equipping an item you don't own should fail, got ${eq.status}`);
      const forged = await api(server.base, '/burn/confirm', { token: bravo.token, method: 'POST', body: { intentId: '0'.repeat(32), signature: 'mock_forgedsig1' } });
      check(forged.status === 404, `confirming an unknown intent should be 404, got ${forged.status}`);
    }

    // ---------- Ranked tickets through the burn modal
    const burnTicketInModal = async (p, { shots = false } = {}) => {
      const modal = '#burn-modal[data-purpose="ranked"]';
      await p.page.locator(modal).waitFor({ state: 'visible' });
      const copy = await p.text(`${modal} .burn-copy`);
      const want = `Burn ${fmt(ENTRY_PRICE)} ${ticker}. Tokens are destroyed forever. Nobody receives them. You get: 1 ranked ticket.`;
      check(copy === want, `${p.label}: ticket burn copy\n  got:  ${copy}\n  want: ${want}`);
      if (shots) {
        await p.settle();
        await p.shot('13-burn-ticket');
      }
      await p.press('#btn-burn-confirm');
      await until(`${p.label} ticket burn to confirm`, async () => {
        const st = await p.page.evaluate((m) => document.querySelector(m)?.dataset.state, modal);
        if (st === 'error') throw new Failure(`${p.label}: ticket burn failed: ${await p.text(`${modal} .burn-msg`)}`);
        return st === 'done';
      }, { timeout: 15_000 });
      check((await p.text(`${modal} .burn-result`))?.includes('Ranked ticket added. You have 1 ticket.'), `${p.label}: ticket result "${await p.text(`${modal} .burn-result`)}"`);
      if (shots) {
        await p.settle();
        await p.shot('14-burn-ticket-done');
      }
    };
    const inRankedLobby = (p, code) =>
      until(`${p.label} in the ranked lobby${code ? ` ${code}` : ''}`, async () => {
        const s = await p.snap();
        return (await p.view()) === 'lobby' && s?.room?.ranked === true && (!code || s.room.code === code);
      }, { timeout: 10_000 });

    log('alpha: GET TICKET, then RANKED (quick) creates the ranked room');
    await alpha.press('#btn-get-ticket');
    await burnTicketInModal(alpha, { shots: true });
    await alpha.press('#btn-burn-done');
    await until('alpha ticket chip = 1', async () => (await alpha.text('#btn-ranked .btn-chip')) === '1');
    await alpha.press('#btn-ranked');
    await inRankedLobby(alpha);
    const code = (await alpha.snap()).room.code;
    alpha.id = await alpha.page.evaluate(() => window.__e2e.welcome?.playerId);
    check((await alpha.snap()).room.hostId === alpha.id, 'alpha should host the ranked room');
    check(await alpha.visible('#lobby-ranked'), 'no RANKED chip in the ranked lobby');
    check(await alpha.page.isDisabled('#btn-start'), 'START should be disabled with one player');
    log(`ranked room ${code}`);

    log('bravo: RANKED with 0 tickets -> burn modal -> FIND RANKED GAME');
    await bravo.press('#btn-ranked');
    await until('bravo burn modal lead', async () => (await bravo.text('#burn-modal .burn-lead')) === 'Ranked games need a ticket. One ticket is used per game.');
    await burnTicketInModal(bravo);
    check((await bravo.text('#btn-burn-next')) === 'FIND RANKED GAME', 'bravo: done step should offer FIND RANKED GAME');
    await bravo.press('#btn-burn-next');
    await inRankedLobby(bravo, code);

    log('charlie: GET TICKET, RANKED');
    await charlie.press('#btn-get-ticket');
    await burnTicketInModal(charlie);
    await charlie.press('#btn-burn-done');
    await charlie.press('#btn-ranked');
    await inRankedLobby(charlie, code);
    await until('alpha START hint: need 1 more', async () => (await alpha.text('.lobby-start-hint'))?.startsWith('need 1 more player'));

    // ---------- The server refuses ticketless and walletless entries (raw WebSocket probes)
    log('server: ranked entry without a ticket / wallet is refused');
    {
      const quick = await wsProbe(server.base, { t: 'quick', name: 'Delta', authToken: phone.token, ranked: true });
      check(quick?.t === 'error' && quick.code === 'NEED_TICKET', `ranked quick without a ticket: ${JSON.stringify(quick)}`);
      const join = await wsProbe(server.base, { t: 'join', code, name: 'Delta', authToken: phone.token });
      check(join?.t === 'error' && join.code === 'NEED_TICKET', `join ranked without a ticket: ${JSON.stringify(join)}`);
      const create = await wsProbe(server.base, { t: 'create', name: 'Delta', authToken: phone.token, ranked: true });
      check(create?.t === 'error' && create.code === 'NEED_TICKET', `create ranked without a ticket: ${JSON.stringify(create)}`);
      const guest = await wsProbe(server.base, { t: 'join', code, name: 'Guest' });
      check(guest?.t === 'error' && guest.code === 'NEED_WALLET', `join ranked as a guest: ${JSON.stringify(guest)}`);
      const second = await wsProbe(server.base, { t: 'join', code, name: 'Alpha2', authToken: alpha.token });
      check(second?.t === 'error' && second.code === 'INVALID_ACTION', `a second seat for the same wallet: ${JSON.stringify(second)}`);
      check((await alpha.snap()).players.length === 3, 'a refused probe took a seat');
    }

    log('phone: JOIN the ranked room by code without a ticket -> NEED_TICKET -> burn -> ENTER RANKED');
    const tJoin = Date.now();
    await phone.page.fill('#input-code', code);
    await phone.press('#btn-join');
    await until('phone NEED_TICKET from the server', async () => (await phone.serverErrors(tJoin)).some((e) => e.code === 'NEED_TICKET'));
    await until('phone ticket burn modal', async () => (await phone.text('#burn-modal .burn-lead')) === 'You need a ranked ticket to enter ranked rooms.');
    check((await phone.view()) === 'home', 'phone should still be on the home screen');
    check((await alpha.snap()).players.length === 3, 'the ticketless player must not get a seat');
    await burnTicketInModal(phone, { shots: true });
    check((await phone.text('#btn-burn-next')) === 'ENTER RANKED', 'phone: done step should offer ENTER RANKED');
    await phone.press('#btn-burn-next');
    await inRankedLobby(phone, code);
    for (const p of humans) p.id = await p.page.evaluate(() => window.__e2e.welcome?.playerId);
    check(humans.every((p) => p.id), 'missing playerId');

    // ---------- Ranked lobby
    log('lobby: badges, locked settings, no bots, cosmetics in snapshots');
    await all((p) =>
      until(`${p.label} sees 4 players with tickets`, async () => {
        const s = await p.snap();
        return s.players.length === 4 && s.players.every((x) => x.hasTicket === true && !x.isBot) && (await p.page.locator('.lp .badge--ticket').count()) === 4;
      }),
    );
    for (const p of humans) {
      check(await p.visible('#lobby-ranked'), `${p.label}: RANKED chip missing`);
      check(!(await p.visible('#btn-add-bot')), `${p.label}: ADD BOT must not show in ranked`);
      check(!(await p.visible('#btn-remove-bot')), `${p.label}: REMOVE BOT must not show in ranked`);
      check(await p.page.locator('.lobby-panel--settings.is-locked').count(), `${p.label}: settings should be locked`);
      check(!(await p.visible('.lobby-ticket')), `${p.label}: has a ticket, so no BURN FOR TICKET callout`);
    }
    check(await alpha.visible('.settings-lock'), 'host: no lock note');
    check(await alpha.page.locator('.lobby-panel--settings .stepper-btn:not([disabled])').count() === 0, 'host: ranked steppers should all be disabled');
    // Even a hand-crafted message can't add a bot or change a locked setting.
    {
      const t = Date.now();
      check(await alpha.sendRaw({ t: 'addBot' }), 'raw send failed');
      await until('addBot refused with RANKED_LOCKED', async () => (await alpha.serverErrors(t)).some((e) => e.code === 'RANKED_LOCKED'));
      check(await alpha.sendRaw({ t: 'settings', settings: { killCooldown: 60, tasksPerPlayer: 2 } }), 'raw send failed');
      await until('settings refused with RANKED_LOCKED', async () => (await alpha.serverErrors(t)).filter((e) => e.code === 'RANKED_LOCKED').length >= 2);
      await sleep(300);
      const s = await alpha.snap();
      check(s.players.length === 4 && !s.players.some((x) => x.isBot), 'a bot got into the ranked room');
      check(s.room.settings.killCooldown === G.DEFAULT_SETTINGS.killCooldown && s.room.settings.tasksPerPlayer === G.DEFAULT_SETTINGS.tasksPerPlayer, 'ranked settings changed');
    }
    // Cosmetics: everyone sees the same looks (rugs too, but those are only drawn under your own body).
    const looks = { [alpha.label]: { skin: 'skin_crown' }, [bravo.label]: { rug: 'rug_galaxy' }, [charlie.label]: { rug: 'rug_persian' }, [phone.label]: { name: 'name_fire' } };
    await all((viewer) =>
      until(`${viewer.label} to see everyone's cosmetics`, async () => {
        for (const p of humans) {
          const seen = await p.seenBy(viewer);
          if (JSON.stringify(seen?.cosmetics ?? {}) !== JSON.stringify(looks[p.label])) return false;
        }
        return true;
      }),
    );
    // DOM: the name effect is on Delta's lobby row for everyone, Alpha's row draws the skin preview.
    await all((viewer) =>
      until(`${viewer.label} lobby row effects`, () =>
        viewer.page.evaluate(({ phoneId, alphaId }) => {
          const nm = document.querySelector(`.lp[data-id="${phoneId}"] .lp-name`);
          const pill = document.querySelector(`.lp[data-id="${alphaId}"] .lp-pill--pv canvas`);
          return nm?.dataset.nfx?.length > 0 && nm.textContent === 'Delta' && !!pill;
        }, { phoneId: phone.id, alphaId: alpha.id }),
      ),
    );

    log('alpha: UNEQUIP / EQUIP from the lobby shop shows up live for the others');
    await alpha.press('#btn-lobby-shop');
    await alpha.page.locator('#shop-modal').waitFor({ state: 'visible' });
    await alpha.press('.shop-card[data-item="skin_crown"] .shop-equip');
    await all((viewer) => until(`${viewer.label} to see Alpha without the crown`, async () => !(await alpha.seenBy(viewer))?.cosmetics?.skin, { timeout: 5000 }));
    check((await me(alpha)).cosmetics.equipped.skin === undefined, 'alpha: skin still equipped server-side');
    await until('EQUIP button back', async () => (await alpha.text('.shop-card[data-item="skin_crown"] .shop-equip')) === 'EQUIP');
    await alpha.press('.shop-card[data-item="skin_crown"] .shop-equip');
    await all((viewer) => until(`${viewer.label} to see Alpha's crown again`, async () => (await alpha.seenBy(viewer))?.cosmetics?.skin === 'skin_crown', { timeout: 5000 }));
    await alpha.press('.modal--shop .modal-x');
    await until('alpha lobby shop to close', async () => !(await alpha.page.$('#shop-modal')));

    await until('host START enabled', async () => !(await alpha.page.isDisabled('#btn-start')));
    check((await alpha.text('.lobby-start-hint')) === '4 players ready · START uses 1 ticket each', `start hint "${await alpha.text('.lobby-start-hint')}"`);
    await all((p) => p.settle());
    await alpha.shot('20-ranked-lobby');
    await phone.shot('20-ranked-lobby');
    await phone.shot('20-ranked-lobby-full', { fullPage: true });

    // ---------- START: tickets are consumed
    log('host: START (one ticket each)');
    await alpha.press('#btn-start');
    const roles = {};
    await all(async (p) => {
      await until(`${p.label} role reveal`, async () => (await p.view()) === 'roleReveal', { timeout: 6000, interval: 40 });
      roles[p.label] = (await p.snap()).me.role;
      const count = await until(`${p.label} reveal count`, () => p.text('.reveal-count'), { timeout: 2000, interval: 40 });
      check(count === '1 Rugger among 4 players', `${p.label}: reveal count "${count}"`);
    });
    log(`roles: ${humans.map((p) => `${p.label}=${roles[p.label]}`).join(' ')}`);
    check(Object.values(roles).filter((r) => r === 'rugger').length === 1, 'ranked with 4 players should have exactly 1 rugger');
    for (const p of humans) check((await me(p)).rankedTickets === 0, `${p.label}: ticket not consumed at START`);
    await all((p) => until(`${p.label} playing`, async () => (await p.view()) === 'playing', { timeout: 8000 }));

    const rugger = humans.find((p) => roles[p.label] === 'rugger');
    const holders = humans.filter((p) => p !== rugger);
    // The victim wears a rug, so the body shows the victim's own rug.
    const victim = holders.find((p) => looks[p.label].rug) ?? holders[0];
    const reporter = holders.find((p) => p !== victim && !p.touch) ?? holders.find((p) => p !== victim);
    const victimRug = looks[victim.label].rug ?? null;
    log(`rugger ${rugger.name} rugs ${victim.name} (rug ${victimRug}); ${reporter.name} reports`);

    // ---------- The rugger rugs the victim
    const victimPos = (await victim.state()).pos;
    check(victimPos, 'victim has no position');
    // Stand right next to the victim, so the victim (not another holder) is the nearest kill target.
    const killed = await rugger.walkTo(G, victimPos, (st) => st.acts.rug && dist(st.pos, victimPos) < 30, { timeout: 30_000 });
    check(killed, 'the round ended before the rugger reached the victim');
    if (rugger.touch) await rugger.press('.act--rug');
    else await rugger.page.keyboard.press('q');
    await until('the victim to be rugged', async () => (await victim.snap()).me?.alive === false, { timeout: 4000 });
    await all(async (p) => {
      if (p === reporter) return;
      await until(`${p.label} to see the body with the victim's rug`, async () => {
        const b = (await p.snap()).bodies.find((x) => x.id === victim.id);
        return b && (b.rug ?? null) === victimRug;
      }, { timeout: 5000 });
    });
    await sleep(600);
    await all((p) => p.shot('30-rugged'));

    // ---------- A holder reports the body
    const body = (await rugger.snap()).bodies.find((x) => x.id === victim.id);
    const reached = await reporter.walkTo(G, body, (st) => st.acts.report, { timeout: 25_000 });
    check(reached, 'the round ended before the report');
    const seenBody = (await reporter.snap()).bodies.find((x) => x.id === victim.id);
    check((seenBody?.rug ?? null) === victimRug, `reporter sees body rug ${seenBody?.rug}, expected ${victimRug}`);
    await reporter.page.keyboard.press('r');
    await until('the report meeting', async () => (await alpha.snap()).phase === 'meeting', { timeout: 4000 });
    check((await alpha.snap()).meeting.reason === 'report', 'the meeting should be a report');

    // ---------- Meeting: the living holders vote the rugger out, the rugger skips
    await all((p) => until(`${p.label} meeting screen`, async () => (await p.view()) === 'meeting', { timeout: 6000 }));
    log('meeting: waiting for the voting stage (30 s discussion)');
    await all((p) => until(`${p.label} voting stage`, async () => (await p.snap()).meeting?.stage === 'voting', { timeout: 40_000, interval: 200 }));
    await all(async (p) => {
      const s = await p.snap();
      if (!s.me.alive) return;
      const target = p === rugger ? 'skip' : rugger.id;
      if (target === 'skip') {
        await p.press('.mt-skip');
        await p.press('.mt-skip-confirm .btn--gold');
      } else {
        await p.press(`.mt-card[data-id="${target}"]`);
        await p.press(`.mt-card[data-id="${target}"] .mt-confirm-yes`);
      }
      await until(`${p.label} vote to register`, async () => (await p.snap()).meeting?.myVote === target, { timeout: 4000 });
    });
    await all((p) => until(`${p.label} ejection screen`, async () => (await p.view()) === 'ejection', { timeout: 12_000 }));
    const expected = `${rugger.name} was the Rugger.`;
    await all((p) => until(`${p.label} ejection text "${expected}"`, async () => (await p.text('.ej-main')) === expected, { timeout: 5000 }));
    log(expected);

    // ---------- Game over
    await all((p) => until(`${p.label} game-over screen`, async () => (await p.view()) === 'gameOver', { timeout: 12_000 }));
    const go = (await alpha.snap()).gameOver;
    check(go.winner === 'holders' && go.reason === 'ruggersEjected', `ending ${go.winner}/${go.reason}`);
    await all(async (p) => {
      await until(`${p.label} GRADUATED`, async () => (await p.text('.over-title')) === 'GRADUATED', { timeout: 4000 });
      check((await p.page.locator('.over-card').count()) === 4, `${p.label}: game over should list 4 players`);
    });
    await all((p) => p.settle());
    await all((p) => p.shot('40-gameover'));

    // ---------- Weekly leaderboard: RANKED_POINTS exactly
    const P = G.RANKED_POINTS;
    const want = new Map([
      [rugger.address, { points: P.perRug * 1, wins: 0, rugs: 1, correctVotes: 0 }],
      [victim.address, { points: P.holderWin, wins: 1, rugs: 0, correctVotes: 0 }],
    ]);
    for (const h of holders) if (h !== victim) want.set(h.address, { points: P.holderWin + P.perCorrectVote + P.survived, wins: 1, rugs: 0, correctVotes: 1 });
    const board = (await api(server.base, '/leaderboard/ranked?week=current')).json;
    check(/^\d{4}-W\d{2}$/.test(board?.weekId ?? ''), `weekId ${board?.weekId}`);
    check(board.weekStart <= Date.now() && Date.now() < board.weekEnd && new Date(board.weekStart).getUTCDay() === 1, 'week bounds');
    check(board.entries.length === 4, `leaderboard should list 4 players, got ${board.entries.length}`);
    for (const e of board.entries) {
      const w = want.get(e.address);
      const p = humans.find((x) => x.address === e.address);
      check(w && p, `unexpected leaderboard entry ${e.address}`);
      check(e.name === p.name && e.games === 1 && e.points === w.points && e.wins === w.wins && e.rugs === w.rugs && e.correctVotes === w.correctVotes,
        `${p.label}: leaderboard ${JSON.stringify(e)} expected ${JSON.stringify(w)}`);
    }
    const sorted = [...board.entries].sort((a, b) => b.points - a.points || b.wins - a.wins);
    check(board.entries.every((e, i) => e.points === sorted[i].points), 'leaderboard is not sorted by points');
    const prev = (await api(server.base, '/leaderboard/ranked?week=previous')).json;
    check(prev.entries.length === 0, 'last week should be empty');
    log(`leaderboard: ${board.entries.map((e) => `${e.name} ${e.points}`).join(', ')}`);
    for (const p of humans) {
      const pr = await me(p);
      check(pr.stats.gamesPlayed === 1, `${p.label}: lifetime gamesPlayed ${pr.stats.gamesPlayed}`);
      check(pr.rankedTickets === 0, `${p.label}: tickets ${pr.rankedTickets}`);
    }

    // ---------- Burn stats
    const stats = (await api(server.base, '/burns/stats')).json;
    const total = ENTRY_PRICE * 4 + ['skin_crown', 'name_fire', 'rug_galaxy', 'rug_persian'].reduce((s, id) => s + priceOf(id), 0);
    check(stats.mode === 'mock' && stats.burns === 8 && stats.totalBurned === total, `burn stats ${JSON.stringify({ ...stats, recent: stats.recent?.length })}, expected 8 burns / ${total}`);
    check(stats.recent.length === 8 && stats.recent.every((r) => r.explorerUrl === null && /^mock_/.test(r.signature)), 'recent burns should be the 8 mock burns');

    // ---------- Back to the lobby: tickets are gone
    await alpha.page.locator('.over-actions button', { hasText: 'BACK TO LOBBY' }).click();
    await all((p) => until(`${p.label} back in the lobby`, async () => (await p.view()) === 'lobby', { timeout: 6000 }));
    await all((p) =>
      until(`${p.label} sees NO TICKET for all`, async () => (await p.page.locator('.lp .badge--noticket').count()) === 4 && (await p.visible('.lobby-ticket'))),
    );
    check(await alpha.page.isDisabled('#btn-start'), 'START must be disabled when nobody has a ticket');
    check((await alpha.text('.lobby-start-hint'))?.startsWith('no ticket yet:'), `start hint "${await alpha.text('.lobby-start-hint')}"`);
    {
      // Even a raw start is refused: nothing to consume.
      const t = Date.now();
      await alpha.sendRaw({ t: 'start' });
      await until('raw START refused with NEED_TICKET', async () => (await alpha.serverErrors(t)).some((e) => e.code === 'NEED_TICKET' && /^No ranked ticket: /.test(e.message)));
      // The host has no ticket either, so the UI offers one instead of a bare toast.
      await until('host ticket offer', async () => (await alpha.text('#burn-modal .burn-lead')) === 'You need a ranked ticket before the host can start.');
      check((await alpha.snap()).phase === 'lobby', 'a ranked game started without tickets');
      await alpha.press('.modal--burn .modal-x');
      await until('host ticket offer to close', async () => !(await alpha.page.$('#burn-modal')));
    }
    await all((p) => p.settle());
    await alpha.shot('41-lobby-no-tickets');

    // ---------- Leaderboard modal (home -> THIS WEEK)
    log('alpha + phone: leave, open RANKED · THIS WEEK');
    await Promise.all(
      [alpha, phone].map(async (p) => {
        await p.press('#btn-leave');
        await until(`${p.label} home`, async () => (await p.view()) === 'home');
        await until(`${p.label} ticket chip 0`, async () => (await p.text('#btn-ranked .btn-chip')) === '0');
        await until(`${p.label} burn counter`, async () => (await p.text('#burn-counter .home-burns-n')) === fmt(total));
        await p.press('#btn-ranked-week');
        await until(`${p.label} ranked tab`, () => p.visible('.lb-tab[data-tab="rankedCurrent"].is-active'));
        await until(`${p.label} 4 ranked rows`, async () => (await p.page.locator('.lb-row--ranked').count()) === 4);
        const vals = await p.page.$$eval('.lb-row--ranked .lb-val', (xs) => xs.map((x) => parseInt(x.textContent, 10)));
        check(JSON.stringify(vals) === JSON.stringify(board.entries.map((e) => e.points)), `${p.label}: leaderboard modal shows ${vals}`);
        check((await p.page.locator('.lb-row--me').count()) === 1, `${p.label}: own row not highlighted`);
        check((await p.text('.lb-week-reset'))?.startsWith('Resets in '), `${p.label}: no reset countdown`);
        await p.settle();
        await p.shot('50-leaderboard');
        await p.press('.lb-tab[data-tab="rankedPrevious"]');
        await until(`${p.label} last week empty`, async () => (await p.text('.lb-list .lb-state')) === 'No ranked games last week.');
        await p.press('.modal-x');
        await until(`${p.label} leaderboard closed`, async () => !(await p.page.$('.lb')));
      }),
    );
    // Recent burns list (desktop).
    await alpha.press('#burn-counter');
    await until('recent burns rows', async () => (await alpha.page.locator('.burns-row').count()) === 8);
    await alpha.settle();
    await alpha.shot('51-recent-burns');
    await alpha.press('.modal-x');

    // ---------- No errors anywhere, no transaction ever requested
    for (const p of humans) {
      check(p.wallet.txCalls.length === 0, `${p.label}: Phantom was asked for a transaction in mock mode: ${p.wallet.txCalls.join(', ')}`);
      check(p.wallet.signed.length === 1, `${p.label}: signMessage called ${p.wallet.signed.length} times (only the login should sign)`);
    }
    const problems = humans.flatMap((p) => p.problems.map((x) => `${p.label}: ${x}`));
    check(problems.length === 0, `page/console errors:\n  ${problems.join('\n  ')}`);
    const serverErrors = await all((p) => p.serverErrors());
    const rejected = humans.flatMap((p, i) => serverErrors[i].map((e) => `${p.label}: ${e.code} ${e.message}`));
    if (rejected.length) log(`server refusals (expected ones included):\n  ${rejected.join('\n  ')}`);
    const crashLines = server.output.filter((l) => /\[http\] error|Unhandled|TypeError|ReferenceError/.test(l));
    check(crashLines.length === 0, `server errors:\n  ${crashLines.join('\n  ')}`);
    return { board };
  } catch (err) {
    await Promise.all(players.map((p) => p.shot('failure')));
    for (const p of players) if (p.problems.length) log(`${p.label} problems:\n  ${p.problems.join('\n  ')}`);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** BURN_MODE=mock must never run in production: the server refuses to start. */
async function checkMockRefusedInProduction() {
  let started = null;
  try {
    started = await startServer({ env: { ...SERVER_ENV, NODE_ENV: 'production' }, timeout: 10_000 });
  } catch (err) {
    check(err instanceof Failure && /exited early/.test(err.message) && /BURN_MODE=mock/.test(err.message), `unexpected startup failure: ${err.message}`);
    return;
  }
  await started.stop();
  throw new Failure('the server started with BURN_MODE=mock and NODE_ENV=production');
}

async function run() {
  requireDist();
  const G = await loadShared();
  await checkMockRefusedInProduction();
  log('BURN_MODE=mock + NODE_ENV=production: refused to start (ok)');
  const server = await startServer({ env: SERVER_ENV });
  log(`server up at ${server.base} (BURN_MODE=mock, RANKED_ENTRY_PRICE=${ENTRY_PRICE})`);
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Failure(`ranked test exceeded ${BUDGET_MS} ms`)), BUDGET_MS);
  });
  let code = 0;
  try {
    const result = await Promise.race([main(G, server), watchdog]);
    log(`PASS in ${((Date.now() - T0) / 1000).toFixed(1)} s (${result.board.entries.map((e) => `${e.name}=${e.points}`).join(' ')})`);
  } catch (err) {
    code = 1;
    if (String(err?.message).startsWith('ranked test exceeded')) {
      await Promise.race([Promise.all(livePlayers.map((p) => p.shot('timeout'))), sleep(5000)]);
    }
    console.error(`\nFAIL: ${err instanceof Failure ? err.message : err.stack || err}`);
    if (server.exited) console.error(`server exited: ${JSON.stringify(server.exited)}`);
    console.error(`--- server log (last 40 lines) ---\n${server.output.slice(-40).join('\n')}`);
    console.error(`screenshots: ${SHOTS}`);
  } finally {
    clearTimeout(timer);
    await server.stop();
  }
  process.exit(code);
}

await run();
