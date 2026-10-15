// Name effects on DOM names (lobby rows, meeting cards, chat, ejection, game over, shop). The effect
// is a CSS class (styles.css .nfx-*); the name itself always goes through textContent, and the glitch
// layers read it back from data-text (CSS attr(), rendered as plain text).

import type { EquippedCosmetics } from '../../../shared/protocol';
import { nameFxClass } from './ranked';

/**
 * Put the right name effect on `el` (whose textContent is already the name), or take it off.
 * `red`: the name shows in rug red for this viewer; red wins and no effect is applied.
 */
export function applyNameFx(el: HTMLElement, cosmetics: EquippedCosmetics | null | undefined, red: boolean): void {
  const want = nameFxClass(cosmetics, red) ?? '';
  const cur = el.dataset.nfx ?? '';
  const text = el.textContent ?? '';
  if (cur === want && (!want || el.dataset.text === text)) return;
  if (cur) el.classList.remove('nfx', cur);
  if (want) {
    el.classList.add('nfx', want);
    el.dataset.nfx = want;
    el.dataset.text = text;
  } else {
    delete el.dataset.nfx;
    delete el.dataset.text;
  }
}

/** A span holding `name` with its effect. */
export function nameSpan(name: string, cosmetics: EquippedCosmetics | null | undefined, red: boolean, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = name;
  applyNameFx(s, cosmetics, red);
  return s;
}
