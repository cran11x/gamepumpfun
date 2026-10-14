// WebSocket connection to the game server with typed messages, clock sync and auto-rejoin.

import type { C2S, S2C } from '../../shared/protocol';

type Handler = (msg: S2C) => void;

const SESSION_KEY = 'amongrugs.session';

export interface SavedSession {
  code: string;
  playerId: string;
  sessionKey: string;
}

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<(connected: boolean) => void>();
  private queue: C2S[] = [];
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 500;
  private wantOpen = false;
  /** Estimated (serverNow - Date.now()) in ms. */
  serverOffset = 0;
  /** Smoothed round-trip time in ms. */
  rtt = 0;
  connected = false;

  connect(): void {
    this.wantOpen = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 500;
      this.statusHandlers.forEach((h) => h(true));
      const saved = Net.loadSession();
      if (saved) ws.send(JSON.stringify({ t: 'rejoin', ...saved } satisfies C2S));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), 2000);
    };
    ws.onmessage = (ev) => {
      let msg: S2C;
      try {
        msg = JSON.parse(String(ev.data)) as S2C;
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        const now = Date.now();
        const rtt = now - msg.ts;
        this.rtt = this.rtt === 0 ? rtt : this.rtt * 0.8 + rtt * 0.2;
        const offset = msg.serverNow + rtt / 2 - now;
        this.serverOffset = this.serverOffset === 0 ? offset : this.serverOffset * 0.8 + offset * 0.2;
      } else if (msg.t === 'welcome') {
        Net.saveSession({ code: msg.code, playerId: msg.playerId, sessionKey: msg.sessionKey });
      } else if (msg.t === 'error' && msg.code === 'REJOIN_FAILED') {
        Net.clearSession();
      } else if (msg.t === 'event' && msg.event.kind === 'kicked') {
        Net.clearSession();
      }
      this.handlers.forEach((h) => h(msg));
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.statusHandlers.forEach((h) => h(false));
      if (this.wantOpen && this.reconnectTimer === null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
      }
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
