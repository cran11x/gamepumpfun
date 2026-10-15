// WebSocket connection to the game server with typed messages, clock sync and auto-rejoin.

import type { C2S, S2C } from '../../shared/protocol';

type Handler = (msg: S2C) => void;

const SESSION_KEY = 'amongrugs.session';

/** Reconnect backoff after an ordinary drop: 500 ms, doubling up to 8 s. */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8000;
/** Slow retries while the server refuses this network (per-IP socket cap): 15 s, 30 s, then every 60 s. */
export const REFUSED_RETRY_MS = [15_000, 30_000, 60_000] as const;
const REFUSAL_FALLBACK_MSG = 'Too many connections from your network';

export interface SavedSession {
  code: string;
  playerId: string;
  sessionKey: string;
}

/** The server is turning this network away (too many sockets from one IP). Cleared by the first accepted connection. */
export interface Refusal {
  message: string;
  /** Refused connections in a row. */
  attempts: number;
  /** Date.now() of the next automatic retry (0 until the refused socket has closed). */
  retryAt: number;
}

/** The per-IP socket cap's refusal, sent just before the server closes the socket with 1008. */
export function isConnectionRefusal(msg: { t: string; code?: string; message?: string }): boolean {
  return msg.t === 'error' && msg.code === 'RATE_LIMITED' && /too many connections/i.test(msg.message ?? '');
}

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<(connected: boolean) => void>();
  private queue: C2S[] = [];
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private wantOpen = false;
  /** The server has answered on the current socket (so it accepted us). */
  private accepted = false;
  /** The current socket got the connection-cap refusal. */
  private refusedMsg: string | null = null;
  /** A rejoin went out on the current socket and is not answered yet. */
  private rejoinPending = false;
  /** Estimated (serverNow - Date.now()) in ms. */
  serverOffset = 0;
  /** Smoothed round-trip time in ms. */
  rtt = 0;
  /** The socket is open (messages can be sent). Status listeners hear `true` only once the server answers. */
  connected = false;
  /** Set while the server keeps refusing this network; the UI shows it instead of "connecting". */
  refusal: Refusal | null = null;

  connect(): void {
    this.wantOpen = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    this.accepted = false;
    this.refusedMsg = null;
    this.rejoinPending = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      const saved = Net.loadSession();
      if (saved) {
        ws.send(JSON.stringify({ t: 'rejoin', ...saved } satisfies C2S));
        this.rejoinPending = true;
      }
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      this.ping();
      if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 2000);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: S2C;
      try {
        msg = JSON.parse(String(ev.data)) as S2C;
      } catch {
        return;
      }
      if (msg.t === 'error' && isConnectionRefusal(msg)) {
        // The server closes this socket next; onclose schedules a slow retry. A pending rejoin was never
        // looked at, so the saved session stays for the next attempt.
        this.refusedMsg = msg.message;
        this.rejoinPending = false;
        this.handlers.forEach((h) => h(msg));
        return;
      }
      if (!this.accepted) {
        // First answer on this socket: the server took us. Only now reset the backoff and report "connected",
        // so a socket that opens and is refused at once never looks like a working connection.
        this.accepted = true;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.refusal = null;
        this.statusHandlers.forEach((h) => h(true));
      }
      if (msg.t === 'pong') {
        const now = Date.now();
        const rtt = now - msg.ts;
        this.rtt = this.rtt === 0 ? rtt : this.rtt * 0.8 + rtt * 0.2;
        const offset = msg.serverNow + rtt / 2 - now;
        this.serverOffset = this.serverOffset === 0 ? offset : this.serverOffset * 0.8 + offset * 0.2;
      } else if (msg.t === 'welcome') {
        this.rejoinPending = false;
        Net.saveSession({ code: msg.code, playerId: msg.playerId, sessionKey: msg.sessionKey });
      } else if (msg.t === 'error') {
        // The rejoin is the first message on the socket, so the first error before `welcome` answers it.
        // Whatever its code, the seat is gone: drop the session and report it as REJOIN_FAILED, which sends
        // the store and the UI back home instead of retrying a dead session on every reconnect.
        if (this.rejoinPending && msg.code !== 'REJOIN_FAILED') msg = { ...msg, code: 'REJOIN_FAILED' };
        this.rejoinPending = false;
        if (msg.code === 'REJOIN_FAILED') Net.clearSession();
      } else if (msg.t === 'event' && msg.event.kind === 'kicked') {
        Net.clearSession();
      }
      this.handlers.forEach((h) => h(msg));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.ws = null;
      this.rejoinPending = false;
      if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
      this.pingTimer = null;
      const refused = this.refusedMsg !== null || (ev?.code === 1008 && /too many connections/i.test(ev.reason ?? ''));
      let delay = this.reconnectDelay;
      if (refused) {
        const attempts = (this.refusal?.attempts ?? 0) + 1;
        delay = REFUSED_RETRY_MS[Math.min(attempts, REFUSED_RETRY_MS.length) - 1];
        this.refusal = { message: this.refusedMsg ?? REFUSAL_FALLBACK_MSG, attempts, retryAt: Date.now() + delay };
      } else {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      }
      if (this.wantOpen) {
        // A refused retry replaces a quicker one already queued (e.g. after a manual connect()).
        if (this.reconnectTimer !== null && refused) {
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.reconnectTimer === null) {
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
          }, delay);
        }
      }
      this.statusHandlers.forEach((h) => h(false));
    };
  }

  send(msg: C2S): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (msg.t !== 'move' && msg.t !== 'ping') this.queue.push(msg);
  }

  /** Subscribe to every server message. Returns an unsubscribe function. */
  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: (connected: boolean) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** Leave the current room and forget the saved session. */
  leave(): void {
    this.send({ t: 'leave' });
    Net.clearSession();
  }

  /** Server clock estimate in ms. */
  serverNow(): number {
    return Date.now() + this.serverOffset;
  }

  private ping(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'ping', ts: Date.now() } satisfies C2S));
  }

  static loadSession(): SavedSession | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as SavedSession) : null;
    } catch {
      return null;
    }
  }

  static saveSession(s: SavedSession): void {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable */
    }
  }

  static clearSession(): void {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* storage unavailable */
    }
  }
}
