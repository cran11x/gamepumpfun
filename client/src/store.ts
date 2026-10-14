// Client-side state container fed by the network. Rendering and UI read from here.

import type { ChatMessage, ErrorCode, GameEvent, S2C, Snapshot } from '../../shared/protocol';
import type { Net } from './net';

export interface TimedSnapshot {
  snap: Snapshot;
  /** Local Date.now() at receive time. */
  recvAt: number;
}

type Listener<T> = (v: T) => void;

export class Store {
  playerId: string | null = null;
  roomCode: string | null = null;
  /** Latest snapshot (null until joined). */
  snap: Snapshot | null = null;
  /** Recent snapshots, oldest first, for interpolating remote players. */
  history: TimedSnapshot[] = [];
  chat: ChatMessage[] = [];
  lastError: { code: ErrorCode; message: string } | null = null;
  connected = false;

  private snapL = new Set<Listener<Snapshot>>();
  private chatL = new Set<Listener<ChatMessage>>();
  private eventL = new Set<Listener<GameEvent>>();
  private errorL = new Set<Listener<{ code: ErrorCode; message: string }>>();
  private phaseL = new Set<Listener<{ from: Snapshot['phase'] | null; to: Snapshot['phase'] }>>();
  private statusL = new Set<Listener<boolean>>();

  constructor(private net: Net) {
    net.on((m) => this.onMessage(m));
    net.onStatus((c) => {
      this.connected = c;
      this.statusL.forEach((l) => l(c));
    });
  }

  private onMessage(m: S2C): void {
    switch (m.t) {
      case 'welcome':
        this.playerId = m.playerId;
        this.roomCode = m.code;
        this.lastError = null;
        break;
      case 'snap': {
        const prevPhase = this.snap?.phase ?? null;
        this.snap = m;
        this.history.push({ snap: m, recvAt: Date.now() });
        if (this.history.length > 30) this.history.splice(0, this.history.length - 30);
        if (prevPhase !== m.phase) {
          if (m.phase === 'lobby' && prevPhase !== null) this.chat = this.chat.filter((c) => c.channel === 'lobby');
          this.phaseL.forEach((l) => l({ from: prevPhase, to: m.phase }));
        }
        this.snapL.forEach((l) => l(m));
        break;
      }
      case 'chat':
        this.chat.push(m);
        if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
        this.chatL.forEach((l) => l(m));
        break;
      case 'event':
        if (m.event.kind === 'kicked') this.reset();
        this.eventL.forEach((l) => l(m.event));
        break;
      case 'error':
        this.lastError = { code: m.code, message: m.message };
        if (m.code === 'REJOIN_FAILED') this.reset();
        this.errorL.forEach((l) => l({ code: m.code, message: m.message }));
        break;
      case 'pong':
        break;
    }
  }

  /** Forget the room (after leaving, being kicked, or a failed rejoin). */
  reset(): void {
    const had = this.snap !== null;
    this.playerId = null;
    this.roomCode = null;
    this.snap = null;
    this.history = [];
    this.chat = [];
    if (had) this.phaseL.forEach((l) => l({ from: null, to: 'lobby' }));
  }

  get inRoom(): boolean {
    return this.snap !== null;
  }

  onSnapshot(l: Listener<Snapshot>): () => void {
    this.snapL.add(l);
    return () => this.snapL.delete(l);
  }
  onChat(l: Listener<ChatMessage>): () => void {
    this.chatL.add(l);
    return () => this.chatL.delete(l);
  }
  onEvent(l: Listener<GameEvent>): () => void {
    this.eventL.add(l);
    return () => this.eventL.delete(l);
  }
  onError(l: Listener<{ code: ErrorCode; message: string }>): () => void {
    this.errorL.add(l);
    return () => this.errorL.delete(l);
  }
  /** Fires when snapshot.phase changes. `from` is null on the first snapshot after joining. */
  onPhase(l: Listener<{ from: Snapshot['phase'] | null; to: Snapshot['phase'] }>): () => void {
    this.phaseL.add(l);
    return () => this.phaseL.delete(l);
  }
  onStatus(l: Listener<boolean>): () => void {
    this.statusL.add(l);
    return () => this.statusL.delete(l);
  }
}
