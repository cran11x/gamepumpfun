// Telling "went into a bridge" apart from "walked out of view" for a holder's snapshot.
//
// The server never sends a vented rugger to holders, but its interest management also drops anyone
// who leaves the viewer's line of sight or vision reach. Both look like a player vanishing, so a
// vanish only counts as a bridge when the server would still have been sending that player.

import type { Vec } from '../../../shared/geometry';

/**
 * True when a player last seen at `last` (and at `before` one snapshot earlier, if known) would still
 * be in plain view: both where it was and where it was heading by now. A player who stepped behind a
 * wall or out of reach fails one of the two checks; a rugger who vented at a visible spot passes both.
 */
export function vanishedInView(canSee: (x: number, y: number) => boolean, last: Vec, before: Vec | null): boolean {
  if (!canSee(last.x, last.y)) return false;
  if (before) {
    const ax = last.x + (last.x - before.x);
    const ay = last.y + (last.y - before.y);
    if (!canSee(ax, ay)) return false;
  }
  return true;
}
