// The canvas renderer: camera, static map, props, stations, characters, fog of war, effects
// and the home/lobby backdrop. The game module hands it a WorldView every frame.

import { DEV_DUMP_DURATION_MS, PLAYER_RADIUS } from '../../../shared/constants';
import { lineOfSight, type Vec } from '../../../shared/geometry';
import { EMERGENCY_BUTTON, sabotageStationById, stationById, ventById, WORLD_H, WORLD_W } from '../../../shared/map';
import type { BodyView, Phase, Role, SabotageView } from '../../../shared/protocol';
import type { Interactions } from '../context';
import { Backdrop } from './backdrop';
import { Camera } from './camera';
import { drawBody, drawGhost, drawLabel, drawPill, drawTag, drawVentMarker, PILL_TOP } from './characters';
import { Effects } from './effects';
import { Fog } from './fog';
import { COLORS, FONT_MONO, rgba } from './palette';
import { buildPropSprites, drawPoolWater, type PropAnimState, type PropSprite } from './props';
import { StaticMap } from './staticMap';
import { clamp, damp, get2d, hash01, rrect, TAU } from './util';

export { Effects } from './effects';

type G = CanvasRenderingContext2D;

export interface RenderPlayer {
  id: string;
  name: string;
  color: number;
  x: number;
  y: number;
  facing: 1 | -1;
  moving: boolean;
  /** Walk cycle phase (radians). */
  walk: number;
  alive: boolean;
  /** Only ever true when the server told this viewer (fellow rugger, ghost, game over). */
  isRugger: boolean;
  inVent: boolean;
  disconnected: boolean;
  /** Stable per-player animation seed. */
  seed: number;
}

export interface WorldView {
  phase: Phase;
  self: RenderPlayer;
  /** Vent the local player is hiding in (ruggers), or null. */
  selfVentId: string | null;
  role: Role;
  /** The viewer is a ghost: ghosts are visible, no fog. */
  viewerDead: boolean;
  /** No fog at all (dead viewer or game over). */
  noFog: boolean;
  /** Target vision radius in px (smoothed by the renderer). */
  visionRadius: number;
  /** Holder vision is reduced by FUD right now. */
  fud: boolean;
  remotes: readonly RenderPlayer[];
  bodies: readonly BodyView[];
  sabotage: SabotageView | null;
  /** Station ids of the local player's undone tasks that should glow. */
  taskGlow: readonly string[];
  interactions: Interactions;
  /** The local player was teleported: snap the camera instead of panning. */
  snapCamera: boolean;
  serverNow: number;
}

const T_PROP = 0;
const T_BODY = 1;
const T_REMOTE = 2;
const T_SELF = 3;
const T_VENT_REMOTE = 4;
const T_VENT_SELF = 5;
const T_PILL = 6;

interface SortItem {
  y: number;
  type: number;
  i: number;
}

const byY = (a: SortItem, b: SortItem): number => a.y - b.y;

/** True when all three web fonts are actually loaded (not just declared). */
function ourFontsLoaded(): boolean {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return true;
  let title = false;
  let text = false;
  let mono = false;
  try {
    fonts.forEach((f) => {
      if (f.status !== 'loaded') return;
      if (/bungee/i.test(f.family)) title = true;
      if (/space grotesk/i.test(f.family)) text = true;
      if (/jetbrains mono/i.test(f.family)) mono = true;
    });
  } catch {
    return true;
  }
  return title && text && mono;
}

/**
 * Max resolution of the pre-rendered map. 1.75 keeps the 2560x1760 world under ~14M px
 * (below Safari's 16.7M px canvas limit); touch devices stay at 1.5 to save memory.
 */
const MAX_STATIC_SCALE_DESKTOP = 1.75;
const MAX_STATIC_SCALE_TOUCH = 1.5;

export class Renderer {
  readonly effects = new Effects();
  private readonly canvas: HTMLCanvasElement;
  private readonly g: G;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private readonly camera = new Camera();
  private readonly staticMap = new StaticMap();
  private props: PropSprite[] = [];
  private readonly fog = new Fog();
  private readonly backdrop = new Backdrop();
  private builtScale = 0;
  private wantScale = 0;
  private wantScaleSince = 0;
  private fontEpoch = 0;
  private builtFontEpoch = 0;
  private fontTimer: number | null = null;
  private builtHadFonts = false;
  /** A font arrived while rebuilding had to wait (see deferRescale). */
  private fontRebuildPending = false;
  /**
   * Rebuilding the static layers takes a few hundred ms for the whole world, so it never runs
   * while playing: it waits for a meeting, ejection, game over or the lobby backdrop.
   */
  private deferRescale = false;
  /** The canvas was resized (and so cleared) since the last frame was drawn. */
  private resized = true;
  /** Lowered if a big static layer ever fails to allocate. */
  private scaleCap = Infinity;
  private dumpVignette: CanvasGradient | null = null;
  private ghostVignette: CanvasGradient | null = null;
  private homeVignette: CanvasGradient | null = null;
  private visionR = 0;
  private fogAlpha = 1;
  private mode: 'none' | 'world' | 'backdrop' = 'none';
  private readonly isTouch: boolean;
  // Vision used for visibility tests (from the last world frame).
  private readonly vis: Vec = { x: 0, y: 0 };
  private visR = 0;
  private visAll = true;
  private readonly probe: Vec = { x: 0, y: 0 };
  // Per-frame scratch, reused.
  private readonly items: SortItem[] = [];
  private readonly itemPool: SortItem[] = [];
  private readonly labels: RenderPlayer[] = [];
  private readonly animState: PropAnimState = { emergencyHot: false };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.g = get2d(canvas, { alpha: false });
    this.isTouch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.resizeIfNeeded();
    this.rebuild(this.wantScale);
    this.watchFonts();
  }

  // ---------- setup ----------

  /**
   * Room labels and prop text are baked into the static layers, so re-render them whenever one
   * of our web fonts finishes loading after the last build (fonts can arrive late or never).
   */
  private watchFonts(): void {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    const ours = /bungee|space grotesk|jetbrains mono/i;
    const schedule = () => {
      this.fontEpoch++;
      if (this.fontTimer !== null) window.clearTimeout(this.fontTimer);
      this.fontTimer = window.setTimeout(() => {
        this.fontTimer = null;
        if (this.builtFontEpoch === this.fontEpoch || this.builtHadFonts) return;
        if (this.deferRescale) this.fontRebuildPending = true;
        else this.rebuild(this.builtScale || this.wantScale);
      }, 200);
    };
    try {
      fonts.addEventListener('loadingdone', (ev) => {
        const faces = (ev as FontFaceSetLoadEvent).fontfaces ?? [];
        if (faces.some((f) => ours.test(f.family))) schedule();
      });
    } catch {
      /* old browsers */
    }
    // Kick off the loads explicitly: canvas text alone doesn't always trigger a download.
    const loads = ['24px Bungee', '700 12px "Space Grotesk"', '700 12px "JetBrains Mono"'].map((f) => fonts.load(f).catch(() => []));
    Promise.all(loads)
      .then((sets) => {
        if (sets.some((list) => list.length > 0)) schedule();
      })
      .catch(() => {
        /* keep fallback fonts */
      });
  }

  private get maxStaticScale(): number {
    return Math.min(this.scaleCap, this.isTouch ? MAX_STATIC_SCALE_TOUCH : MAX_STATIC_SCALE_DESKTOP);
  }

  private rebuild(scale: number): void {
    const s = clamp(scale || 1, 1, this.maxStaticScale);
    try {
      this.builtFontEpoch = this.fontEpoch;
      this.builtHadFonts = ourFontsLoaded();
      this.staticMap.render(s);
      this.props = buildPropSprites(s);
      this.builtScale = s;
    } catch (err) {
      // Out of canvas memory on a constrained device: never try this size again, fall back to 1x.
      console.warn('[render] static layer build failed at scale', s, err);
      this.scaleCap = Math.max(1, s - 0.25);
      if (s > 1) this.rebuild(1);
    }
  }

  private resizeIfNeeded(): void {
    const w = Math.max(1, Math.round(window.innerWidth || this.canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(window.innerHeight || this.canvas.clientHeight || 1));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.resized = true;
    this.fog.resize(w, h);
    this.dumpVignette = null;
    this.ghostVignette = null;
    this.homeVignette = null;
    const zoom = Camera.zoomFor(w, h);
    const want = clamp(Math.ceil(zoom * dpr * 4) / 4, 1, this.maxStaticScale);
    if (want !== this.wantScale) {
      this.wantScale = want;
      this.wantScaleSince = performance.now();
    }
  }

  /**
   * Re-render the static layers at a higher resolution once a resize has settled. Never
   * downscales: a smaller window (e.g. a mobile keyboard opening) would only cost a rebuild.
   */
  private maybeRescale(): void {
    if (this.deferRescale) return;
    const target = Math.min(this.wantScale, this.maxStaticScale);
    const grow = target > this.builtScale && performance.now() - this.wantScaleSince >= 450;
    if (this.fontRebuildPending) {
      this.fontRebuildPending = false;
      if (grow || (this.builtFontEpoch !== this.fontEpoch && !this.builtHadFonts)) this.rebuild(grow ? target : this.builtScale || this.wantScale);
      return;
    }
    if (grow) this.rebuild(target);
  }

  private vignettes(): void {
    const g = this.g;
    const w = this.cssW;
    const h = this.cssH;
    const inner = Math.min(w, h) * 0.28;
    const outer = Math.hypot(w, h) * 0.55;
    if (!this.dumpVignette) {
      const v = g.createRadialGradient(w / 2, h / 2, inner, w / 2, h / 2, outer);
      // Includes a light overall red tint so DEV DUMP costs one full-screen pass.
      v.addColorStop(0, 'rgba(255,59,92,0.07)');
      v.addColorStop(0.6, 'rgba(255,59,92,0.24)');
      v.addColorStop(1, 'rgba(255,40,70,0.64)');
      this.dumpVignette = v;
    }
    if (!this.ghostVignette) {
      const v = g.createRadialGradient(w / 2, h / 2, inner, w / 2, h / 2, outer);
      v.addColorStop(0, 'rgba(120,170,255,0)');
      v.addColorStop(1, 'rgba(110,160,255,0.22)');
      this.ghostVignette = v;
    }
    if (!this.homeVignette) {
      const v = g.createRadialGradient(w / 2, h / 2, inner * 0.6, w / 2, h / 2, outer);
      // Includes the flat readability dim, so the backdrop costs one full-screen pass.
      v.addColorStop(0, 'rgba(7,9,13,0.44)');
      v.addColorStop(1, 'rgba(4,6,9,0.95)');
      this.homeVignette = v;
    }
  }

  // ---------- visibility ----------

  /** Whether the local player can currently see a world point (fog of war rules). */
  canSee(x: number, y: number): boolean {
    if (this.visAll) return true;
    const dx = x - this.vis.x;
    const dy = y - this.vis.y;
    if (dx * dx + dy * dy > this.visR * this.visR) return false;
    this.probe.x = x;
    this.probe.y = y;
    return lineOfSight(this.vis, this.probe);
  }

  /** Current (smoothed) vision radius. */
  get visionRadius(): number {
    return this.visR;
  }

  resetForNewGame(): void {
    this.effects.reset();
    this.fog.invalidate();
    this.visionR = 0;
  }

  /** The canvas was resized since the last drawn frame, so it is blank. */
  get canvasStale(): boolean {
    return this.resized;
  }

  /**
   * A frame under an opaque DOM screen (meeting, ejection, game over): draw nothing, the last
   * world frame stays on the canvas. Effects keep aging so none replay afterwards, and a pending
   * static-layer rebuild may run since nobody is moving.
   */
  skipFrame(dt: number): void {
    this.deferRescale = false;
    this.resizeIfNeeded();
    this.maybeRescale();
    this.effects.update(dt, false);
  }

  // ---------- frame helpers ----------

  private beginFrame(): void {
    this.resizeIfNeeded();
    this.maybeRescale();
    this.resized = false;
    this.vignettes();
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  /** Clears to the background only when the (opaque) static map won't cover the whole view. */
  private clearOutsideWorld(vr: { x0: number; y0: number; x1: number; y1: number }): void {
    if (vr.x0 >= 0 && vr.y0 >= 0 && vr.x1 <= WORLD_W && vr.y1 <= WORLD_H && this.staticMap.canvas) return;
    const g = this.g;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.restore();
  }

  private worldTransform(cx: number, cy: number, z: number): { x0: number; y0: number; x1: number; y1: number } {
    const s = this.dpr * z;
    this.g.setTransform(s, 0, 0, s, this.dpr * (this.cssW / 2 - cx * z), this.dpr * (this.cssH / 2 - cy * z));
    const hw = this.cssW / 2 / z;
    const hh = this.cssH / 2 / z;
    return { x0: cx - hw - 8, y0: cy - hh - 8, x1: cx + hw + 8, y1: cy + hh + 8 };
  }

  private pushItem(y: number, type: number, i: number): void {
    let it = this.itemPool[this.items.length];
    if (!it) {
      it = { y: 0, type: 0, i: 0 };
      this.itemPool.push(it);
    }
    it.y = y;
    it.type = type;
    it.i = i;
    this.items.push(it);
  }

  private pushVisibleProps(x0: number, y0: number, x1: number, y1: number): void {
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      if (p.x > x1 || p.y > y1 || p.x + p.w < x0 || p.y + p.h < y0) continue;
      this.pushItem(p.sortY, T_PROP, i);
    }
  }

  private drawProp(i: number, t: number): void {
    const p = this.props[i];
    this.g.drawImage(p.canvas, p.x, p.y, p.w, p.h);
    if (p.anim) p.anim(this.g, t, this.animState);
  }

  private labelSize(): number {
    return clamp(12.5 / this.camera.zoom, 8.5, 22);
  }

  private keyHint(key: string, x: number, y: number, color: string): void {
    if (this.isTouch) return;
    const g = this.g;
    const s = clamp(11 / this.camera.zoom, 7, 18);
    g.save();
    g.beginPath();
    rrect(g, x - s * 0.75, y - s * 0.75, s * 1.5, s * 1.5, s * 0.3);
    g.fillStyle = 'rgba(6,8,12,0.85)';
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = Math.max(1, s * 0.1);
    g.stroke();
    g.font = `700 ${Math.round(s * 10) / 10}px ${FONT_MONO}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(key, x, y + s * 0.05);
    g.restore();
  }

  // ---------- world ----------

  renderWorld(view: WorldView, dt: number, t: number): void {
    this.deferRescale = view.phase === 'playing';
    this.beginFrame();
    const g = this.g;
    const self = view.self;
    const entering = this.mode !== 'world';
    this.mode = 'world';

    // Camera.
    this.camera.zoom = Camera.zoomFor(this.cssW, this.cssH);
    if (entering || view.snapCamera) this.camera.snap(self.x, self.y - 8);
    else this.camera.follow(self.x, self.y - 8, dt, 8);

    // Effects + vision.
    const dumpActive = view.phase === 'playing' && view.sabotage?.kind === 'devDump';
    this.effects.update(dt, dumpActive);
    if (entering || this.visionR <= 0) this.visionR = view.visionRadius;
    else this.visionR = damp(this.visionR, view.visionRadius, 3.2, dt);
    const fogTarget = view.noFog ? 0 : 1;
    this.fogAlpha = entering ? fogTarget : damp(this.fogAlpha, fogTarget, 2.5, dt);
    this.vis.x = self.x;
    this.vis.y = self.y;
    this.visR = this.visionR;
    this.visAll = view.noFog;

    const z = this.camera.zoom;
    const cx = this.camera.x + this.effects.shake.x / z;
    const cy = this.camera.y + this.effects.shake.y / z;
    const vr = this.worldTransform(cx, cy, z);
    this.clearOutsideWorld(vr);
    this.staticMap.draw(g, vr.x0, vr.y0, vr.x1, vr.y1);
    drawPoolWater(g, t, vr.x0, vr.y0, vr.x1, vr.y1);
    const playing = view.phase === 'playing';
    if (playing) this.drawFloorHighlights(view, t);

    // Y-sorted pass.
    this.items.length = 0;
    this.labels.length = 0;
    this.animState.emergencyHot = playing && view.interactions.use?.type === 'emergency';
    this.pushVisibleProps(vr.x0, vr.y0, vr.x1, vr.y1);
    for (let i = 0; i < view.bodies.length; i++) {
      const b = view.bodies[i];
      if (b.x < vr.x0 - 40 || b.x > vr.x1 + 40 || b.y < vr.y0 - 40 || b.y > vr.y1 + 40) continue;
      if (!this.canSee(b.x, b.y)) continue;
      this.pushItem(b.y + 6, T_BODY, i);
    }
    const ruggerView = view.role === 'rugger' || view.viewerDead || view.noFog;
    for (let i = 0; i < view.remotes.length; i++) {
      const p = view.remotes[i];
      if (!p.alive && !view.viewerDead && view.phase !== 'gameOver') continue; // the living never see ghosts
      if (p.x < vr.x0 - 60 || p.x > vr.x1 + 60 || p.y < vr.y0 - 80 || p.y > vr.y1 + 60) continue;
      if (p.inVent) {
        if (!ruggerView || !p.alive) continue;
        if (!this.canSee(p.x, p.y)) continue;
        this.pushItem(p.y - 20, T_VENT_REMOTE, i);
        continue;
      }
      if (!this.canSee(p.x, p.y)) continue;
      this.pushItem(p.y + PLAYER_RADIUS, T_REMOTE, i);
    }
    if (view.selfVentId) this.pushItem(self.y - 20, T_VENT_SELF, 0);
    else this.pushItem(self.y + PLAYER_RADIUS, T_SELF, 0);
    this.items.sort(byY);

    for (const it of this.items) {
      switch (it.type) {
        case T_PROP:
          this.drawProp(it.i, t);
          break;
        case T_BODY: {
          const b = view.bodies[it.i];
          drawBody(g, b.x, b.y, b.color, t);
          break;
        }
        case T_REMOTE: {
          const p = view.remotes[it.i];
          this.drawPlayer(p, t);
          this.labels.push(p);
          break;
        }
        case T_VENT_REMOTE: {
          const p = view.remotes[it.i];
          drawVentMarker(g, p.x, p.y, p.color, t, p.seed);
          this.labels.push(p);
          break;
        }
        case T_SELF:
          this.drawPlayer(self, t);
          this.labels.push(self);
          break;
        case T_VENT_SELF:
          drawVentMarker(g, self.x, self.y, self.color, t, self.seed);
          this.labels.push(self);
          break;
      }
    }

    this.effects.drawWorld(g);
    if (playing) this.drawActionHints(view, t);
    this.drawLabels(view, self);

    // Fog of war.
    if (this.fogAlpha > 0.01) {
      this.fog.render({ x: cx, y: cy, zoom: z }, self.x, self.y, Math.max(40, this.visionR), view.fud ? COLORS.darknessFud : COLORS.darkness);
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.globalAlpha = this.fogAlpha;
      g.imageSmoothingEnabled = true;
      g.drawImage(this.fog.canvas, 0, 0, this.cssW, this.cssH);
      g.globalAlpha = 1;
    }

    // Screen space.
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (view.viewerDead && view.phase !== 'gameOver' && this.ghostVignette) {
      g.fillStyle = this.ghostVignette;
      g.fillRect(0, 0, this.cssW, this.cssH);
    }
    let urgency = 0;
    if (dumpActive && view.sabotage?.endsAt !== undefined) {
      urgency = clamp(1 - (view.sabotage.endsAt - view.serverNow) / DEV_DUMP_DURATION_MS, 0, 1);
    }
    this.effects.drawScreen(g, this.cssW, this.cssH, t, dt, this.dumpVignette, urgency);
  }

  private drawPlayer(p: RenderPlayer, t: number): void {
    if (!p.alive) {
      drawGhost(this.g, p.x, p.y, p.color, p.facing, t, p.seed, p.disconnected ? 0.3 : 0.5);
      return;
    }
    drawPill(this.g, { x: p.x, y: p.y, color: p.color, facing: p.facing, moving: p.moving, walk: p.walk, seed: p.seed, alpha: p.disconnected ? 0.45 : 1 }, t);
  }

  private drawLabels(view: WorldView, self: RenderPlayer): void {
    const size = this.labelSize();
    for (const p of this.labels) {
      const isSelf = p === self;
      const red = isSelf ? view.role === 'rugger' : p.isRugger;
      const color = red ? COLORS.rug : '#ffffff';
      let y: number;
      let alpha = 1;
      if (p.inVent || (isSelf && view.selfVentId)) {
        y = p.y - 24;
        alpha = 0.65;
      } else if (!p.alive) {
        y = p.y + PILL_TOP - 16;
        alpha = 0.7;
      } else {
        y = p.y + PILL_TOP - 6;
      }
      if (p.disconnected) alpha *= 0.6;
      drawLabel(this.g, p.name, p.x, y, color, size, alpha);
      if (p.disconnected) drawTag(this.g, 'OFFLINE', p.x, y - size * 1.25, size * 0.62, 'rgba(10,12,16,0.85)', '#9aa6b5');
    }
  }

  /** Floor-level highlights: task glows, sabotage consoles, bridge cues, kill/report rings. */
  private drawFloorHighlights(view: WorldView, t: number): void {
    const g = this.g;
    const inter = view.interactions;
    // Undone tasks: yellow pulse.
    for (const id of view.taskGlow) {
      const st = stationById(id);
      if (!st) continue;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.2 + hash01(st.x + st.y) * 6);
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = rgba(COLORS.gold, 0.07 + pulse * 0.08);
      g.beginPath();
      g.arc(st.x, st.y, 26 + pulse * 4, 0, TAU);
      g.fill();
      g.restore();
      g.beginPath();
      rrect(g, st.x - 17.5, st.y - 17.5, 35, 35, 9);
      g.strokeStyle = rgba(COLORS.gold, 0.55 + pulse * 0.45);
      g.lineWidth = 2.2;
      g.stroke();
    }
    // Active sabotage consoles pulse red.
    const sab = view.sabotage;
    if (sab) {
      for (const s of sab.stations) {
        if (s.fixed) continue;
        const st = sabotageStationById(s.id);
        if (!st) continue;
        const pulse = 0.5 + 0.5 * Math.sin(t * 6);
        const held = (s.holders ?? 0) > 0;
        const col = held ? COLORS.pump : COLORS.rug;
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = rgba(col, 0.12 + pulse * 0.16);
        g.beginPath();
        g.arc(st.x, st.y, 30 + pulse * 8, 0, TAU);
        g.fill();
        g.restore();
        g.strokeStyle = rgba(col, 0.6 + pulse * 0.4);
        g.lineWidth = 2.5;
        g.beginPath();
        rrect(g, st.x - 19, st.y - 19, 38, 38, 9);
        g.stroke();
        g.strokeStyle = rgba(col, 0.35 * (1 - pulse));
        g.lineWidth = 2;
        g.beginPath();
        g.arc(st.x, st.y, 24 + pulse * 26, 0, TAU);
        g.stroke();
        // Marker above: "!" while unattended, a check while held.
        const my = st.y - 34 - pulse * 3;
        g.beginPath();
        g.arc(st.x, my, 8, 0, TAU);
        g.fillStyle = col;
        g.fill();
        g.fillStyle = '#07090d';
        if (held) {
          g.strokeStyle = '#07090d';
          g.lineWidth = 2.2;
          g.beginPath();
          g.moveTo(st.x - 3.5, my);
          g.lineTo(st.x - 0.8, my + 2.8);
          g.lineTo(st.x + 3.8, my - 2.6);
          g.stroke();
        } else {
          g.fillRect(st.x - 1.2, my - 5, 2.4, 6);
          g.fillRect(st.x - 1.2, my + 2.4, 2.4, 2.4);
        }
      }
    }
    // Bridges: highlight the one in range; while inside, arrows toward linked bridges.
    if (view.selfVentId) {
      const v = ventById(view.selfVentId);
      if (v) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 4);
        g.strokeStyle = rgba(COLORS.sol, 0.6 + 0.4 * pulse);
        g.lineWidth = 3;
        g.beginPath();
        rrect(g, v.x - 23, v.y - 18, 46, 36, 9);
        g.stroke();
        for (const id of v.links) {
          const o = ventById(id);
          if (!o) continue;
          const a = Math.atan2(o.y - v.y, o.x - v.x);
          const r = 44 + pulse * 6;
          g.save();
          g.translate(v.x + Math.cos(a) * r, v.y + Math.sin(a) * r);
          g.rotate(a);
          g.beginPath();
          g.moveTo(-6, -8);
          g.lineTo(5, 0);
          g.lineTo(-6, 8);
          g.strokeStyle = rgba(COLORS.solGreen, 0.85);
          g.lineWidth = 3;
          g.lineCap = 'round';
          g.lineJoin = 'round';
          g.stroke();
          g.restore();
        }
      }
    } else if (inter.ventId) {
      const v = ventById(inter.ventId);
      if (v) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 5);
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = rgba(COLORS.sol, 0.12 + 0.12 * pulse);
        g.beginPath();
        g.ellipse(v.x, v.y, 30, 24, 0, 0, TAU);
        g.fill();
        g.restore();
        g.strokeStyle = rgba(COLORS.sol, 0.7 + 0.3 * pulse);
        g.lineWidth = 2.5;
        g.beginPath();
        rrect(g, v.x - 23, v.y - 18, 46, 36, 9);
        g.stroke();
      }
    }
    // Kill target ring.
    if (inter.killTargetId) {
      const p = view.remotes.find((r) => r.id === inter.killTargetId);
      if (p && this.canSee(p.x, p.y)) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 8);
        g.strokeStyle = rgba(COLORS.rug, 0.55 + 0.45 * pulse);
        g.lineWidth = 2.5;
        g.beginPath();
        g.ellipse(p.x, p.y + 13, 19 + pulse * 2, 7 + pulse, 0, 0, TAU);
        g.stroke();
        g.fillStyle = rgba(COLORS.rug, 0.15);
        g.fill();
      }
    }
    // Report target ring.
    if (inter.reportBodyId) {
      const b = view.bodies.find((q) => q.id === inter.reportBodyId);
      if (b) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 6);
        g.strokeStyle = rgba(COLORS.gold, 0.6 + 0.4 * pulse);
        g.lineWidth = 2.5;
        g.beginPath();
        g.ellipse(b.x, b.y + 6, 34 + pulse * 3, 13 + pulse, 0, 0, TAU);
        g.stroke();
      }
    }
  }

  /** Small keycap hints near whatever the hotkeys would act on (desktop only). */
  private drawActionHints(view: WorldView, t: number): void {
    const g = this.g;
    const inter = view.interactions;
    const bob = Math.sin(t * 4) * 1.5;
    // Bouncing chevrons over undone tasks (drawn above props so desks never hide them).
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const id of view.taskGlow) {
      const st = stationById(id);
      if (!st) continue;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.2 + hash01(st.x + st.y) * 6);
      const cy = st.y - 30 - pulse * 5;
      g.beginPath();
      g.moveTo(st.x - 6, cy - 4);
      g.lineTo(st.x, cy + 2);
      g.lineTo(st.x + 6, cy - 4);
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 5;
      g.stroke();
      g.strokeStyle = COLORS.gold;
      g.lineWidth = 2.5;
      g.stroke();
    }
    const u = inter.use;
    if (u) {
      if (u.type === 'task') {
        const st = stationById(u.stationId);
        if (st) this.keyHint('E', st.x + 24, st.y - 22 + bob, COLORS.gold);
      } else if (u.type === 'fix') {
        const st = sabotageStationById(u.stationId);
        if (st) this.keyHint('E', st.x + 26, st.y - 24 + bob, COLORS.rug);
      } else if (u.type === 'emergency') {
        this.keyHint('E', EMERGENCY_BUTTON.x + 30, EMERGENCY_BUTTON.y - 44 + bob, COLORS.rug);
      }
      if (u.type === 'task' || u.type === 'fix') {
        const st = u.type === 'task' ? stationById(u.stationId) : sabotageStationById(u.stationId);
        if (st) {
          g.strokeStyle = 'rgba(255,255,255,0.9)';
          g.lineWidth = 2;
          g.beginPath();
          rrect(g, st.x - 21, st.y - 21, 42, 42, 11);
          g.stroke();
        }
      }
    }
    if (inter.ventId && !view.selfVentId) {
      const v = ventById(inter.ventId);
      if (v) this.keyHint('V', v.x + 28, v.y - 22 + bob, COLORS.sol);
    }
    if (inter.reportBodyId) {
      const b = view.bodies.find((q) => q.id === inter.reportBodyId);
      if (b) this.keyHint('R', b.x + 30, b.y - 24 + bob, COLORS.gold);
    }
    if (inter.killTargetId) {
      const p = view.remotes.find((r) => r.id === inter.killTargetId);
      if (p && this.canSee(p.x, p.y)) this.keyHint('Q', p.x + 22, p.y - 40 + bob, COLORS.rug);
    }
  }

  // ---------- home / lobby backdrop ----------

  renderBackdrop(dt: number, t: number, colors: readonly number[]): void {
    this.deferRescale = false;
    this.beginFrame();
    const g = this.g;
    const entering = this.mode !== 'backdrop';
    this.mode = 'backdrop';
    this.visAll = true;
    this.backdrop.sync(colors);
    this.backdrop.update(dt);
    this.effects.update(dt, false);
    const focus = this.backdrop.focus();
    this.camera.zoom = Camera.zoomFor(this.cssW, this.cssH) * 0.9;
    if (entering) this.camera.snap(focus.x, focus.y);
    else this.camera.follow(focus.x, focus.y, dt, 0.9);
    const z = this.camera.zoom;
    const vr = this.worldTransform(this.camera.x, this.camera.y, z);
    this.clearOutsideWorld(vr);
    this.staticMap.draw(g, vr.x0, vr.y0, vr.x1, vr.y1);
    drawPoolWater(g, t, vr.x0, vr.y0, vr.x1, vr.y1);

    this.items.length = 0;
    this.animState.emergencyHot = false;
    this.pushVisibleProps(vr.x0, vr.y0, vr.x1, vr.y1);
    const pills = this.backdrop.pills;
    for (let i = 0; i < pills.length; i++) {
      const p = pills[i];
      if (p.x < vr.x0 - 60 || p.x > vr.x1 + 60 || p.y < vr.y0 - 80 || p.y > vr.y1 + 60) continue;
      this.pushItem(p.y + PLAYER_RADIUS, T_PILL, i);
    }
    this.items.sort(byY);
    for (const it of this.items) {
      if (it.type === T_PROP) this.drawProp(it.i, t);
      else {
        const p = pills[it.i];
        drawPill(g, { x: p.x, y: p.y, color: p.color, facing: p.facing, moving: p.moving, walk: p.walk, seed: p.seed }, t);
      }
    }
    this.effects.drawWorld(g);

    // Readability overlay for the DOM UI on top.
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.homeVignette) {
      g.fillStyle = this.homeVignette;
      g.fillRect(0, 0, this.cssW, this.cssH);
    }
    // Pump candles drifting up.
    const w = this.cssW;
    const h = this.cssH;
    for (let i = 0; i < 16; i++) {
      const speed = 18 + hash01(i * 5) * 34;
      const span = h + 140;
      const y = h + 70 - ((t * speed + hash01(i * 9) * span) % span);
      const x = hash01(i * 3 + 1) * w + Math.sin(t * 0.4 + i) * 10;
      const up = hash01(i * 17) < 0.78;
      const ch = 18 + hash01(i * 23) * 36;
      const cw = 6 + hash01(i * 29) * 6;
      g.fillStyle = rgba(up ? COLORS.pump : COLORS.rug, 0.06 + hash01(i * 31) * 0.07);
      g.fillRect(x - 0.75, y - ch * 0.85, 1.5, ch * 1.7);
      g.fillRect(x - cw / 2, y - ch / 2, cw, ch);
    }
    this.effects.drawScreen(g, this.cssW, this.cssH, t, dt, this.dumpVignette, 0);
  }
}
