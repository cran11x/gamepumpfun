// AMONG RUGS server: express (HTTP API + built client) and a ws WebSocketServer on /ws,
// all on one port. Game logic lives in rooms.ts / game.ts; this file is the transport edge.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { GAME_NAME } from '../shared/constants';
import type { C2S, S2C } from '../shared/protocol';
import { createApiRouter } from './api';
import { parseC2S } from './game/validate';
import { RoomManager, type Binding, type Conn } from './rooms';

const PORT = (() => {
  const n = Number(process.env.PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8787;
})();

/** Per-socket token bucket: bursts up to RATE_BURST, refilled at RATE_PER_SEC. Excess is dropped. */
const RATE_PER_SEC = 60;
const RATE_BURST = 60;
/** Sockets that keep hammering far past the limit are closed. */
const ABUSE_DROPS_PER_SEC = 240;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
/** Back-pressure: skip snapshots for a slow consumer, cut it off when it falls hopelessly behind. */
const SNAPSHOT_SKIP_BUFFER = 256 * 1024;
const TERMINATE_BUFFER = 4 * 1024 * 1024;
const MAX_PAYLOAD = 4096;

class SocketConn implements Conn {
  binding: Binding | null = null;
  lastJoinAt = -Infinity;
  lastSeen = Date.now();
  private tokens = RATE_BURST;
  private refillAt = Date.now();
  private windowStart = Date.now();
  private windowDrops = 0;
  private badMessages = 0;

  constructor(readonly ws: WebSocket) {}

  send(msg: S2C): void {
    const ws = this.ws;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > TERMINATE_BUFFER) {
      ws.terminate();
      return;
    }
    if (msg.t === 'snap' && ws.bufferedAmount > SNAPSHOT_SKIP_BUFFER) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  /** Returns false when the message must be dropped. Closes abusive sockets. */
  allow(now: number): boolean {
    this.tokens = Math.min(RATE_BURST, this.tokens + ((now - this.refillAt) / 1000) * RATE_PER_SEC);
    this.refillAt = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowDrops = 0;
    }
    if (++this.windowDrops > ABUSE_DROPS_PER_SEC) this.ws.close(1008, 'rate limit');
    return false;
  }

  /** Malformed messages: answer a few with BAD_REQUEST, then stay quiet. */
  badRequest(): void {
    if (++this.badMessages <= 20) this.send({ t: 'error', code: 'BAD_REQUEST', message: 'Malformed message' });
  }
}

function rawToString(data: RawData): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return null;
}

function main(): void {
  const manager = new RoomManager();
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (Fly, Render, nginx...) set TRUST_PROXY (e.g. "1" or "true") so req.ip is the client.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy);

  // HTTP API (wallet module). The JSON parser is idempotent with any parser the router adds itself.
  app.use('/api', express.json({ limit: '16kb' }), createApiRouter({ getRoomsInfo: () => manager.getRoomsInfo() }));
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });

  // Built client (npm run build). In dev, Vite serves the client and proxies /api and /ws here.
  const clientDir = path.resolve(process.cwd(), 'dist', 'client');
  const indexHtml = path.join(clientDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(clientDir, {
        index: 'index.html',
        setHeaders(res, filePath) {
          // Vite emits content-hashed files under /assets: cache forever. Everything else revalidates.
          if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    // SPA fallback: extensionless GETs (e.g. /?room=CODE deep links) get index.html.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api') || req.path === '/ws' || path.extname(req.path) !== '') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else {
    console.warn(`[server] ${clientDir} not found; serving API and WebSocket only (run "npm run build" for production).`);
  }

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
    const code = typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
    if (code >= 500) console.error('[http] error', err);
    res.status(code).json({ error: code >= 500 ? 'internal error' : 'bad request' });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_PAYLOAD });
  const conns = new Map<WebSocket, SocketConn>();

  wss.on('connection', (ws) => {
    const conn = new SocketConn(ws);
    conns.set(ws, conn);
    manager.connect(conn);

    ws.on('pong', () => {
      conn.lastSeen = Date.now();
    });

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      conn.lastSeen = now;
      if (!conn.allow(now)) return;
      if (isBinary) return conn.badRequest();
      let msg: C2S | null;
      try {
        const text = rawToString(data);
        msg = text === null ? null : parseC2S(JSON.parse(text));
      } catch {
        msg = null;
      }
      if (!msg) return conn.badRequest();
      try {
        manager.handleMessage(conn, msg);
      } catch (err) {
        console.error(`[ws] error handling '${msg.t}'`, err);
      }
    });

    ws.on('close', () => {
      conns.delete(ws);
      try {
        manager.disconnect(conn);
      } catch (err) {
        console.error('[ws] error on disconnect', err);
      }
    });

    ws.on('error', (err) => {
      // Oversized payloads, protocol errors, resets: ws closes the socket and 'close' does the cleanup.
      // Those are routine client misbehavior, so only unexpected errors are logged.
      const code = String((err as NodeJS.ErrnoException).code ?? '');
      if (code !== 'ECONNRESET' && !code.startsWith('WS_ERR_')) console.warn('[ws] socket error:', err.message);
    });
  });

  wss.on('error', (err) => console.error('[ws] server error', err));

  // Heartbeat: ping every 5 s; terminate sockets that haven't answered (or sent anything) for 30 s.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [ws, conn] of conns) {
      if (now - conn.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        ws.terminate();
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          /* closing */
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  manager.start();

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') console.error(`[server] port ${PORT} is already in use`);
    else console.error('[server] error', err);
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(`${GAME_NAME} server listening on http://localhost:${PORT} (WebSocket ws://localhost:${PORT}/ws)`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal}: shutting down`);
    clearInterval(heartbeat);
    manager.stop();
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'server restarting');
      } catch {
        /* ignore */
      }
    }
    wss.close();
    server.close();
    server.closeAllConnections();
    // Let pending work (e.g. debounced stat writes) finish; force out if something keeps the loop alive.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection', reason));
}

main();
