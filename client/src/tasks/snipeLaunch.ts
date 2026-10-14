// snipeLaunch: a marker ping-pongs along the launch bar; tap SNIPE (or anywhere on the bar, or
// Space/Enter) while it is inside the green zone. Two hits; the second zone is smaller and the
// marker faster. A miss locks input briefly so spamming doesn't work.

import { button, el, floatText, isSpaceKey, isTypingTarget, pick, rand, restartClass, type MinigameCtx, type MinigameDef } from './kit';

const HITS_NEEDED = 2;
const MISS_LOCK_MS = 450;
const HIT_FREEZE_MS = 300;
/** Small forgiveness on both zone edges (fraction of the bar). */
const SLOP = 0.012;

const MISS_LINES = [
  'Missed! Bundlers front-ran you.',
  'Too early. Dev is still deploying.',
  'Too late. You bought the top.',
  'Missed. The snipers ate first.',
];

export const snipeLaunch: MinigameDef = {
  hint: 'Tap SNIPE while the marker is in the green zone. 2 hits.',
  mount(ctx: MinigameCtx) {
    const { scope, stage } = ctx;

    const wrap = el('div', 'tk-snipe');
    const top = el('div', 'tk-snipe-top');
    const live = el('span', 'tk-chip tk-chip--live');
    live.append(el('span', 'tk-live-dot'), document.createTextNode('LIVE LAUNCH'));
    const mcap = el('span', 'tk-snipe-mcap', 'MC $4.2K');
    const hitsEl = el('span', 'tk-snipe-hits');
    const dots = Array.from({ length: HITS_NEEDED }, () => el('span', 'tk-snipe-hit'));
    hitsEl.append(...dots);
    top.append(live, mcap, hitsEl);

    const track = el('div', 'tk-snipe-track');
    const zone = el('div', 'tk-snipe-zone');
    zone.append(el('span', 'tk-snipe-zone-label', 'SNIPE'));
    const marker = el('div', 'tk-snipe-marker');
    marker.append(el('span', 'tk-snipe-marker-head'));
    track.append(zone, marker);
    const scale = el('div', 'tk-snipe-scale');
    scale.append(el('span', '', 'DEV DEPLOYS'), el('span', '', 'BUNDLERS'), el('span', '', 'TOP BUYERS'));

    const btn = button('tk-btn tk-btn--go tk-btn--big tk-snipe-btn', 'SNIPE');
    wrap.append(top, track, scale, btn);
    stage.append(wrap);

    let pos = rand(0, 0.15);
    let dir = 1;
    let speed = rand(1.05, 1.2); // bar lengths per second
    let zoneL = 0;
    let zoneW = 0.17;
    let hits = 0;
    let lockUntil = 0;
    let frozenUntil = 0;
    let mc = 4200;

    const placeZone = (): void => {
      zoneW = hits === 0 ? 0.17 : 0.13;
      for (let i = 0; i < 12; i++) {
        zoneL = rand(0.08, 0.92 - zoneW);
        // Don't put it right under the marker: the player should have to time it.
        if (Math.abs(zoneL + zoneW / 2 - pos) > 0.22) break;
      }
      zone.style.left = `${zoneL * 100}%`;
      zone.style.width = `${zoneW * 100}%`;
      restartClass(zone, 'is-new');
    };
    placeZone();

    scope.loop((dt, now) => {
      if (now >= frozenUntil && !ctx.won) {
        pos += dir * speed * dt;
        if (pos >= 1) {
          pos = 2 - pos;
          dir = -1;
        } else if (pos <= 0) {
          pos = -pos;
          dir = 1;
        }
        mc += dt * rand(400, 1800);
        mcap.textContent = `MC $${(mc / 1000).toFixed(1)}K`;
      }
      marker.style.left = `${pos * 100}%`;
      const inZone = pos >= zoneL - SLOP && pos <= zoneL + zoneW + SLOP;
      marker.classList.toggle('is-in', inZone);
    });

    const snipe = (): void => {
      const now = performance.now();
      if (ctx.won || now < lockUntil || now < frozenUntil) return;
      const inZone = pos >= zoneL - SLOP && pos <= zoneL + zoneW + SLOP;
      if (inZone) {
        hits++;
        dots[hits - 1].classList.add('is-on');
        restartClass(zone, 'is-hit');
        floatText(scope, track, hits >= HITS_NEEDED ? 'SNIPED!' : '+1 SNIPED', pos * 100, -10, 'is-good');
        if (hits >= HITS_NEEDED) {
          ctx.win('SNIPED x2');
          return;
        }
        ctx.click();
        ctx.flash('1/2 sniped. One more bag!', 'good');
        frozenUntil = now + HIT_FREEZE_MS;
        speed *= 1.3;
        scope.timeout(placeZone, HIT_FREEZE_MS);
      } else {
        lockUntil = now + MISS_LOCK_MS;
        restartClass(marker, 'is-miss');
        floatText(scope, track, 'MISS', pos * 100, -10, 'is-bad');
        ctx.fail(pick(MISS_LINES), track);
      }
    };

    // pointerdown (not click) so the timing is exactly when the finger lands.
    scope.on<PointerEvent>(btn, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      restartClass(btn, 'is-press');
      snipe();
    });
    scope.on<PointerEvent>(track, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      snipe();
    });
    scope.on<KeyboardEvent>(window, 'keydown', (e) => {
      if (e.repeat || isTypingTarget(e.target)) return;
      if (isSpaceKey(e) || e.key === 'Enter') {
        e.preventDefault();
        restartClass(btn, 'is-press');
        snipe();
      }
    });
  },
};
