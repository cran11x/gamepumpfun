// fixFud: five breaker switches start in random states; flip them all ON (green). Every switch
// that goes on clears some of the FUD fog drifting behind the panel and drops the FUD meter.

import { button, el, pick, rand, randInt, restartClass, shuffle, type MinigameCtx, type MinigameDef } from './kit';

const SWITCHES = ['MODS', 'FILTER', 'ROADMAP', 'DEV CHAT', 'HOPIUM'];
const FUD_WORDS = ["it's over", 'dev sold', 'rug incoming', 'chart is dead', 'ngmi', 'sell now', 'exit liquidity', 'cabal dumping', 'paper hands', 'zero by friday', 'devs asleep', 'top is in'];
const ON_LINES = ['FUD muted.', 'Hopium restored.', 'Mods are back.', 'Copium flowing.'];
const OFF_LINES = ['Why would you turn that off?', 'Wrong way, ser.', 'FUD is creeping back…'];

export const fixFud: MinigameDef = {
  hint: 'Flip every switch ON (green) to kill the FUD.',
  mount(ctx: MinigameCtx) {
    const { scope, stage } = ctx;

    // Random start with at least 2 switches off.
    const states = SWITCHES.map(() => Math.random() < 0.4);
    const offIdx = shuffle(SWITCHES.map((_, i) => i)).slice(0, randInt(2, 4));
    for (const i of offIdx) states[i] = false;

    const wrap = el('div', 'tk-fud');
    const fog = el('div', 'tk-fud-fog');
    const words = shuffle(FUD_WORDS).slice(0, 10).map((w, i) => {
      const s = el('span', 'tk-fud-word', w);
      s.style.left = `${rand(2, 78)}%`;
      s.style.top = `${rand(4, 88)}%`;
      s.style.setProperty('--r', `${rand(-12, 12).toFixed(1)}deg`);
      s.style.setProperty('--d', `${rand(0, 3).toFixed(2)}s`);
      s.style.fontSize = `${Math.round(rand(11, 19))}px`;
      s.dataset.rank = String(i);
      fog.append(s);
      return s;
    });

    const meter = el('div', 'tk-fud-meter');
    const meterTop = el('div', 'tk-fud-meter-top');
    const meterPct = el('span', 'tk-fud-meter-pct');
    meterTop.append(el('span', 'tk-fud-meter-label', 'FUD LEVEL'), meterPct);
    const meterBar = el('div', 'tk-fud-meter-bar');
    const meterFill = el('span', 'tk-fud-meter-fill');
    meterBar.append(meterFill);
    meter.append(meterTop, meterBar);

    const panel = el('div', 'tk-fud-panel');
    const toggles = SWITCHES.map((label, i) => {
      const cell = el('div', 'tk-fud-cell');
      const sw = button('tk-sw');
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', label);
      sw.append(el('span', 'tk-sw-on', 'ON'), el('span', 'tk-sw-knob'), el('span', 'tk-sw-off', 'OFF'));
      cell.append(el('span', 'tk-sw-led'), sw, el('span', 'tk-sw-label', label));
      panel.append(cell);
      return { cell, sw, i };
    });

    wrap.append(fog, meter, panel);
    stage.append(wrap);

    const render = (): void => {
      const on = states.filter(Boolean).length;
      const fud = 1 - on / SWITCHES.length;
      meterFill.style.transform = `scaleX(${Math.max(0.02, fud)})`;
      meterPct.textContent = `${Math.round(fud * 100)}%`;
      wrap.style.setProperty('--fud', fud.toFixed(2));
      const visibleWords = Math.round(fud * words.length);
      words.forEach((w, k) => w.classList.toggle('is-gone', k >= visibleWords));
      for (const t of toggles) {
        const v = states[t.i];
        t.sw.setAttribute('aria-checked', String(v));
        t.cell.classList.toggle('is-on', v);
      }
    };
    render();

    scope.on<MouseEvent>(panel, 'click', (e) => {
      if (ctx.won) return;
      const sw = (e.target as Element | null)?.closest('.tk-sw');
      const t = toggles.find((x) => x.sw === sw);
      if (!t) return;
      states[t.i] = !states[t.i];
      restartClass(t.cell, 'is-flip');
      render();
      if (states.every(Boolean)) {
        ctx.win('FUD KILLED');
        return;
      }
      ctx.click();
      if (states[t.i]) ctx.flash(pick(ON_LINES), 'good', 800);
      else ctx.flash(pick(OFF_LINES), 'bad', 900);
    });
  },
};
