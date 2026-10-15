// "YOU GOT RUGGED" cutscene for the victim: ~2.2 s DOM overlay showing the killer's pill.

import type { EquippedCosmetics } from '../../../shared/protocol';
import { h } from './dom';
import { nameSpan } from './names';
import { bagSvg, pillSvg } from './pill';
import { createPillPreview } from './previews';

const DURATION_MS = 2300;
/** Matches the .cut.is-leaving fade-out in styles.css. */
const LEAVE_MS = 300;

export function showRuggedCutscene(
  layer: HTMLElement,
  killer: { name: string; color: number; cosmetics?: EquippedCosmetics } | null,
  victimColor: number,
): void {
  layer.querySelector('.cut')?.remove();
  // The killer's skin and name effect are what the victim saw in the world anyway (never their rug).
  const skin = killer?.cosmetics?.skin;
  const killerArt = skin
    ? h('div', { class: 'cut-killer cut-killer--pv' }, createPillPreview(110, killer!.color, { skin }, { cls: 'cut-pv', h: 130, zoom: 1.35 }).el)
    : h('div', { class: 'cut-killer', html: pillSvg(killer?.color ?? 1, { facing: 1 }) });
  const sub = h('div', { class: 'cut-sub' });
  if (killer) sub.append('by ', nameSpan(killer.name, killer.cosmetics, false, 'cut-name'), '. Finish your tasks as a ghost.');
  else sub.textContent = 'Finish your tasks as a ghost.';
  const el = h(
    'div',
    { class: 'cut', attrs: { role: 'alert', 'aria-label': 'You got rugged' } },
    h('div', { class: 'cut-flash' }),
    h(
      'div',
      { class: 'cut-stage' },
      killerArt,
      h('div', { class: 'cut-slash' }),
      h('div', { class: 'cut-victim', html: bagSvg(victimColor) }),
    ),
    h('div', { class: 'cut-title', text: 'YOU GOT RUGGED' }),
    sub,
  );
  layer.append(el);
  window.setTimeout(() => el.classList.add('is-leaving'), DURATION_MS - LEAVE_MS);
  window.setTimeout(() => el.remove(), DURATION_MS);
}

/** Fades out a running cutscene early (the round moved on to a meeting or game over). */
export function dismissRuggedCutscene(layer: HTMLElement): void {
  for (const el of layer.querySelectorAll<HTMLElement>('.cut:not(.is-leaving)')) {
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), LEAVE_MS);
  }
}
