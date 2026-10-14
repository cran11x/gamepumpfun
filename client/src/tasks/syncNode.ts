// syncNode: nothing to do but wait. The RPC node catches up to the chain tip over ~5.5 s while
// the panel stays open (slot counter, progress bar, blinking rack, log lines), then completes
// on its own. Closing the panel early simply abandons the sync.

import { el, fmtInt, pick, randInt, rand, type MinigameCtx, type MinigameDef } from './kit';

const DURATION_MS = 5500;

interface LogStep {
  at: number;
  text: string;
}

export const syncNode: MinigameDef = {
  hint: 'Stand still. The node is catching up to the chain tip…',
  mount(ctx: MinigameCtx) {
    const { scope, stage } = ctx;

    const tip0 = 287_400_000 + randInt(0, 99_999);
    const behind0 = randInt(1100, 1650);
    const start = tip0 - behind0;

    const steps: LogStep[] = [
      { at: 0, text: 'connecting to gossip…' },
      { at: 0.14, text: `found ${randInt(28, 64)} peers` },
      { at: 0.3, text: 'downloading snapshot…' },
      { at: 0.46, text: pick(['skipping 3 rugged slots…', 'filtering 69 spam txs…', 'validator said gm', 'ignoring a memecoin airdrop…']) },
      { at: 0.62, text: 'replaying shreds…' },
      { at: 0.78, text: 'verifying bank hash…' },
      { at: 0.9, text: 'catching up to tip…' },
    ];

    const wrap = el('div', 'tk-sync');
    const rack = el('div', 'tk-sync-rack');
    for (let r = 0; r < 4; r++) {
      const unit = el('div', 'tk-sync-unit');
      for (let i = 0; i < 6; i++) {
        const led = el('span', 'tk-led');
        led.style.setProperty('--d', `${rand(0, 1.2).toFixed(2)}s`);
        led.style.setProperty('--p', `${rand(0.35, 0.9).toFixed(2)}s`);
        unit.append(led);
      }
      unit.append(el('span', 'tk-sync-vent'));
      rack.append(unit);
    }

    const info = el('div', 'tk-sync-info');
    const label = el('div', 'tk-sync-label', 'SYNCING SLOT');
    const slotEl = el('div', 'tk-sync-slot', `${fmtInt(start)}…`);
    const bar = el('div', 'tk-sync-bar');
    const fill = el('span', 'tk-sync-fill');
    const pct = el('span', 'tk-sync-pct', '0%');
    bar.append(fill, pct);
    const meta = el('div', 'tk-sync-meta');
    const behindEl = el('span', '', `behind tip: ${fmtInt(behind0)} slots`);
    meta.append(behindEl, el('span', '', `mainnet · ${randInt(380, 460)} ms/slot`));
    const log = el('div', 'tk-sync-log');
    log.setAttribute('aria-live', 'polite');
    info.append(label, slotEl, bar, meta, log);
    wrap.append(rack, info);
    stage.append(wrap);

    let nextStep = 0;
    const addLog = (text: string, cls = ''): void => {
      const line = el('div', `tk-sync-line${cls ? ` ${cls}` : ''}`, `> ${text}`);
      log.append(line);
      while (log.childElementCount > 4) log.firstElementChild?.remove();
    };

    const began = performance.now();
    scope.loop(() => {
      const elapsed = performance.now() - began;
      const p = Math.min(1, elapsed / DURATION_MS);
      while (nextStep < steps.length && p >= steps[nextStep].at) addLog(steps[nextStep++].text);
      // The tip keeps moving (~2.5 slots/s); we catch up a bit faster than linear near the end.
      const tip = tip0 + Math.floor((elapsed / 1000) * 2.5);
      const eased = 1 - Math.pow(1 - p, 1.35);
      const slot = Math.min(tip, Math.floor(start + (tip - start) * eased));
      slotEl.textContent = `${fmtInt(slot)}${p < 1 ? '…' : ''}`;
      behindEl.textContent = `behind tip: ${fmtInt(Math.max(0, tip - slot))} slots`;
      fill.style.width = `${(p * 100).toFixed(2)}%`;
      pct.textContent = `${Math.floor(p * 100)}%`;
      if (p >= 1) {
        addLog('synced ✓ node is healthy', 'is-good');
        label.textContent = 'SYNCED AT SLOT';
        wrap.classList.add('is-done');
        ctx.win('NODE SYNCED');
        return false;
      }
      return true;
    });
  },
};
