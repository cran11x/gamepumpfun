// verifyCA: the official CA is pinned at the top; below it the real one hides among 4 poisoned
// look-alikes (same first/last 4 characters, middle altered by casing swaps and swapped
// neighbours). A wrong pick flashes red and the list regenerates and reshuffles.

import { button, el, pick, randInt, shuffle, type MinigameCtx, type MinigameDef } from './kit';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const FAKES = 4;
const EDGE = 4;
const RESHUFFLE_MS = 480;

const WRONG_LINES = [
  'Poisoned CA! The drainer says thanks.',
  'Fake CA. That one is a honeypot, ser.',
  'Wrong one. Check the middle characters.',
  'Address poisoning got you. Look closer.',
];

/** A random 44-character base58 address ending in "pump", like a fresh pump.fun mint. */
export function randomPumpCA(): string {
  let s = '';
  for (let i = 0; i < 40; i++) s += B58[randInt(0, B58.length - 1)];
  return `${s}pump`;
}

function officialCA(configured: string | null): string {
  const ca = configured?.trim() ?? '';
  // Needs a middle long enough to poison; the server only passes valid base58 mints anyway.
  return ca.length >= EDGE * 2 + 8 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(ca) ? ca : randomPumpCA();
}

/** Alter 2-3 characters strictly inside the middle (never the first/last 4). */
function poison(ca: string): string {
  const c = Array.from(ca);
  const lo = EDGE;
  const hi = c.length - EDGE; // exclusive
  if (hi - lo < 2) return ca;
  const edits = randInt(2, 3);
  let done = 0;
  for (let guard = 0; done < edits && guard < 200; guard++) {
    if (Math.random() < 0.55) {
      const i = randInt(lo, hi - 1);
      const ch = c[i];
      const swapped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
      if (swapped !== ch) {
        c[i] = swapped;
        done++;
      }
    } else {
      const i = randInt(lo, hi - 2);
      if (c[i] !== c[i + 1]) {
        const t = c[i];
        c[i] = c[i + 1];
        c[i + 1] = t;
        done++;
      }
    }
  }
  return c.join('');
}

function makeFakes(real: string): string[] | null {
  const out = new Set<string>();
  for (let i = 0; i < 80 && out.size < FAKES; i++) {
    const f = poison(real);
    if (f !== real) out.add(f);
  }
  return out.size === FAKES ? Array.from(out) : null;
}

/**
 * First/last 4 dimmed, the middle in groups of 4 so rows are easy to compare. On narrow
 * screens a break after the 6th group wraps the address onto two equal-looking lines.
 */
function caNode(ca: string): HTMLElement {
  const wrap = el('span', 'tk-ca-addr');
  const chunks: HTMLElement[] = [el('span', 'tk-ca-chunk is-edge', ca.slice(0, EDGE))];
  const mid = ca.slice(EDGE, ca.length - EDGE);
  for (let i = 0; i < mid.length; i += 4) chunks.push(el('span', 'tk-ca-chunk', mid.slice(i, i + 4)));
  chunks.push(el('span', 'tk-ca-chunk is-edge', ca.slice(-EDGE)));
  chunks.forEach((c, i) => {
    wrap.append(c);
    if (i === 5 && i < chunks.length - 1) wrap.append(el('span', 'tk-ca-br'));
  });
  return wrap;
}

export const verifyCA: MinigameDef = {
  hint: 'Tap the CA that matches the official one. One wrong char = drained.',
  mount(ctx: MinigameCtx) {
    const { scope, stage } = ctx;
    let real = officialCA(ctx.host.contractAddress);
    let fakes = makeFakes(real);
    if (!fakes) {
      // A configured CA with an unpoisonable middle (practically impossible); use a random one.
      real = randomPumpCA();
      fakes = makeFakes(real) ?? [];
    }

    const wrap = el('div', 'tk-ca');
    const ref = el('div', 'tk-ca-ref');
    const refLabel = el('div', 'tk-ca-ref-label');
    refLabel.append(el('span', 'tk-ca-pin', 'OFFICIAL CA'), el('span', 'tk-ca-src', 'pinned by dev in TG'));
    ref.append(refLabel, caNode(real));
    const list = el('div', 'tk-ca-list');
    list.setAttribute('role', 'list');
    wrap.append(ref, list);
    stage.append(wrap);

    const isReal = new Map<HTMLButtonElement, boolean>();
    let locked = false;

    const render = (): void => {
      list.replaceChildren();
      isReal.clear();
      const options = shuffle([{ ca: real, ok: true }, ...fakes!.map((ca) => ({ ca, ok: false }))]);
      options.forEach((o, i) => {
        const b = button('tk-ca-opt');
        b.setAttribute('role', 'listitem');
        b.style.setProperty('--i', String(i));
        b.append(el('span', 'tk-ca-idx', String.fromCharCode(65 + i)), caNode(o.ca));
        isReal.set(b, o.ok);
        list.append(b);
      });
    };
    render();

    scope.on<MouseEvent>(list, 'click', (e) => {
      if (locked || ctx.won) return;
      const b = (e.target as Element | null)?.closest('.tk-ca-opt');
      if (!(b instanceof HTMLButtonElement) || !isReal.has(b)) return;
      if (isReal.get(b)) {
        b.classList.add('is-good');
        ctx.win('CA VERIFIED');
        return;
      }
      locked = true;
      b.classList.add('is-bad');
      list.classList.add('is-locked');
      ctx.fail(pick(WRONG_LINES), b);
      scope.timeout(() => {
        fakes = makeFakes(real) ?? fakes;
        render();
        list.classList.remove('is-locked');
        locked = false;
      }, RESHUFFLE_MS);
    });
  },
};
