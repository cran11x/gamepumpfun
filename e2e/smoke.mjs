#!/usr/bin/env node
// AMONG RUGS end-to-end smoke test.
//
//   npm run build && npm run e2e
//
// Starts the production server from dist/ on a free port with a throwaway DATA_DIR, then drives three
// real Chromium contexts (two desktop, one iPhone-sized touch device) through a whole game against bots:
//   create a room, join by code and by invite link, add bots, change settings, START, role reveal, HUD,
//   movement seen by another player, a real task minigame pumping the bonding curve, an X SPACES
//   meeting where everyone skips, and an ending forced by voting out the rugger, then BACK TO LOBBY.
// Any page error or console error fails the run. Screenshots go to e2e/screenshots/ (gitignored).
//
// State is read from the app's own WebSocket traffic: an init script wraps window.WebSocket and keeps
// the latest snapshot, events and the last `move` this client sent (its own predicted position).
//
// Env: E2E_HEADED=1 shows the browsers. E2E_TIMEOUT_MS changes the overall budget (default 175000).
//      E2E_REAL_FONTS=1 loads Google Fonts instead of stubbing them (the stub keeps the run offline-safe).
//      E2E_DESKTOP=1440x900 / E2E_PHONE=390x844 change the viewports, E2E_SHOTS_DIR the screenshot folder.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_JS = path.join(ROOT, 'dist', 'server', 'index.js');
const CLIENT_HTML = path.join(ROOT, 'dist', 'client', 'index.html');
const SHOTS = path.resolve(process.env.E2E_SHOTS_DIR || path.join(ROOT, 'e2e', 'screenshots'));
const BUDGET_MS = Number(process.env.E2E_TIMEOUT_MS) || 175_000;
const HEADED = process.env.E2E_HEADED === '1';
const REAL_FONTS = process.env.E2E_REAL_FONTS === '1';
const size = (v) => {
  const m = /^(\d+)x(\d+)$/.exec(v ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
};

const T0 = Date.now();
const log = (...a) => console.log(`[e2e ${((Date.now() - T0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

class Failure extends Error {}
function check(cond, msg) {
  if (!cond) throw new Failure(msg);
}

/** Polls `fn` until it returns something truthy. Conditions, not sleeps: `interval` only paces the polling. */
async function until(label, fn, { timeout = 10_000, interval = 60 } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() - start > timeout) throw new Failure(`Timed out after ${timeout} ms waiting for ${label}`);
    await sleep(interval);
  }
}

// ---------------------------------------------------------------- shared game data (map, geometry)

async function loadShared() {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: "export * from './shared/geometry'; export * from './shared/map'; export * from './shared/constants';",
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

/** The spam lines of the deleteBots minigame (the solver deletes exactly those). */
function loadSpamLines() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'tasks', 'deleteBots.ts'), 'utf8');
    const m = src.match(/const SPAM = \[([\s\S]*?)\];/);
    return m ? [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'")) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- server

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'among-rugs-e2e-'));
  const output = [];
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir };
  const proc = spawn(process.execPath, [SERVER_JS], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) output.push(line);
    if (output.length > 400) output.splice(0, output.length - 400);
  };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  let exited = null;
  proc.on('exit', (code, signal) => (exited = { code, signal }));
  const base = `http://127.0.0.1:${port}`;
  await until(
    'the server to answer /api/config',
    async () => {
      if (exited) throw new Failure(`Server exited early (${JSON.stringify(exited)}):\n${output.join('\n')}`);
      try {
        const r = await fetch(`${base}/api/config`);
        return r.ok;
      } catch {
        return false;
      }
    },
    { timeout: 15_000, interval: 100 },
  );
  return {
    base,
    output,
    get exited() {
      return exited;
    },
    async stop() {
      if (!exited) {
        proc.kill('SIGTERM');
        await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
        if (!exited) proc.kill('SIGKILL');
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- browser side

/** Init script: wraps window.WebSocket so the test can read what the app receives and sends. */
function wsHook() {
  const Native = window.WebSocket;
  const S = { snap: null, snaps: 0, progress: 0, welcome: null, events: [], errors: [], chats: [], selfPos: null, teleportSeq: null, moves: 0 };
  Object.defineProperty(window, '__e2e', { value: S });
  const onMessage = (ev) => {
    let m;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const at = Date.now();
    if (m.t === 'snap') {
      S.snap = m;
      S.snaps++;
      if (m.taskProgress >= 0) S.progress = m.taskProgress;
      // The server only sends our own position when it moves us (teleportSeq changes).
      if (m.me && m.me.teleportSeq !== S.teleportSeq) {
        S.teleportSeq = m.me.teleportSeq;
        S.selfPos = { x: m.me.x, y: m.me.y, at };
      }
    } else if (m.t === 'event') S.events.push({ ...m.event, at });
    else if (m.t === 'error') S.errors.push({ code: m.code, message: m.message, at });
    else if (m.t === 'chat') S.chats.push(m);
    else if (m.t === 'welcome') S.welcome = m;
  };
  class HookedWebSocket extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', onMessage);
    }
    send(data) {
      try {
        const m = JSON.parse(String(data));
        if (m && m.t === 'move') {
          S.moves++;
          S.selfPos = { x: m.x, y: m.y, at: Date.now() };
        }
      } catch {
        /* not JSON */
      }
      return super.send(data);
    }
  }
  window.WebSocket = HookedWebSocket;
}

class Player {
  constructor(label, name, context, page, touch) {
    this.label = label;
    this.name = name;
    this.context = context;
    this.page = page;
    this.touch = touch;
    this.problems = [];
    this.held = new Set();
    this.cdpSession = null;
    this.id = null;
    page.on('pageerror', (e) => this.problems.push(`pageerror: ${e.stack || e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') this.problems.push(`console.error: ${m.text()} (${m.location()?.url ?? ''})`);
    });
    page.on('crash', () => this.problems.push('page crashed'));
  }

  async cdp() {
    if (!this.cdpSession) this.cdpSession = await this.context.newCDPSession(this.page);
    return this.cdpSession;
  }

  /** One round trip: current screen, latest snapshot, own position and the USE button. */
  state() {
    return this.page.evaluate(() => {
      const S = window.__e2e;
      const use = document.querySelector('.act--use');
      return {
        view: document.getElementById('ui')?.dataset.view ?? null,
        snap: S.snap,
        pos: S.selfPos,
        moves: S.moves,
        events: S.events,
        use: use ? { target: use.dataset.target ?? 'none', on: !use.disabled, label: use.querySelector('.act-label')?.textContent ?? '' } : null,
      };
    });
  }

  view() {
    return this.page.evaluate(() => document.getElementById('ui')?.dataset.view ?? null);
  }

  snap() {
    return this.page.evaluate(() => window.__e2e.snap);
  }

  text(sel) {
    return this.page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
  }

  /** Click on desktop, tap on the touch device. */
  async press(sel) {
    const loc = this.page.locator(sel).first();
    if (this.touch) await loc.tap({ timeout: 8000 });
    else await loc.click({ timeout: 8000 });
  }

  /** Best effort, for screenshots: waits until the UI's finite CSS animations (screen-in etc.) are done. */
  async settle(timeout = 2500) {
    await until(
      `${this.label} UI animations to finish`,
      () =>
        this.page.evaluate(() =>
          document
            .getElementById('ui')
            .getAnimations({ subtree: true })
            .every((a) => a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)),
        ),
      { timeout, interval: 80 },
    ).catch(() => {});
  }

  async shot(name) {
    try {
      await this.page.screenshot({ path: path.join(SHOTS, `${name}-${this.label}.png`) });
    } catch (e) {
      log(`screenshot ${name}-${this.label} failed: ${e.message.split('\n')[0]}`);
    }
  }

  async keys(want) {
    for (const k of [...this.held]) if (!want.includes(k)) {
      await this.page.keyboard.up(k);
      this.held.delete(k);
    }
    for (const k of want) if (!this.held.has(k)) {
      await this.page.keyboard.down(k);
      this.held.add(k);
    }
  }

  /**
   * Walks along A* waypoints with the arrow keys until `arrived(state)` holds. The position comes from the
   * hooked `move` messages (what the server range-checks). Returns false if the round ended on the way.
   */
  async walkTo(G, target, arrived, { timeout = 25_000 } = {}) {
    const start = Date.now();
    let st = await this.state();
    check(st.pos, `${this.label}: no own position yet`);
    const plan = (from) => [...(G.findPath(from, target) ?? []), { x: target.x, y: target.y }];
    let route = plan(st.pos);
    let i = 0;
    let lastPos = st.pos;
    let lastProgressAt = Date.now();
    try {
      for (;;) {
        st = await this.state();
        if (st.snap?.phase !== 'playing') return false;
        if (arrived(st)) return true;
        check(Date.now() - start < timeout, `${this.label}: could not reach (${Math.round(target.x)}, ${Math.round(target.y)}) within ${timeout} ms; at ${JSON.stringify(st.pos)} use=${JSON.stringify(st.use)}`);
        const pos = st.pos;
        if (dist(pos, lastPos) > 3) {
          lastPos = pos;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > 1500) {
          // Stuck on a corner: let go and plan again from here.
          await this.keys([]);
          route = plan(pos);
          i = 0;
          lastProgressAt = Date.now();
          continue;
        }
        while (i < route.length - 1 && dist(pos, route[i]) < 22) i++;
        const wp = route[i];
        const dx = wp.x - pos.x;
        const dy = wp.y - pos.y;
        const want = [];
        if (Math.abs(dx) > 5 && Math.abs(dx) >= Math.abs(dy) * 0.4) want.push(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
        if (Math.abs(dy) > 5 && Math.abs(dy) >= Math.abs(dx) * 0.4) want.push(dy > 0 ? 'ArrowDown' : 'ArrowUp');
        await this.keys(want);
        await sleep(25);
      }
    } finally {
      await this.keys([]);
    }
  }

  /** Pointer input for minigames: the mouse on desktop, real touch events (CDP) on the phone. */
  input() {
    const page = this.page;
    const self = this;
    const touch = async (type, x, y) => {
      const c = await self.cdp();
      await c.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 3, radiusX: 6, radiusY: 6, force: 1 }] });
    };
    return {
      async down(x, y) {
        if (self.touch) await touch('touchStart', x, y);
        else {
          await page.mouse.move(x, y);
          await page.mouse.down();
        }
      },
      async move(x, y) {
        if (self.touch) await touch('touchMove', x, y);
        else await page.mouse.move(x, y);
      },
      async up() {
        if (self.touch) await touch('touchEnd');
        else await page.mouse.up();
      },
      async tap(x, y) {
        await this.down(x, y);
        await sleep(40);
        await this.up();
      },
      async tapSel(sel, idx = 0) {
        await page.evaluate(({ sel, idx }) => document.querySelectorAll(sel)[idx]?.scrollIntoView({ block: 'nearest' }), { sel, idx });
        const c = await center(page, sel, idx);
        check(c, `minigame: no ${sel}[${idx}]`);
        await this.tap(c.x, c.y);
        return c;
      },
      async drag(a, b, steps = 14) {
        await this.down(a.x, a.y);
        for (let i = 1; i <= steps; i++) {
          await this.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
          await sleep(16);
        }
        await sleep(30);
        await this.up();
      },
    };
  }
}

async function center(page, sel, idx = 0) {
  return page.evaluate(
    ({ sel, idx }) => {
      const e = document.querySelectorAll(sel)[idx];
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    },
    { sel, idx },
  );
}

// ---------------------------------------------------------------- minigame solvers

const SPAM = loadSpamLines();
/** Extra "distance" per kind when picking which task to do: the quick, deterministic ones first. */
const KIND_COST = { verifyCA: 0, bubblemap: 0, connectSocials: 120, burnLP: 120, swapSol: 160, shillPost: 160, deleteBots: SPAM.length ? 200 : Infinity, addLiquidity: 240, syncNode: 320, snipeLaunch: 320 };

const won = (p) => p.page.evaluate(() => !!document.querySelector('.tk--won') || !document.querySelector('.mg-overlay .tk'));

const SOLVERS = {
  async verifyCA(p, io) {
    for (let k = 0; k < 4 && !(await won(p)); k++) {
      const idx = await p.page.evaluate(() => {
        const ref = document.querySelector('.tk-ca-ref .tk-ca-addr')?.textContent;
        return [...document.querySelectorAll('.tk-ca-opt')].findIndex((b) => b.querySelector('.tk-ca-addr')?.textContent === ref);
      });
      check(idx >= 0, 'verifyCA: the real CA is not among the options');
      await io.tapSel('.tk-ca-opt', idx);
      await until('verifyCA to register', () => won(p), { timeout: 1500 }).catch(() => {});
    }
  },
  async snipeLaunch(p, io) {
    const c = await center(p.page, '.tk-snipe-btn');
    for (let k = 0; k < 10; k++) {
      if (await won(p)) return;
      // Resolve just as the marker reaches the zone's leading edge, then tap.
      const ok = await p.page.evaluate(
        () =>
          new Promise((res) => {
            const m = document.querySelector('.tk-snipe-marker');
            const z = document.querySelector('.tk-snipe-zone');
            if (!m || !z) return res(false);
            let prev = parseFloat(m.style.left);
            const t0 = performance.now();
            const step = () => {
              const cur = parseFloat(m.style.left);
              const zl = parseFloat(z.style.left);
              const zw = parseFloat(z.style.width);
              const v = cur - prev;
              prev = cur;
              if (v > 0 && cur >= zl - 3 && cur < zl + 1) return res(true);
              if (v < 0 && cur <= zl + zw + 3 && cur > zl + zw - 1) return res(true);
              if (performance.now() - t0 > 4000) return res(false);
              requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }),
      );
      if (!ok) continue;
      await io.tap(c.x, c.y);
      await sleep(700);
    }
  },
  async burnLP(p, io) {
    for (let k = 0; k < 4 && !(await won(p)); k++) {
      const t = await center(p.page, '.tk-lp:not(.is-burning):not(.is-gone)');
      const m = await center(p.page, '.tk-furnace-mouth');
      if (!t || !m) break;
      await io.drag(t, m, 16);
      await sleep(450);
    }
  },
  async shillPost(p, io) {
    const line = await p.page.$eval('.tk-shill-line', (e) => e.textContent);
    await io.tapSel('.tk-tweet-input');
    await until('the tweet box to take focus', () => p.page.evaluate(() => document.activeElement?.classList.contains('tk-tweet-input')), { timeout: 2000 });
    await p.page.keyboard.type(line, { delay: 8 });
    if (!(await until('the shill post to win', () => won(p), { timeout: 800 }).catch(() => false))) await io.tapSel('.tk-tweet-post').catch(() => {});
  },
  async addLiquidity(p, io) {
    for (let k = 0; k < 3 && !(await won(p)); k++) {
      const band = await p.page.$eval('.tk-liq-target-value', (e) => e.textContent);
      const [lo, hi] = band.replace('%', '').split(/[–-]/).map(Number);
      const mid = (lo + hi) / 2;
      const c = await center(p.page, '.tk-liq-btn');
      await io.down(c.x, c.y);
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        const v = parseFloat(await p.page.$eval('.tk-liq-read-value', (e) => e.textContent));
        if (v >= mid - 2) break;
        await sleep(15);
      }
      await io.up();
      await until('addLiquidity to register', () => won(p), { timeout: 1500 }).catch(() => {});
    }
  },
  async bubblemap(p, io) {
    const c = await center(p.page, '.tk-bm-group.is-bundle circle');
    check(c, 'bubblemap: no bundled cluster');
    await io.tap(c.x, c.y);
  },
  async connectSocials(p, io) {
    for (const lab of ['X', 'TG', 'WEB', 'CHART']) {
      const pts = await p.page.evaluate((lab) => {
        const f = (side) => [...document.querySelectorAll(`.tk-soc-node--${side}`)].find((n) => n.querySelector('.tk-soc-label')?.textContent === lab);
        const a = f('l');
        const b = f('r');
        if (!a || !b) return null;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return { a: { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 }, b: { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2 } };
      }, lab);
      check(pts, `connectSocials: no ${lab} sockets`);
      await io.drag(pts.a, pts.b, 16);
      await sleep(300);
    }
  },
  async deleteBots(p, io) {
    const n = await p.page.$$eval('.tk-cm', (xs) => xs.length);
    for (let i = 0; i < n; i++) {
      const txt = await p.page.evaluate((i) => document.querySelectorAll('.tk-cm')[i]?.querySelector('.tk-cm-text')?.textContent, i);
      if (SPAM.includes(txt)) {
        await io.tapSel('.tk-cm', i);
        await sleep(350);
      }
    }
  },
  async swapSol(p, io) {
    const target = parseFloat(await p.page.$eval('.tk-swap-order-value', (e) => e.textContent));
    const r = await p.page.$eval('.tk-slider', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await io.drag({ x: r.x + 4, y: r.y + r.h / 2 }, { x: r.x + (target / 3) * r.w, y: r.y + r.h / 2 }, 14);
    for (let k = 0; k < 25; k++) {
      const v = parseFloat(await p.page.$eval('.tk-swap-amt', (e) => e.textContent));
      if (Math.abs(v - target) <= 0.03) break;
      await io.tapSel(v < target ? '.tk-nudge:last-of-type' : '.tk-nudge:first-of-type');
      await sleep(50);
    }
    await io.tapSel('.tk-swap-go');
  },
  async syncNode(p) {
    await until('the node to sync', () => won(p), { timeout: 9000 });
  },
};

// ---------------------------------------------------------------- the test

/** The open browser contexts, so a timeout can still take failure screenshots. */
const livePlayers = [];

async function main(G, server) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.png')) fs.rmSync(path.join(SHOTS, f));

  const browser = await chromium.launch({ headless: !HEADED });
  const players = livePlayers;
  const cleanup = async () => {
    await browser.close().catch(() => {});
  };
  try {
    const open = async (label, name, opts, touch) => {
      const context = await browser.newContext(opts);
      await context.addInitScript(wsHook);
      if (!REAL_FONTS) {
        await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
          route.fulfill({ status: 200, contentType: 'text/css', body: '/* fonts stubbed by e2e/smoke.mjs */' }),
        );
      }
      const page = await context.newPage();
      const p = new Player(label, name, context, page, touch);
      players.push(p);
      return p;
    };
    const desktop = { viewport: size(process.env.E2E_DESKTOP) ?? { width: 1280, height: 800 }, deviceScaleFactor: 1 };
    const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'];
    if (size(process.env.E2E_PHONE)) iphone.viewport = size(process.env.E2E_PHONE);
    const host = await open('host', 'Alpha', { ...desktop, permissions: ['clipboard-read', 'clipboard-write'] }, false);
    const bravo = await open('bravo', 'Bravo', desktop, false);
    const phone = await open('phone', 'Charlie', iphone, true);
    const humans = [host, bravo, phone];
    const all = (fn) => Promise.all(humans.map(fn));
    const shotAll = (name) => all((p) => p.shot(name));

    // ---------- Home -> create room
    log('host: create a room');
    await host.page.goto(server.base, { waitUntil: 'load' });
    await host.page.locator('#btn-create').waitFor();
    await host.shot('01-home');
    await host.page.fill('#input-name', host.name);
    await host.press('#btn-create');
    await until('the host lobby', async () => (await host.view()) === 'lobby');
    const code = await until('a room code', async () => (await host.snap())?.room?.code);
    check(/^[A-HJ-NP-Z]{4}$/.test(code), `bad room code ${code}`);
    check((await host.text('#lobby-code'))?.trim() === code, 'lobby shows a different room code');
    host.id = (await host.snap()).room.hostId;
    log(`room ${code}`);

    // ---------- Invite link (clipboard, or the manual-copy fallback)
    await host.press('#btn-invite');
    const invite = await until('the invite link', () =>
      host.page.evaluate(async () => {
        const modal = document.querySelector('.manual-copy input');
        if (modal) return modal.value;
        try {
          const t = await navigator.clipboard.readText();
          return t.includes('?room=') ? t : null;
        } catch {
          return null;
        }
      }),
    );
    check(invite === `${server.base}/?room=${code}`, `unexpected invite link ${invite}`);
    await host.page.keyboard.press('Escape');

    // ---------- Join by code (desktop) and by invite link (phone)
    log('bravo: join by code');
    await bravo.page.goto(server.base, { waitUntil: 'load' });
    await bravo.page.fill('#input-name', bravo.name);
    await bravo.page.fill('#input-code', code);
    await bravo.press('#btn-join');
    await until('bravo in the lobby', async () => (await bravo.view()) === 'lobby');

    log('phone: join by invite link');
    await phone.page.goto(invite, { waitUntil: 'load' });
    await phone.page.locator('#btn-join').waitFor();
    await phone.shot('01-home');
    await until('the invite to prefill the code', () =>
      phone.page.evaluate((c) => document.querySelector('#input-code')?.value === c && document.querySelector('.home-join')?.classList.contains('is-invited'), code),
    );
    await phone.page.fill('#input-name', phone.name);
    await phone.press('#btn-join');
    await until('the phone in the lobby', async () => (await phone.view()) === 'lobby');
    check(await phone.page.evaluate(() => document.getElementById('ui').classList.contains('is-touch')), 'phone UI is not in touch mode');
    for (const p of humans) p.id = (await p.page.evaluate(() => window.__e2e.welcome?.playerId)) ?? null;
    check(humans.every((p) => p.id), 'missing welcome/playerId');

    // Lobby chat round trip.
    await bravo.page.fill('.lobby-panel--chat .chat-input', 'gm trenches');
    await bravo.page.keyboard.press('Enter');
    await until('host to receive the lobby chat', () => host.page.evaluate(() => window.__e2e.chats.some((c) => c.channel === 'lobby' && c.text === 'gm trenches')));

    // ---------- Bots up to 6 players, settings
    log('host: add bots, change settings');
    for (let n = (await host.snap()).players.length; n < 6; ) {
      await host.press('#btn-add-bot');
      const prev = n;
      n = await until('a bot to join', async () => {
        const c = (await host.snap()).players.length;
        return c > prev ? c : 0;
      });
    }
    const setSetting = async (label, key, target) => {
      for (let k = 0; k < 20; k++) {
        const cur = (await host.snap()).room.settings[key];
        if (Math.abs(cur - target) < 1e-9) return;
        await host.press(`button[aria-label="${cur > target ? 'Lower' : 'Raise'} ${label}"]`);
        await until(`${key} to change from ${cur}`, async () => (await host.snap()).room.settings[key] !== cur);
      }
      throw new Failure(`could not set ${key} to ${target}`);
    };
    await setSetting('Discussion', 'discussionTime', 0);
    await setSetting('Voting', 'votingTime', 15);
    await setSetting('Rug cooldown', 'killCooldown', 60); // after a meeting the rugger can't rug for 60 s
    await setSetting('Tasks each', 'tasksPerPlayer', 10); // bots can't graduate the curve during the test
    await setSetting('SPACES calls each', 'emergencyMeetings', 3);
    await setSetting('Speed', 'playerSpeed', 1.5);
    check((await host.snap()).room.settings.confirmEjects === true, 'confirmEjects should default to on');
    await all((p) => until(`${p.label} to see 6 players and discussion 0`, async () => {
      const s = await p.snap();
      return s.players.length === 6 && s.room.settings.discussionTime === 0;
    }));
    await Promise.all([host, phone].map(async (p) => {
      await p.settle();
      await p.shot('02-lobby');
    }));

    // ---------- Start: role reveal, then the HUD
    log('host: START');
    await host.press('#btn-start');
    const roles = {};
    await all(async (p) => {
      await until(`${p.label} role reveal`, async () => (await p.view()) === 'roleReveal', { timeout: 5000, interval: 40 });
      const s = await p.snap();
      roles[p.label] = s.me.role;
      const shown = await until(`${p.label} reveal text`, () => p.text('.reveal-role'), { timeout: 2000, interval: 40 });
      check(shown === s.me.role.toUpperCase(), `${p.label}: reveal says ${shown} but role is ${s.me.role}`);
      const count = await p.text('.reveal-count');
      check(count === '1 Rugger among 6 players', `${p.label}: reveal count "${count}"`);
    });
    log(`roles: ${humans.map((p) => `${p.label}=${roles[p.label]}`).join(' ')}`);
    await all((p) => p.settle(1500));
    await shotAll('03-reveal');
    await all(async (p) => {
      await until(`${p.label} playing HUD`, async () => (await p.view()) === 'playing', { timeout: 8000 });
      await p.page.locator('.hud .curve').waitFor({ state: 'visible' });
      await p.page.locator('.act--use').waitFor({ state: 'visible' });
      const chip = await until(`${p.label} role chip`, () => p.text('.role-chip'));
      check(chip === roles[p.label].toUpperCase(), `${p.label}: role chip says ${chip}`);
    });
    await phone.page.locator('.joy-zone').waitFor({ state: 'visible' });
    await all((p) => p.settle(1500));
    await shotAll('04-playing');

    // ---------- Movement: the phone walks with the joystick, the others see it in their snapshots
    log('phone: joystick walk');
    {
      const s0 = await phone.state();
      const from = s0.pos;
      const observers = [];
      for (const o of [host, bravo]) {
        const seen = (await o.snap()).players.find((x) => x.id === phone.id);
        if (seen) observers.push({ o, from: { x: seen.x, y: seen.y }, sawMoving: false });
      }
      check(observers.length > 0, 'nobody has the phone player in view at spawn');
      const zone = await phone.page.$eval('.joy-zone', (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
      const o = { x: zone.x + Math.min(100, zone.w * 0.4), y: zone.y + zone.h - Math.min(110, zone.h * 0.4) };
      const c = await phone.cdp();
      const pt = (x, y) => [{ x, y, id: 7, radiusX: 8, radiusY: 8, force: 1 }];
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(o.x, o.y) });
      await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(o.x, o.y + 30) });
      await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(o.x, o.y + 60) }); // push down
      try {
        await until(
          'the phone to walk ~90 px and the others to see it',
          async () => {
            const me = await phone.state();
            let ok = !!me.pos && dist(me.pos, from) > 90;
            for (const ob of observers) {
              const seen = (await ob.o.snap()).players.find((x) => x.id === phone.id);
              if (!seen) return false;
              if (seen.moving) ob.sawMoving = true;
              ob.to = { x: seen.x, y: seen.y };
              ok = ok && dist(seen, ob.from) > 60;
            }
            return ok;
          },
          { timeout: 4000, interval: 30 },
        );
      } finally {
        await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      const s1 = await phone.state();
      check(s1.pos.y > from.y + 60, `joystick down should move down: ${JSON.stringify(from)} -> ${JSON.stringify(s1.pos)}`);
      for (const ob of observers) {
        check(ob.sawMoving, `${ob.o.label} never saw the phone player moving`);
        log(`${ob.o.label} saw phone move (${Math.round(ob.from.x)},${Math.round(ob.from.y)}) -> (${Math.round(ob.to.x)},${Math.round(ob.to.y)})`);
      }
      await until('the phone player to stop', async () => {
        const seen = (await observers[0].o.snap()).players.find((x) => x.id === phone.id);
        return seen && !seen.moving;
      });
      await shotAll('05-moved');
    }

    // ---------- X SPACES: bravo walks to the SPACES button, everyone votes skip
    const E = G.EMERGENCY_BUTTON;
    const atSpaces = (st) => st.use?.target === 'emergency' && st.use.on;

    /** Walk `caller` to the SPACES button and press it. False when a meeting started some other way. */
    const callSpaces = async (caller, { mouse = true } = {}) => {
      await until(`${caller.label} able to call SPACES (no DEV DUMP)`, async () => {
        const s = await caller.snap();
        return s.phase !== 'playing' || s.sabotage?.kind !== 'devDump';
      }, { timeout: 45_000, interval: 200 });
      if ((await caller.snap()).phase !== 'playing') return false;
      const reached = await caller.walkTo(G, E, atSpaces);
      if (!reached) return false;
      check((await caller.text('.act--use .act-label')) === 'SPACES', 'USE button should read SPACES at the button');
      if (mouse) await caller.press('.act--use');
      else await caller.page.keyboard.press('e');
      await until('the meeting to start', async () => (await caller.snap()).phase !== 'playing', { timeout: 4000 });
      const s = await caller.snap();
      return s.phase === 'meeting' && s.meeting.callerId === caller.id && s.meeting.reason === 'emergency';
    };

    /** Posts a meeting chat line through the UI (the phone switches to the CHAT tab and back). */
    const sayInMeeting = async (p, text) => {
      const tabs = await p.page.locator('.mt-tabs').isVisible();
      if (tabs) await p.press('.mt-tab:nth-child(2)');
      const input = p.page.locator('.mt-chat .chat-input');
      await input.fill(text);
      await input.press('Enter');
      await until(`${p.label} meeting chat to go through`, () =>
        p.page.evaluate((t) => window.__e2e.chats.some((c) => c.channel === 'meeting' && c.text === t), text),
      );
      if (tabs) await p.press('.mt-tab:nth-child(1)');
    };

    /**
     * Runs a meeting. `decide(snapshots)` picks the humans' vote ('skip' or a player id) and optionally a
     * chat line each human (other than the target) posts first. Checks that every context shows the
     * matching ejection text and returns { ej, votes } (votes: voterId -> target, from the results stage).
     */
    const runMeeting = async (tag, decide) => {
      await all((p) => until(`${p.label} meeting screen`, async () => (await p.view()) === 'meeting', { timeout: 6000 }));
      const m0 = (await host.snap()).meeting;
      check(m0, 'meeting view missing');
      if (m0.reason === 'emergency') {
        const callerName = (await host.snap()).players.find((x) => x.id === m0.callerId)?.name;
        await until('the meeting title', async () => {
          const t = await host.text('.mt-title');
          return t?.includes('started an X Space') && t.includes(callerName);
        });
      }
      await all((p) => until(`${p.label} voting stage`, async () => (await p.snap()).meeting?.stage === 'voting', { timeout: 5000 }));
      // Meeting snapshots list everyone (ghosts too), unlike interest-managed play snapshots.
      const plan = await decide(await all((p) => p.snap()));
      await all(async (p) => {
        const s = await p.snap();
        if (!s.me.alive) return;
        if (plan.claim && p.id !== plan.vote) await sayInMeeting(p, plan.claim);
        const target = plan.vote;
        if (target === 'skip') {
          await p.press('.mt-skip');
          await p.press('.mt-skip-confirm .btn--gold');
        } else {
          await p.press(`.mt-card[data-id="${target}"]`);
          await p.press(`.mt-card[data-id="${target}"] .mt-confirm-yes`);
        }
        await until(`${p.label} vote to register`, async () => (await p.snap()).meeting?.myVote === target, { timeout: 4000 });
        // The "X SPACES IS LIVE" splash is gone by now; shoot the cards with our VOTED stamp.
        await until(`${p.label} meeting splash to leave`, () => p.page.evaluate(() => !!document.querySelector('.mt-splash.is-gone')), { timeout: 4000 });
        await p.settle(1500);
        await p.shot(`${tag}-meeting`);
      });
      log(`${tag}: humans voted, waiting for the bots`);
      const results = await until('the results stage', async () => {
        const s = await host.snap();
        return s.phase !== 'meeting' || s.meeting?.stage === 'results' ? s : null;
      }, { timeout: 20_000, interval: 100 });
      const votes = results.meeting?.votes ?? {};
      if (results.phase === 'meeting') await host.shot(`${tag}-results`);
      await all((p) => until(`${p.label} ejection screen`, async () => (await p.view()) === 'ejection', { timeout: 8000 }));
      const ej = (await host.snap()).ejection;
      const expected = ej.ejectedId
        ? ej.wasRugger === undefined
          ? `${ej.ejectedName} was blacklisted.`
          : `${ej.ejectedName} was ${ej.wasRugger ? 'the' : 'not the'} Rugger.`
        : 'No one was blacklisted.';
      await all((p) => until(`${p.label} ejection text "${expected}"`, async () => (await p.text('.ej-main')) === expected, { timeout: 5000 }));
      await shotAll(`${tag}-ejection`);
      log(`${tag}: ${expected}${ej.ruggersLeft !== undefined ? ` (${ej.ruggersLeft} left)` : ''}`);
      return { ej, votes };
    };

    const afterEjection = () =>
      all((p) => until(`${p.label} back from the ejection`, async () => ['playing', 'gameOver'].includes(await p.view()), { timeout: 10_000 }));

    // Holder bots skip without evidence, so a bot voting someone out with no body around is a rugger lead.
    const botLeads = new Set();
    const botIds = new Set((await host.snap()).players.filter((x) => x.isBot).map((x) => x.id));
    const noteVotes = (votes) => {
      for (const [voter, target] of Object.entries(votes)) if (botIds.has(voter) && target !== 'skip') botLeads.add(voter);
    };

    log('bravo: walk to SPACES');
    let skipped = false;
    for (let attempt = 0; attempt < 2 && !skipped; attempt++) {
      const called = await callSpaces(bravo);
      const { ej, votes } = await runMeeting(attempt ? '06b' : '06', async () => ({ vote: 'skip' }));
      check(ej.ejectedId === null, `everyone skipped, yet ${ej.ejectedName} was blacklisted`);
      noteVotes(votes);
      skipped = called;
      await afterEjection();
      if ((await host.view()) === 'gameOver') break;
      if (!called) log('a bot called that meeting first; calling again');
    }
    check(skipped || (await host.view()) === 'gameOver', 'bravo could not call X SPACES');

    // ---------- A real task: the human holder closest to one of its tasks walks there and solves it
    let curveCheck = null;
    /** One attempt. False when a meeting (a bot's report or SPACES) interrupted it. */
    const doTask = async () => {
      const candidates = [];
      for (const p of humans) {
        const st = await p.state();
        if (st.snap.me.role !== 'holder' || !st.snap.me.alive) continue;
        for (const t of st.snap.me.tasks) {
          if (t.done) continue;
          const station = G.TASK_STATIONS.find((s) => s.id === t.stationId);
          const route = G.findPath(st.pos, station);
          if (!route) continue;
          const cost = route.length * G.TILE + KIND_COST[t.kind] + (p.touch ? 120 : 0);
          candidates.push({ p, station, kind: t.kind, cost });
        }
      }
      candidates.sort((a, b) => a.cost - b.cost);
      check(candidates.length, 'no human holder has a reachable task');
      const { p: worker, station } = candidates[0];
      log(`${worker.label}: walk to ${station.id}`);
      const reached = await worker.walkTo(G, station, (st) => st.use?.target === 'task' && st.use.on && dist(st.pos, station) <= G.USE_RANGE);
      if (!reached) return false;
      const before = await worker.snap();
      const curveBefore = await worker.page.evaluate(() => window.__e2e.progress); // last visible value
      const domBefore = Math.round(curveBefore * 100);
      if (worker.touch) await worker.press('.act--use');
      else await worker.page.keyboard.press('e');
      const opened = await until('the server to open the task', async () => (await worker.snap()).me.activeStationId, { timeout: 4000 });
      const task = before.me.tasks.find((t) => t.stationId === opened);
      check(task, `opened a task that is not ours: ${opened}`);
      await worker.page.locator('.mg-overlay .tk').waitFor({ state: 'visible' });
      await worker.shot(`07-task-${task.kind}`);
      log(`${worker.label}: solving ${task.kind} at ${opened}`);
      try {
        await SOLVERS[task.kind](worker, worker.input());
      } catch (err) {
        if ((await worker.snap()).phase !== 'playing') return false; // a meeting closed the minigame
        throw err;
      }
      const confirmed = await until(`${task.kind} to be confirmed by the server`, async () => {
        const st = await worker.state();
        if (st.snap.phase !== 'playing') return 'interrupted';
        return st.events.some((e) => e.kind === 'taskCompleted' && e.stationId === opened) && st.snap.me.tasks.find((t) => t.stationId === opened)?.done;
      }, { timeout: 8000 });
      if (confirmed === 'interrupted') return false;
      await until('the minigame to close', async () => !(await worker.page.$('.mg-overlay .mg-frame')), { timeout: 3000 });
      const done = (await worker.snap()).me.tasks.filter((t) => t.done).length;
      check((await worker.text('.hud-tasks-count')) === `${done}/10`, 'task count in the HUD did not update');
      // The curve is hidden from holders during RPC DOWN; then it is checked in the next meeting
      // (meetings clear sabotage).
      const after = await until('the bonding curve to rise', async () => {
        const s = await worker.snap();
        if (s.phase === 'playing' && s.sabotage?.kind === 'rpcDown') return 'rpc';
        return s.taskProgress > curveBefore ? s : null;
      }, { timeout: 5000, interval: 100 });
      if (after === 'rpc') {
        log('RPC DOWN hides the curve; checking it in the next meeting');
        curveCheck = { before: curveBefore, idx: humans.indexOf(worker) };
      } else {
        log(`bonding curve ${Math.round(curveBefore * 100)}% -> ${Math.round(after.taskProgress * 100)}%`);
        if (after.phase === 'playing') {
          await until('the HUD curve to rise', async () => Number(await worker.page.getAttribute('.curve', 'aria-valuenow')) > domBefore, { timeout: 3000 });
          await worker.shot('08-task-done');
        }
      }
      return true;
    };
    let taskDone = false;
    for (let attempt = 0; attempt < 3 && !taskDone; attempt++) {
      const view = await host.view();
      if (view === 'gameOver') break;
      if (view !== 'playing') {
        log('a meeting interrupted the task; skipping it and trying again');
        await runMeeting(`07m${attempt}`, async () => ({ vote: 'skip' }));
        await afterEjection();
        continue;
      }
      taskDone = await doTask();
    }
    check(taskDone || (await host.view()) === 'gameOver', 'no human holder completed a task');

    // ---------- The ending: vote out the rugger
    // A human rugger knows itself; a ghost sees every role. Otherwise the humans blacklist bots one at a
    // time (confirmed blacklists reveal the role), leads first. Holder bots skip without evidence, which
    // would tie 3 human votes against 3 bot skips, so the other humans also claim in chat that they saw
    // the target rug: the bots weigh eyewitness claims and vote with them.
    const excluded = new Set();
    let meetingNo = 0;
    const pickTarget = (snaps) => {
      if (curveCheck) {
        const now = snaps[curveCheck.idx].taskProgress;
        check(now > curveCheck.before, `bonding curve did not rise: ${curveCheck.before} -> ${now}`);
        log(`bonding curve ${Math.round(curveCheck.before * 100)}% -> ${Math.round(now * 100)}% (read in the meeting)`);
        curveCheck = null;
      }
      let target = null;
      humans.forEach((p, i) => {
        const s = snaps[i];
        if (s.me.role === 'rugger' && s.me.alive) target ??= p.id;
        if (!s.me.alive) target ??= s.players.find((x) => x.isRugger && x.alive)?.id ?? null;
      });
      const bots = snaps[0].players.filter((x) => x.isBot && x.alive && !excluded.has(x.id));
      target ??= (bots.find((x) => botLeads.has(x.id)) ?? bots[0])?.id ?? null;
      check(target, 'no candidate left for the rugger');
      const name = snaps[0].players.find((x) => x.id === target)?.name ?? target;
      log(`voting out ${name}`);
      return { vote: target, claim: `I saw ${name} rug, vote ${name}` };
    };
    while ((await host.view()) !== 'gameOver') {
      check(meetingNo < 5, 'too many meetings without an ending');
      const snaps = await all((p) => p.snap());
      // Caller: a living human with SPACES calls left; after a meeting the host spawns in range already.
      const callers = humans.filter((p, i) => snaps[i].me.alive && snaps[i].me.emergencyLeft > 0);
      check(callers.length, 'no human can call SPACES');
      const caller = callers.includes(host) ? host : callers[0];
      meetingNo++;
      log(`${caller.label}: SPACES (${caller === host ? 'E key' : 'button'})`);
      const called = await callSpaces(caller, { mouse: caller !== host });
      if ((await host.snap()).phase === 'gameOver') break;
      if (!called && (await host.snap()).phase !== 'meeting') continue;
      const tag = `${String(8 + meetingNo).padStart(2, '0')}-vote${meetingNo}`;
      const { ej, votes } = await runMeeting(tag, async (meetingSnaps) => pickTarget(meetingSnaps));
      noteVotes(votes);
      if (ej.ejectedId && ej.wasRugger === false) excluded.add(ej.ejectedId);
      await afterEjection();
    }

    // ---------- Game over and back to the lobby
    await all((p) => until(`${p.label} game-over screen`, async () => (await p.view()) === 'gameOver', { timeout: 10_000 }));
    const go = (await host.snap()).gameOver;
    if (curveCheck) {
      const now = (await humans[curveCheck.idx].snap()).taskProgress;
      check(now < 0 || now > curveCheck.before, `bonding curve did not rise: ${curveCheck.before} -> ${now}`);
    }
    const title = go.winner === 'holders' ? 'GRADUATED' : 'RUGGED';
    await all(async (p) => {
      await until(`${p.label} game-over title`, async () => (await p.text('.over-title')) === title, { timeout: 4000 });
      check((await p.page.locator('.over-card').count()) === 6, `${p.label}: game over should list all 6 roles`);
    });
    log(`game over: ${go.winner} win (${go.reason})`);
    if (go.reason !== 'ruggersEjected') log(`note: the game ended by ${go.reason}, not by the forced vote`);
    await all((p) => p.settle());
    await shotAll('20-gameover');
    const back = host.page.locator('.over-actions button', { hasText: 'BACK TO LOBBY' });
    check(await back.isVisible(), 'host has no BACK TO LOBBY button');
    for (const p of [bravo, phone]) {
      check(!(await p.page.locator('.over-actions button', { hasText: 'BACK TO LOBBY' }).isVisible()), `${p.label} should not see BACK TO LOBBY`);
      check(await p.page.locator('.over-wait').isVisible(), `${p.label} should be waiting for the host`);
    }
    await back.click();
    await all((p) => until(`${p.label} back in the lobby`, async () => (await p.view()) === 'lobby', { timeout: 6000 }));
    check((await host.snap()).players.length === 6, 'lobby should still have 6 players');
    await host.page.locator('#btn-start').waitFor({ state: 'visible' });
    await all((p) => p.settle());
    await shotAll('21-lobby-again');

    // ---------- No errors anywhere
    const problems = humans.flatMap((p) => p.problems.map((x) => `${p.label}: ${x}`));
    check(problems.length === 0, `page/console errors:\n  ${problems.join('\n  ')}`);
    const serverErrors = await all((p) => p.page.evaluate(() => window.__e2e.errors));
    const rejected = humans.flatMap((p, i) => serverErrors[i].map((e) => `${p.label}: ${e.code} ${e.message}`));
    if (rejected.length) log(`server rejected some actions (not fatal):\n  ${rejected.join('\n  ')}`);
    return { roles, ending: go };
  } catch (err) {
    await Promise.all(players.map((p) => p.shot('failure')));
    for (const p of players) if (p.problems.length) log(`${p.label} problems:\n  ${p.problems.join('\n  ')}`);
    throw err;
  } finally {
    await cleanup();
  }
}

async function run() {
  if (!fs.existsSync(SERVER_JS) || !fs.existsSync(CLIENT_HTML)) {
    console.error('dist/ is missing. Run `npm run build` first, then `npm run e2e`.');
    process.exit(1);
  }
  const G = await loadShared();
  const server = await startServer();
  log(`server up at ${server.base}`);
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Failure(`smoke test exceeded ${BUDGET_MS} ms`)), BUDGET_MS);
  });
  let code = 0;
  try {
    const result = await Promise.race([main(G, server), watchdog]);
    log(`PASS in ${((Date.now() - T0) / 1000).toFixed(1)} s (ending: ${result.ending.winner}/${result.ending.reason})`);
  } catch (err) {
    code = 1;
    if (String(err?.message).startsWith('smoke test exceeded')) {
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
