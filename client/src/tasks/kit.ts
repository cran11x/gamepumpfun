// Shared toolkit for the minigames: a disposable scope for listeners / timers / frames, tiny DOM
// builders, randomness helpers, a pointer-capture drag helper, and the context type every
// minigame receives from the frame in index.ts.

import { DEFAULT_TICKER } from '../../../shared/constants';
import type { MinigameHost, MinigameTarget, SoundName } from '../context';

// ---------- Minigame contract (internal to tasks/) ----------

export type Tone = 'good' | 'bad' | 'info';

export interface MinigameCtx {
  readonly host: MinigameHost;
  readonly target: MinigameTarget;
  readonly scope: Scope;
  /** The play area: position relative, overflow hidden, a CSS size container named `tk-stage`. */
  readonly stage: HTMLElement;
  /** Replace the instruction line. */
  setHint(text: string): void;
  /** Show a short feedback message in the instruction line, then restore the instruction. */
  flash(text: string, tone?: Tone, ms?: number): void;
  /** Play a sound through the host (never throws). */
  sound(name: SoundName): void;
  /** Light positive feedback (click sound). */
  click(): void;
  /** Wrong move: error sound, shake (the given element or the stage), red flash, optional message. */
  fail(text?: string, shake?: Element | null): void;
  /** Success: plays taskDone, shows the success animation, then calls host.complete() once (~400 ms). */
  win(label: string): void;
  /** True once win() has been called. Minigames stop accepting input after that. */
  readonly won: boolean;
}

export interface MinigameDef {
  /** Instruction line shown under the title. */
  hint: string;
  mount(ctx: MinigameCtx): void;
}

// ---------- Scope: everything a minigame registers is undone by dispose() ----------

function runSafe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[tasks] cleanup step failed', err);
  }
}

export class Scope {
  disposed = false;
  private cleanups: Array<() => void> = [];
  private timeouts = new Set<number>();
  private intervals = new Set<number>();
  private frames = new Set<number>();

  /** Register a cleanup step. Runs immediately if the scope is already disposed. */
  add(fn: () => void): void {
    if (this.disposed) runSafe(fn);
    else this.cleanups.push(fn);
  }

  /** addEventListener that is removed on dispose and never fires after it. */
  on<E extends Event = Event>(target: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions): void {
    if (this.disposed) return;
    const handler = (e: Event): void => {
      if (!this.disposed) fn(e as E);
    };
    target.addEventListener(type, handler, opts);
    this.cleanups.push(() => target.removeEventListener(type, handler, opts));
  }

  timeout(fn: () => void, ms: number): number {
    if (this.disposed) return 0;
    const id = window.setTimeout(() => {
      this.timeouts.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timeouts.add(id);
    return id;
  }

  clearTimeout(id: number): void {
    if (!id) return;
    window.clearTimeout(id);
    this.timeouts.delete(id);
  }

  interval(fn: () => void, ms: number): number {
    if (this.disposed) return 0;
    const id = window.setInterval(() => {
      if (!this.disposed) fn();
    }, ms);
    this.intervals.add(id);
    return id;
  }

  clearInterval(id: number): void {
    if (!id) return;
    window.clearInterval(id);
    this.intervals.delete(id);
  }

  /**
   * requestAnimationFrame loop. `fn` gets the frame delta in seconds (clamped to 50 ms so a
   * backgrounded tab never makes things jump) and the frame timestamp. Return false to stop.
   * Returns a stop function.
   */
  loop(fn: (dt: number, now: number) => boolean | void): () => void {
    if (this.disposed) return () => undefined;
    let last = performance.now();
    let id = 0;
    let stopped = false;
    const step = (now: number): void => {
      this.frames.delete(id);
      if (stopped || this.disposed) return;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (fn(dt, now) === false) {
        stopped = true;
        return;
      }
      id = requestAnimationFrame(step);
      this.frames.add(id);
    };
    id = requestAnimationFrame(step);
    this.frames.add(id);
    return () => {
      stopped = true;
      cancelAnimationFrame(id);
      this.frames.delete(id);
    };
  }

  /** Calls `fn` whenever the element's box changes size. */
  observeSize(target: Element, fn: () => void): void {
    if (this.disposed) return;
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (!this.disposed) fn();
      });
      ro.observe(target);
      this.cleanups.push(() => ro.disconnect());
    } else {
      this.on(window, 'resize', fn);
    }
  }

  /** Idempotent. Clears timers and frames, then runs cleanups in reverse order. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timeouts.forEach((id) => window.clearTimeout(id));
    this.intervals.forEach((id) => window.clearInterval(id));
    this.frames.forEach((id) => cancelAnimationFrame(id));
    this.timeouts.clear();
    this.intervals.clear();
    this.frames.clear();
    const list = this.cleanups.splice(0).reverse();
    for (const fn of list) runSafe(fn);
  }
}

// ---------- DOM ----------

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  if (attrs) setAttrs(node, attrs);
  return node;
}

export function setAttrs(node: Element, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
}

/** A <button type="button">. */
export function button(cls: string, text?: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

/** Remove and re-add a class so its CSS animation plays again. */
export function restartClass(node: Element, cls: string): void {
  node.classList.remove(cls);
  // Reading layout forces a style flush so the animation restarts.
  void (node as HTMLElement).offsetWidth;
  node.classList.add(cls);
}

/** A short floating label (e.g. "+1 SNIPED") that rises and fades inside `parent`. */
export function floatText(scope: Scope, parent: HTMLElement, text: string, xPct: number, yPct: number, cls = ''): void {
  const node = el('span', `tk-float${cls ? ` ${cls}` : ''}`, text);
  node.style.left = `${xPct}%`;
  node.style.top = `${yPct}%`;
  parent.append(node);
  scope.timeout(() => node.remove(), 900);
}

/** True when keyboard input is going into a text field (hotkeys must ignore it). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

export function isSpaceKey(e: KeyboardEvent): boolean {
  return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
}

/** Short haptic tick on devices that support it. */
export function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported / not allowed */
  }
}

// ---------- Canvas ----------

export interface CanvasView {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** CSS pixel size. */
  w: number;
  h: number;
  dpr: number;
  /** Reset the transform to CSS pixels and clear. Call at the top of every draw. */
  begin(): void;
}

/** Keeps a canvas' backing store matched to its CSS box and device pixel ratio. */
export function canvasView(scope: Scope, canvas: HTMLCanvasElement, onResize?: () => void): CanvasView {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  const view: CanvasView = {
    canvas,
    ctx,
    w: 1,
    h: 1,
    dpr: 1,
    begin() {
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.clearRect(0, 0, view.w, view.h);
    },
  };
  const fit = (): void => {
    const w = Math.max(1, Math.round(canvas.clientWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight));
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (w === view.w && h === view.h && dpr === view.dpr && canvas.width > 1) return;
    view.w = w;
    view.h = h;
    view.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    onResize?.();
  };
  fit();
  scope.observeSize(canvas, fit);
  return view;
}

/** Begins a new path with a rounded rectangle (works where ctx.roundRect is missing). */
export function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

// ---------- Pointer drags ----------

export interface DragHandlers {
  /** Return false to ignore this press. */
  start(e: PointerEvent): boolean | void;
  move?(e: PointerEvent): void;
  /** `cancelled` is true for pointercancel / lost capture (finger stolen by the OS, etc.). */
  end?(e: PointerEvent, cancelled: boolean): void;
}

/**
 * One-pointer drag on `target` using pointer capture, so the drag keeps tracking when the
 * finger or mouse leaves the element. The element should have `touch-action: none`.
 */
export function onDrag(scope: Scope, target: Element, handlers: DragHandlers): { isActive(): boolean } {
  let active: number | null = null;
  const finish = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerId !== active) return;
    active = null;
    try {
      if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    handlers.end?.(e, cancelled);
  };
  scope.on<PointerEvent>(target, 'pointerdown', (e) => {
    if (active !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (handlers.start(e) === false) return;
    active = e.pointerId;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    e.preventDefault();
  });
  scope.on<PointerEvent>(target, 'pointermove', (e) => {
    if (e.pointerId === active) handlers.move?.(e);
  });
  scope.on<PointerEvent>(target, 'pointerup', (e) => finish(e, false));
  scope.on<PointerEvent>(target, 'pointercancel', (e) => finish(e, true));
  scope.on<PointerEvent>(target, 'lostpointercapture', (e) => finish(e, true));
  return { isActive: () => active !== null };
}

// ---------- Random & math ----------

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Integer in [min, max], inclusive. */
export function randInt(min: number, max: number): number {
  return Math.min(max, Math.floor(min + Math.random() * (max - min + 1)));
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length) % arr.length];
}

/** Fisher-Yates on a copy. */
export function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** "$RUGS" from "RUGS", "$RUGS", " $rugs "; falls back to the default ticker. */
export function normTicker(raw: string | null | undefined): string {
  const s = (raw ?? '').replace(/\s+/g, '').replace(/^\$+/, '');
  return s ? `$${s}` : DEFAULT_TICKER;
}
