// "YOU GOT RUGGED" cutscene for the victim: ~2.2 s DOM overlay showing the killer's pill.

import { h } from './dom';
import { bagSvg, pillSvg } from './pill';

const DURATION_MS = 2300;
/** Matches the .cut.is-leaving fade-out in styles.css. */
const LEAVE_MS = 300;

export function showRuggedCutscene(layer: HTMLElement, killer: { name: string; color: number } | null, victimColor: number): void {
  layer.querySelector('.cut')?.remove();
  const el = h(
    'div',
    { class: 'cut', attrs: { role: 'alert', 'aria-label': 'You got rugged' } },
    h('div', { class: 'cut-flash' }),
    h(
      'div',
      { class: 'cut-stage' },
      h('div', { class: 'cut-killer', html: pillSvg(killer?.color ?? 1, { facing: 1 }) }),
      h('div', { class: 'cut-slash' }),
      h('div', { class: 'cut-victim', html: bagSvg(victimColor) }),
    ),
    h('div', { class: 'cut-title', text: 'YOU GOT RUGGED' }),
    h('div', { class: 'cut-sub', text: killer ? `by ${killer.name}. Finish your tasks as a ghost.` : 'Finish your tasks as a ghost.' }),
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
