// UI logic that runs without a browser: ejection copy and the rugged cutscene's early dismissal.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EjectionView, Snapshot } from '../shared/protocol';
import { ejectionText } from '../client/src/ui/ejection';
import { dismissRuggedCutscene } from '../client/src/ui/cutscene';

function snapWith(ejection: EjectionView, confirmEjects: boolean): Snapshot {
  return { ejection, room: { settings: { confirmEjects } } } as unknown as Snapshot;
}

describe('ejectionText', () => {
  it('shows the remaining-rugger count when the server sends it', () => {
    const one = ejectionText(snapWith({ ejectedId: 'a', ejectedName: 'Bob', wasRugger: false, tie: false, ruggersLeft: 1 }, true));
    expect(one).toEqual({ main: 'Bob was not the Rugger.', sub: '1 Rugger remains.', tie: false });
    const two = ejectionText(snapWith({ ejectedId: 'a', ejectedName: 'Bob', wasRugger: true, tie: false, ruggersLeft: 2 }, true));
    expect(two.sub).toBe('2 Ruggers remain.');
    const none = ejectionText(snapWith({ ejectedId: 'a', ejectedName: 'Bob', wasRugger: true, tie: false, ruggersLeft: 0 }, true));
    expect(none.sub).toBe('0 Ruggers remain.');
  });

  it('leaves the count out when ruggersLeft is absent (confirmEjects off), never printing "undefined"', () => {
    const t = ejectionText(snapWith({ ejectedId: 'a', ejectedName: 'Bob', tie: false }, false));
    expect(t).toEqual({ main: 'Bob was blacklisted.', sub: '', tie: false });
    const skipped = ejectionText(snapWith({ ejectedId: null, tie: true }, false));
    expect(skipped).toEqual({ main: 'No one was blacklisted.', sub: '', tie: true });
  });
});

describe('dismissRuggedCutscene', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function fakeCut(leaving = false) {
    const classes = new Set<string>(['cut', ...(leaving ? ['is-leaving'] : [])]);
    return {
      classes,
      removed: false,
      classList: { add: (c: string) => classes.add(c) },
      remove() {
        this.removed = true;
      },
    };
  }

  it('fades out a running cutscene and removes it after the fade', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    const running = fakeCut();
    const fading = fakeCut(true);
    const layer = {
      querySelectorAll: (sel: string) => (sel === '.cut:not(.is-leaving)' ? [running] : []),
    } as unknown as HTMLElement;
    dismissRuggedCutscene(layer);
    expect(running.classes.has('is-leaving')).toBe(true);
    expect(running.removed).toBe(false);
    vi.advanceTimersByTime(300);
    expect(running.removed).toBe(true);
    expect(fading.removed).toBe(false); // already leaving: its own timer removes it
  });

  it('is a no-op when no cutscene is showing', () => {
    const layer = { querySelectorAll: () => [] } as unknown as HTMLElement;
    expect(() => dismissRuggedCutscene(layer)).not.toThrow();
  });
});
