// Cosmetic rendering (client/src/render/cosmetics.ts and friends), on a recording fake 2D context.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COSMETICS } from '../shared/cosmetics';
import { PLAYER_COLORS, TILE } from '../shared/constants';
import { CELL_WALL, cellAt, EMERGENCY_BUTTON } from '../shared/map';
import type { EquippedCosmetics, PlayerView, Snapshot } from '../shared/protocol';
import {
  drawBodyRug,
  drawNameFx,
  drawPillPreview,
  drawRug,
  drawRugPreview,
  isKnownNameFx,
  isKnownRug,
  labelEffect,
  NAME_FX_IDS,
  RUG_IDS,
  SKIN_IDS,
  skinHeadroom,
  skinPainter,
} from '../client/src/render/cosmetics';
import { drawGhost, drawPill } from '../client/src/render/characters';
import { Backdrop } from '../client/src/render/backdrop';
import { Renderer, type RenderPlayer, type WorldView } from '../client/src/render/index';
import { RemoteInterpolator } from '../client/src/game/interp';
import { NO_INTERACTIONS } from '../client/src/game/interactions';
import type { TimedSnapshot } from '../client/src/store';

// ---------- a recording 2D context ----------

interface Rec {
  /** Every color string assigned to fillStyle / strokeStyle / shadowColor, plus gradient stops. */
  colors: string[];
  /** fillText calls with the fill style at the time. */
  texts: { text: string; style: unknown }[];
  saves: number;
  restores: number;
  minDepth: number;
  clips: number;
  canvases: number;
}

const STATE_KEYS = ['fillStyle', 'strokeStyle', 'globalAlpha', 'globalCompositeOperation', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin'] as const;

function recContext(rec: Rec): CanvasRenderingContext2D {
  const state: Record<string, unknown> = { fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter' };
  const stack: Record<string, unknown>[] = [];
  let depth = 0;
  const gradient = () => ({ addColorStop: (_o: number, c: string) => rec.colors.push(c) });
  const fns: Record<string, unknown> = {
    save() {
      rec.saves++;
      depth++;
      stack.push({ ...state });
    },
    restore() {
      rec.restores++;
      depth--;
      rec.minDepth = Math.min(rec.minDepth, depth);
      const s = stack.pop();
      if (s) Object.assign(state, s);
    },
    clip() {
      rec.clips++;
    },
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    fillText(text: string) {
      rec.texts.push({ text, style: state.fillStyle });
    },
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  return new Proxy(state, {
    get(t, k) {
      if (typeof k === 'string' && k in fns) return fns[k];
      if (typeof k === 'string' && (STATE_KEYS as readonly string[]).includes(k)) return t[k];
      if (k in t) return t[k as string];
      return () => {};
    },
    set(t, k, v) {
      if ((k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') && typeof v === 'string') rec.colors.push(v);
      t[k as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function newRec(): Rec {
  return { colors: [], texts: [], saves: 0, restores: 0, minDepth: 0, clips: 0, canvases: 0 };
}

let rec: Rec;

function fakeDom(): void {
  vi.stubGlobal('document', {
    createElement: () => {
      rec.canvases++;
      const g = recContext(newRec());
      return { width: 300, height: 150, style: {}, clientWidth: 0, clientHeight: 0, getContext: () => g };
    },
  });
}

// ---------- color helpers ----------

function parseColor(c: string): [number, number, number] | null {
  const s = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as [number, number, number];
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/** Saturated mid-lightness reds and pinks (the rug-red family), not greys, near-blacks or near-whites. */
function isRedFamily(c: string): boolean {
  const rgb = parseColor(c);
  if (!rgb) return false;
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  if (s < 0.35 || l < 0.15 || l > 0.9) return false;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h < 22 || h > 330;
}

beforeEach(() => {
  rec = newRec();
  fakeDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cosmetic art coverage', () => {
  it('has art for every catalog item, and no art for items the catalog lacks', () => {
    for (const item of COSMETICS) {
      if (item.slot === 'skin') expect(skinPainter(item.id), item.id).toBeDefined();
      if (item.slot === 'rug') expect(isKnownRug(item.id), item.id).toBe(true);
      if (item.slot === 'name') expect(isKnownNameFx(item.id), item.id).toBe(true);
    }
    const catalog = (slot: string) => COSMETICS.filter((c) => c.slot === slot).map((c) => c.id).sort();
    expect([...SKIN_IDS].sort()).toEqual(catalog('skin'));
    expect([...RUG_IDS].sort()).toEqual(catalog('rug'));
    expect([...NAME_FX_IDS].sort()).toEqual(catalog('name'));
  });

  it('ignores unknown or cross-slot ids instead of throwing', () => {
    const g = recContext(rec);
    expect(skinPainter('rug_gold')).toBeUndefined();
    expect(skinPainter('__proto__')).toBeUndefined();
    expect(isKnownRug('constructor')).toBe(false);
    expect(drawRug(g, 'skin_gold', 0, 0, 90, 50, 0)).toBe(false);
    expect(drawNameFx(g, 'name_nope', 'x', 0, 0, 12, 1, 0)).toBe(false);
    expect(() => drawPillPreview(g, 32, 32, 1, 3, { skin: 'skin_nope', rug: 'rug_nope', name: 'toString' }, 1000)).not.toThrow();
    expect(skinHeadroom('skin_crown')).toBeGreaterThan(0);
    expect(skinHeadroom('skin_shades')).toBe(0);
    expect(skinHeadroom(undefined)).toBe(0);
  });
});

describe('drawPillPreview and friends', () => {
  const loadouts: EquippedCosmetics[] = [
    {},
    ...COSMETICS.map((c) => ({ [c.slot]: c.id }) as EquippedCosmetics),
    { skin: 'skin_crown', rug: 'rug_galaxy', name: 'name_fire' },
    { skin: 'skin_laser', rug: 'rug_gold', name: 'name_glitch' },
  ];

  it('draws every item for every color at many times, with balanced save/restore', () => {
    const g = recContext(rec);
    for (const eq of loadouts) {
      for (let color = 0; color < PLAYER_COLORS.length; color += 3) {
        for (let ms = 0; ms < 6000; ms += 731) {
          drawPillPreview(g, 64, 64, 2, color, eq, ms, { moving: ms % 2 === 0, facing: ms % 3 ? 1 : -1, seed: color });
        }
      }
    }
    expect(rec.saves).toBeGreaterThan(0);
    expect(rec.saves).toBe(rec.restores);
    expect(rec.minDepth).toBe(0);
    drawPillPreview(g, 0, 0, 1, 0, null, NaN, { label: null });
    drawPillPreview(g, 0, 0, 0, 0, { skin: 'skin_holo' }, 0);
    expect(rec.saves).toBe(rec.restores);
  });

  it('draws skins on pills and faded on ghosts, leaving the context state as it found it', () => {
    const g = recContext(rec);
    for (const skin of SKIN_IDS) {
      for (let t = 0; t < 8; t += 0.37) {
        drawPill(g, { x: 10, y: 20, color: 2, facing: t > 4 ? 1 : -1, moving: t > 2, walk: t * 9, seed: 5, skin }, t);
        drawGhost(g, 10, 20, 2, 1, t, 5, 0.5, skin);
      }
    }
    expect(rec.saves).toBe(rec.restores);
    expect(rec.minDepth).toBe(0);
    expect(g.globalAlpha).toBe(1);
    expect(g.globalCompositeOperation).toBe('source-over');
  });

  it('shows a sample name only when a name effect is equipped, or the given label', () => {
    const g = recContext(rec);
    drawPillPreview(g, 32, 32, 1, 0, { skin: 'skin_gold' }, 0);
    expect(rec.texts).toHaveLength(0);
    drawPillPreview(g, 32, 32, 1, 0, { name: 'name_diamond' }, 0);
    expect(rec.texts.map((x) => x.text)).toContain('degen');
    rec.texts.length = 0;
    drawPillPreview(g, 32, 32, 1, 0, { name: 'name_gold' }, 0, { label: 'whale' });
    expect(rec.texts.map((x) => x.text)).toContain('whale');
    rec.texts.length = 0;
    drawPillPreview(g, 32, 32, 1, 0, { name: 'name_gold' }, 0, { label: null });
    expect(rec.texts).toHaveLength(0);
  });

  it('caches textures: pattern canvases are built once, not per frame', () => {
    const g = recContext(rec);
    for (let i = 0; i < 3; i++) {
      for (const id of RUG_IDS) drawRugPreview(g, 0, 0, 2, id, i * 500);
      drawPill(g, { x: 0, y: 0, color: 1, facing: 1, moving: false, walk: 0, seed: 0, skin: 'skin_onchain' }, i);
      drawPill(g, { x: 0, y: 0, color: 1, facing: 1, moving: false, walk: 0, seed: 0, skin: 'skin_holo' }, i);
      if (i === 0) rec.canvases = 0;
    }
    expect(rec.canvases).toBe(0);
  });
});

describe('name effects', () => {
  it('never use a red-family color, at any time or size', () => {
    const g = recContext(rec);
    for (const fx of NAME_FX_IDS) {
      rec.colors.length = 0;
      for (const size of [8.5, 12.5, 22]) {
        for (let t = 0; t < 12; t += 0.043) {
          expect(drawNameFx(g, fx, 'DegenKing 💎', 100, 50, size, 0.8, t, 17)).toBe(true);
        }
      }
      const reds = [...new Set(rec.colors.filter(isRedFamily))];
      expect(reds, fx).toEqual([]);
      expect(rec.colors.length).toBeGreaterThan(0);
    }
    expect(rec.saves).toBe(rec.restores);
    // Sanity check of the detector itself.
    expect(isRedFamily('#ff3b5c')).toBe(true);
    expect(isRedFamily('rgba(255,59,92,0.5)')).toBe(true);
    expect(isRedFamily('#ff8f0f')).toBe(false);
    expect(isRedFamily('rgba(4,6,9,0.85)')).toBe(false);
  });

  it('the ally-red rule wins over any effect', () => {
    for (const fx of NAME_FX_IDS) {
      expect(labelEffect(true, { name: fx })).toBeNull();
      expect(labelEffect(false, { name: fx })).toBe(fx);
    }
    expect(labelEffect(false, { name: 'skin_gold' })).toBeNull();
    expect(labelEffect(false, undefined)).toBeNull();
    expect(labelEffect(false, {})).toBeNull();
  });
});

describe('rugs in the world', () => {
  it('lie flat on open floor, and are clipped to floor tiles next to a wall', () => {
    const g = recContext(rec);
    const open = { x: EMERGENCY_BUTTON.x, y: EMERGENCY_BUTTON.y - 105 };
    expect(drawBodyRug(g, open.x, open.y, 'rug_frog', 1)).toBe(true);
    expect(rec.clips).toBe(0);
    // Just inside the LAUNCHPAD's west wall.
    const wallTx = 23;
    expect(cellAt(wallTx, 3)).toBe(CELL_WALL);
    expect(drawBodyRug(g, (wallTx + 1) * TILE + 20, 3 * TILE + 20, 'rug_persian', 1)).toBe(true);
    expect(rec.clips).toBeGreaterThan(0);
    expect(rec.saves).toBe(rec.restores);
    expect(drawBodyRug(g, open.x, open.y, undefined, 1)).toBe(false);
  });
});

// ---------- integration: game/ -> render/ ----------

function player(over: Partial<PlayerView>): PlayerView {
  return { id: 'p', name: 'p', color: 0, x: 1280, y: 300, facing: 1, moving: false, alive: true, isBot: false, ...over };
}

describe('cosmetics reach the world renderer', () => {
  it('the remote interpolator carries each player\'s equipped cosmetics', () => {
    const cos: EquippedCosmetics = { skin: 'skin_laser', name: 'name_fire' };
    const snap = { t: 'snap', now: 1000, phase: 'playing', players: [player({ id: 'a', cosmetics: cos }), player({ id: 'b' })], bodies: [] } as unknown as Snapshot;
    const history: TimedSnapshot[] = [{ snap, recvAt: 0 } as TimedSnapshot];
    const r = new RemoteInterpolator();
    r.update(history, 1000, null, 1 / 60);
    expect(r.get('a')?.cosmetics).toEqual(cos);
    expect(r.get('b')?.cosmetics).toBeUndefined();
    // Equipping later (lobby) shows up on the next snapshot.
    const snap2 = { ...snap, now: 1050, players: [player({ id: 'a', cosmetics: { skin: 'skin_gold' } }), player({ id: 'b', cosmetics: { name: 'name_gold' } })] } as unknown as Snapshot;
    r.update([...history, { snap: snap2, recvAt: 50 } as TimedSnapshot], 1050, null, 1 / 60);
    expect(r.get('a')?.cosmetics).toEqual({ skin: 'skin_gold' });
    expect(r.get('b')?.cosmetics).toEqual({ name: 'name_gold' });
  });

  it('the lobby backdrop dresses players in their skins', () => {
    const b = new Backdrop();
    b.sync([3, 3, 5], ['skin_crown', 'skin_gold', undefined]);
    expect(b.pills.find((p) => p.color === 3)?.skin).toBe('skin_crown');
    expect(b.pills.find((p) => p.color === 5)?.skin).toBeUndefined();
    b.sync([3, 5], [undefined, 'skin_holo']);
    expect(b.pills.find((p) => p.color === 3)?.skin).toBeUndefined();
    expect(b.pills.find((p) => p.color === 5)?.skin).toBe('skin_holo');
  });

  function worldFixture(role: 'holder' | 'rugger'): { renderer: Renderer; view: WorldView; rec: Rec } {
    const worldRec = newRec();
    const g = recContext(worldRec);
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, setTimeout, clearTimeout });
    vi.stubGlobal(
      'Path2D',
      class {
        moveTo() {}
        lineTo() {}
      },
    );
    const canvas = { width: 300, height: 150, style: {}, clientWidth: 0, clientHeight: 0, getContext: () => g } as unknown as HTMLCanvasElement;
    const renderer = new Renderer(canvas);
    const P = (id: string, name: string, x: number, cos: EquippedCosmetics | undefined, extra: Partial<RenderPlayer> = {}): RenderPlayer => ({
      id,
      name,
      color: 2,
      x,
      y: 300,
      facing: 1,
      moving: false,
      walk: 0,
      alive: true,
      isRugger: false,
      inVent: false,
      disconnected: false,
      seed: 1,
      cosmetics: cos,
      ...extra,
    });
    const view: WorldView = {
      phase: 'playing',
      self: P('me', 'Myself', 1280, { skin: 'skin_crown', name: 'name_gold' }),
      selfVentId: null,
      role,
      viewerDead: false,
      noFog: true,
      visionRadius: 300,
      fud: false,
      remotes: [P('ally', 'AllyRug', 1220, { skin: 'skin_holo', name: 'name_rainbow' }, { isRugger: role === 'rugger' }), P('h', 'Holder', 1340, { skin: 'skin_shades', name: 'name_glitch' })],
      bodies: [{ id: 'v', color: 4, x: 1300, y: 360, rug: 'rug_galaxy' }],
      sabotage: null,
      taskGlow: [],
      interactions: NO_INTERACTIONS,
      snapCamera: true,
      serverNow: 0,
    };
    return { renderer, view, rec: worldRec };
  }

  it('a rugger sees a fellow rugger\'s name in plain rug red (effect suppressed); holders see the effect', () => {
    const rugger = worldFixture('rugger');
    rugger.renderer.renderWorld(rugger.view, 1 / 60, 1.5);
    const allyR = rugger.rec.texts.filter((x) => x.text === 'AllyRug');
    expect(allyR.length).toBe(1);
    expect(String(allyR[0].style).toLowerCase()).toBe('#ff3b5c');
    // The rugger's own name is red too, without its gold effect.
    expect(rugger.rec.texts.filter((x) => x.text === 'Myself').map((x) => String(x.style).toLowerCase())).toEqual(['#ff3b5c']);
    // A holder's name keeps its effect (glitch draws the name in several colors, none of them red).
    const holderLabel = rugger.rec.texts.filter((x) => x.text === 'Holder');
    expect(holderLabel.length).toBeGreaterThan(1);
    expect(holderLabel.some((x) => typeof x.style === 'string' && isRedFamily(x.style))).toBe(false);

    vi.unstubAllGlobals();
    fakeDom();
    const holder = worldFixture('holder');
    holder.renderer.renderWorld(holder.view, 1 / 60, 1.5);
    // Rainbow draws letter by letter; nothing about that name is red for a holder.
    expect(holder.rec.texts.filter((x) => x.text === 'AllyRug')).toHaveLength(0);
    const letters = holder.rec.texts.filter((x) => x.text.length === 1 && 'AllyRug'.includes(x.text));
    expect(letters.length).toBeGreaterThanOrEqual('AllyRug'.length);
    expect(letters.some((x) => typeof x.style === 'string' && isRedFamily(x.style))).toBe(false);
    expect(holder.rec.saves).toBe(holder.rec.restores);
  });
});
