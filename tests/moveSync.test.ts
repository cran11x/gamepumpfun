import { describe, expect, it } from 'vitest';
import { FLUSH_GAP_MS, MoveSync, SEND_INTERVAL_MS, SETTLE_RESEND_MS } from '../client/src/game/moveSync';

/** Drive MoveSync like the game's frame loop: one due() check per 60 fps frame. */
function frames(m: MoveSync, from: number, to: number, pos: () => { x: number; y: number }, moving: (t: number) => boolean) {
  const sent: { t: number; x: number; moving: boolean }[] = [];
  for (let t = from; t <= to; t += 1000 / 60) {
    const mv = m.due(t, moving(t));
    if (mv !== null) {
      const p = pos();
      m.sent(t, p.x, p.y, mv);
      sent.push({ t, x: p.x, moving: mv });
    }
  }
  return sent;
}

describe('MoveSync', () => {
  it('reports at CLIENT_SEND_HZ while moving, then the stop, then the resting position once more', () => {
    const m = new MoveSync();
    m.placed(0, 0);
    let x = 0;
    const out = frames(m, 0, 1000, () => ({ x, y: 0 }), (t) => {
      if (t < 300) x += 3;
      return t < 300;
    });
    const moving = out.filter((s) => s.moving);
    for (let i = 1; i < moving.length; i++) expect(moving[i].t - moving[i - 1].t).toBeGreaterThanOrEqual(SEND_INTERVAL_MS - 1e-6);
    const stops = out.filter((s) => !s.moving);
    expect(stops).toHaveLength(2);
    expect(stops[0].x).toBe(stops[1].x);
    expect(stops[1].t - stops[0].t).toBeGreaterThanOrEqual(SETTLE_RESEND_MS);
    expect(stops[1].t - stops[0].t).toBeLessThan(SETTLE_RESEND_MS + 40);
    expect(m.settleAt).toBe(0);
  });

  it('sends nothing while standing still at a position the server placed us at', () => {
    const m = new MoveSync();
    m.placed(500, 500);
    expect(frames(m, 0, 2000, () => ({ x: 500, y: 500 }), () => false)).toHaveLength(0);
    expect(m.flushDelay(2000, 500, 500)).toBeNull();
  });

  it('flushes the position before an action, never closer than FLUSH_GAP_MS to the previous move', () => {
    const m = new MoveSync();
    m.placed(0, 0);
    m.sent(1000, 10, 0, true);
    // Pressed 12 ms after a move, 3 px further on: wait, then flush.
    expect(m.flushDelay(1012, 13, 0)).toBe(FLUSH_GAP_MS - 12);
    // Pressed long enough after it: flush right away.
    expect(m.flushDelay(1000 + FLUSH_GAP_MS, 13, 0)).toBe(0);
    // The flush itself (a stop) is a new resting position: it gets its resend.
    m.sent(1030, 13, 0, false);
    expect(m.settleAt).toBe(1030 + SETTLE_RESEND_MS);
    // Until that resend went out the server may still hold an older point.
    expect(m.flushDelay(1050, 13, 0)).toBe(10);
    m.sent(1030 + SETTLE_RESEND_MS, 13, 0, false);
    expect(m.settleAt).toBe(0);
    expect(m.flushDelay(2000, 13, 0)).toBeNull();
  });

  it('idle() drops a pending stop and resend', () => {
    const m = new MoveSync();
    m.placed(0, 0);
    m.sent(0, 5, 0, true);
    m.idle();
    expect(m.due(1000, false)).toBeNull();
  });
});
