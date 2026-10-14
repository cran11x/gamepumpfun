// Bookkeeping for move reports: when the game should tell the server where we are.
// 20 Hz while moving, the stop (plus one resend), and a flush right before range-checked actions.

import { CLIENT_SEND_HZ } from '../../../shared/constants';

export const SEND_INTERVAL_MS = 1000 / CLIENT_SEND_HZ;
/**
 * Minimum spacing between the previous move and the position flush sent ahead of an action.
 * The server silently drops moves that arrive less than 25 ms apart.
 */
export const FLUSH_GAP_MS = 30;
/** Resend a new resting position once this long after reporting it: jitter can get it rate-limited. */
export const SETTLE_RESEND_MS = 100;

export class MoveSync {
  lastSendAt = -Infinity;
  /** The `moving` flag of the last move sent. */
  sentMoving = false;
  /** Position in the last move sent: what the server range-checks actions against. */
  sentX = NaN;
  sentY = NaN;
  /** When to resend the resting position (0: nothing pending). */
  settleAt = 0;

  /** The server put us at (x, y) itself (spawn, teleport, snap-back): nothing to report until we move. */
  placed(x: number, y: number): void {
    this.sentX = x;
    this.sentY = y;
    this.sentMoving = false;
    this.settleAt = 0;
  }

  /** Out of play: forget any pending stop or resend. */
  idle(): void {
    this.sentMoving = false;
    this.settleAt = 0;
  }

  /** Record a move just sent. A new resting position (a stop, or a flush) gets one resend. */
  sent(now: number, x: number, y: number, moving: boolean): void {
    const changed = this.sentMoving || !(Math.hypot(x - this.sentX, y - this.sentY) < 0.5);
    this.lastSendAt = now;
    this.sentMoving = moving;
    this.sentX = x;
    this.sentY = y;
    this.settleAt = !moving && changed ? now + SETTLE_RESEND_MS : 0;
  }

  /** The regular send slot: the `moving` flag to send now, or null for nothing. */
  due(now: number, moving: boolean): boolean | null {
    if (now - this.lastSendAt < SEND_INTERVAL_MS) return null;
    if (moving) return true;
    if (this.sentMoving) return false; // movement stopped: report it
    if (this.settleAt && now >= this.settleAt) return false; // ...and once more
    return null;
  }

  /**
   * Before an action the server range-checks: null when the server already has (x, y), else how
   * long to wait (ms, 0 = right away) before flushing the position so it isn't rate-limited.
   */
  flushDelay(now: number, x: number, y: number): number | null {
    if (Math.hypot(x - this.sentX, y - this.sentY) < 0.5 && this.settleAt === 0) return null;
    return Math.max(0, FLUSH_GAP_MS - (now - this.lastSendAt));
  }
}
