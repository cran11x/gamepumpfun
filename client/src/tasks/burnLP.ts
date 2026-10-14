// burnLP: drag 3 LP tokens into the furnace. A token dropped outside the furnace mouth slides
// back home; a token dropped in shrinks into the flames and the furnace flares.

import { el, floatText, normTicker, onDrag, pick, rand, restartClass, shuffle, type MinigameCtx, type MinigameDef } from './kit';

const TOKENS = 3;
/** Extra px around the furnace mouth that still counts as "in". */
const MOUTH_SLOP = 22;

const BURN_LINES = ['Dev can\'t pull this one.', 'LP gone. Rug-proof-ish.', 'Liquidity locked forever.', 'Burn baby burn.'];

export const burnLP: MinigameDef = {
  hint: 'Drag all 3 LP tokens into the furnace.',
  mount(ctx: MinigameCtx) {
    const { scope, stage, host } = ctx;
    const ticker = normTicker(host.ticker);

    const wrap = el('div', 'tk-burn');
    const count = el('div', 'tk-burn-count', `0/${TOKENS} BURNED`);

    const furnace = el('div', 'tk-furnace');
    const label = el('div', 'tk-furnace-label', 'LP INCINERATOR 3000');
    const mouth = el('div', 'tk-furnace-mouth');
    const flames = el('div', 'tk-flames');
    for (let i = 0; i < 6; i++) {
      const f = el('span', 'tk-flame');
      f.style.setProperty('--i', String(i));
      f.style.setProperty('--x', `${8 + i * 15 + rand(-3, 3)}%`);
      f.style.setProperty('--s', rand(0.75, 1.15).toFixed(2));
      flames.append(f);
    }
    mouth.append(el('span', 'tk-furnace-glow'), flames, el('span', 'tk-furnace-grate'));
    const base = el('div', 'tk-furnace-base');
    base.append(el('span', 'tk-furnace-gauge'), el('span', 'tk-furnace-gauge'), el('span', 'tk-furnace-gauge'));
    furnace.append(label, mouth, base);
    wrap.append(count, furnace);
    stage.append(wrap);

    // Homes: one per vertical band, random x, in the left half.
    const bands = shuffle([0.22, 0.5, 0.78]);
    let burned = 0;

    const overMouth = (x: number, y: number): boolean => {
      const r = mouth.getBoundingClientRect();
      return x >= r.left - MOUTH_SLOP && x <= r.right + MOUTH_SLOP && y >= r.top - MOUTH_SLOP && y <= r.bottom + MOUTH_SLOP;
    };

    for (let i = 0; i < TOKENS; i++) {
      const token = el('div', 'tk-lp');
      token.setAttribute('role', 'button');
      token.setAttribute('aria-label', 'LP token');
      token.style.left = `${rand(12, 30)}%`;
      token.style.top = `${bands[i] * 100 + rand(-4, 4)}%`;
      token.style.setProperty('--rot', `${Math.round(rand(-14, 14))}deg`);
      token.append(el('span', 'tk-lp-mark', 'LP'), el('span', 'tk-lp-pair', `SOL/${ticker.slice(1, 6)}`));
      wrap.append(token);

      let sx = 0;
      let sy = 0;
      let curDx = 0;
      let curDy = 0;
      let done = false;
      const place = (dx: number, dy: number, scale = 1): void => {
        curDx = dx;
        curDy = dy;
        token.style.setProperty('--dx', `${dx}px`);
        token.style.setProperty('--dy', `${dy}px`);
        token.style.setProperty('--sc', String(scale));
      };

      onDrag(scope, token, {
        start(e) {
          if (done || ctx.won) return false;
          sx = e.clientX;
          sy = e.clientY;
          token.classList.add('is-drag');
          wrap.classList.add('is-dragging');
          place(0, 0, 1.1);
        },
        move(e) {
          place(e.clientX - sx, e.clientY - sy, 1.1);
          furnace.classList.toggle('is-hot', overMouth(e.clientX, e.clientY));
        },
        end(e, cancelled) {
          token.classList.remove('is-drag');
          wrap.classList.remove('is-dragging');
          furnace.classList.remove('is-hot');
          if (!cancelled && overMouth(e.clientX, e.clientY)) {
            done = true;
            burned++;
            // Fly from where it was dropped into the middle of the mouth, shrinking.
            const tr = token.getBoundingClientRect();
            const mr = mouth.getBoundingClientRect();
            const dx = curDx + (mr.left + mr.width / 2 - (tr.left + tr.width / 2));
            const dy = curDy + (mr.top + mr.height * 0.55 - (tr.top + tr.height / 2));
            token.classList.add('is-burning');
            place(dx, dy, 0.2);
            restartClass(furnace, 'is-flare');
            const wr = wrap.getBoundingClientRect();
            if (wr.width > 0 && wr.height > 0) {
              floatText(scope, wrap, '-LP 🔥', ((mr.left + mr.width / 2 - wr.left) / wr.width) * 100, ((mr.top - wr.top) / wr.height) * 100, 'is-hot');
            }
            scope.timeout(() => token.classList.add('is-gone'), 380);
            count.textContent = `${burned}/${TOKENS} BURNED`;
            restartClass(count, 'is-bump');
            if (burned >= TOKENS) {
              ctx.win('LP BURNED');
            } else {
              ctx.click();
              ctx.flash(`${burned}/${TOKENS} burned. ${pick(BURN_LINES)}`, 'good');
            }
          } else {
            place(0, 0, 1);
          }
        },
      });
    }
  },
};
