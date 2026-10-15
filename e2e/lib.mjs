// Shared helpers for the AMONG RUGS end-to-end suites (e2e/smoke.mjs, e2e/ranked.mjs).
//
// - polling (`until`) and assertions (`check` throws Failure)
// - the production server from dist/ on a free port with a throwaway DATA_DIR (`startServer`)
// - `wsHook`: an init script that wraps window.WebSocket so a test reads what the app receives and sends
// - `Player`: one browser context + page, with page/console error capture, screenshots and A* walking

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_JS = path.join(ROOT, 'dist', 'server', 'index.js');
export const CLIENT_HTML = path.join(ROOT, 'dist', 'client', 'index.html');
export const HEADED = process.env.E2E_HEADED === '1';
export const REAL_FONTS = process.env.E2E_REAL_FONTS === '1';

export const size = (v) => {
  const m = /^(\d+)x(\d+)$/.exec(v ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
};

export const T0 = Date.now();
export const log = (...a) => console.log(`[e2e ${((Date.now() - T0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class Failure extends Error {}
export function check(cond, msg) {
  if (!cond) throw new Failure(msg);
}

/** Polls `fn` until it returns something truthy. Conditions, not sleeps: `interval` only paces the polling. */
export async function until(label, fn, { timeout = 10_000, interval = 60 } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() - start > timeout) throw new Failure(`Timed out after ${timeout} ms waiting for ${label}`);
    await sleep(interval);
  }
}

export function requireDist() {
  if (!fs.existsSync(SERVER_JS) || !fs.existsSync(CLIENT_HTML)) {
    console.error('dist/ is missing. Run `npm run build` first, then `npm run e2e`.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------- shared game data (map, geometry)

export async function loadShared() {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    stdin: {
      contents: "export * from './shared/geometry'; export * from './shared/map'; export * from './shared/constants'; export * from './shared/cosmetics';",
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

// ---------------------------------------------------------------- server

export async function freePort() {
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

/**
 * Spawns dist/server/index.js. `env` entries are added to process.env; an `undefined` value removes the
 * variable. Resolves once /api/config answers.
 */
export async function startServer({ env: extra = {}, timeout = 15_000 } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'among-rugs-e2e-'));
  const output = [];
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
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
  const server = {
    base,
    port,
    dataDir,
    output,
    pid: proc.pid,
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
  try {
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
      { timeout, interval: 100 },
    );
  } catch (err) {
    await server.stop();
    throw err;
  }
  return server;
}

// ---------------------------------------------------------------- browser side

/** Font requests are answered with an empty stylesheet unless E2E_REAL_FONTS=1 (keeps runs offline-safe). */
export async function stubFonts(context, by = 'e2e') {
  if (REAL_FONTS) return;
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: `/* fonts stubbed by ${by} */` }),
  );
}

/** Init script: wraps window.WebSocket so the test can read what the app receives and sends. */
export function wsHook() {
  const Native = window.WebSocket;
  const S = { snap: null, snaps: 0, progress: 0, welcome: null, events: [], errors: [], chats: [], selfPos: null, teleportSeq: null, moves: 0, ws: null };
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
      S.ws = this;
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

export class Player {
  constructor(label, name, context, page, touch, shotsDir) {
    this.label = label;
    this.name = name;
    this.context = context;
    this.page = page;
    this.touch = touch;
    this.shotsDir = shotsDir;
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
      // Every HUD action button by kind (use, report, rug, sab, vent): true when it can be pressed now.
      const acts = {};
      for (const b of document.querySelectorAll('.act')) {
        const kind = /\bact--(\w+)/.exec(b.className)?.[1];
        if (kind) acts[kind] = !b.disabled && !b.hidden && b.offsetParent !== null;
      }
      return {
        view: document.getElementById('ui')?.dataset.view ?? null,
        snap: S.snap,
        pos: S.selfPos,
        moves: S.moves,
        events: S.events,
        acts,
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

  visible(sel) {
    return this.page.locator(sel).first().isVisible();
  }

  /** Server errors this page received since `since` (ms epoch). */
  serverErrors(since = 0) {
    return this.page.evaluate((t) => window.__e2e.errors.filter((e) => e.at >= t), since);
  }

  /** Sends a raw client message on the app's own WebSocket (to probe what the server refuses). */
  sendRaw(msg) {
    return this.page.evaluate((m) => {
      const ws = window.__e2e.ws;
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(m));
      return true;
    }, msg);
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

  async shot(name, { fullPage = false, dir = this.shotsDir } = {}) {
    try {
      await this.page.screenshot({ path: path.join(dir, `${name}-${this.label}.png`), fullPage });
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

export async function center(page, sel, idx = 0) {
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
