// Keyboard + virtual joystick input. Movement uses physical key codes (WASD / arrows work on
// any layout); action hotkeys: E/Space use, Q rug, R report, V bridge.

export type ActionKey = 'use' | 'kill' | 'report' | 'vent';

const MOVE_CODES: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

/** Fallback for browsers / virtual keyboards that don't report `code`. */
const MOVE_KEYS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  w: 'up',
  arrowup: 'up',
  s: 'down',
  arrowdown: 'down',
  a: 'left',
  arrowleft: 'left',
  d: 'right',
  arrowright: 'right',
};

const ACTION_CODES: Record<string, ActionKey> = {
  KeyE: 'use',
  Space: 'use',
  KeyQ: 'kill',
  KeyR: 'report',
  KeyV: 'vent',
};

const ACTION_KEYS: Record<string, ActionKey> = { e: 'use', ' ': 'use', q: 'kill', r: 'report', v: 'vent' };

const JOY_DEADZONE = 0.12;

export interface InputVector {
  /** Unit direction (or 0,0). */
  x: number;
  y: number;
  /** Speed factor in [0, 1]. */
  mag: number;
}

/** True when the user is typing into a text field (hotkeys and movement must not fire). */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(t);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

export class Input {
  private readonly held = new Set<'up' | 'down' | 'left' | 'right'>();
  private readonly codeDir = new Map<string, 'up' | 'down' | 'left' | 'right'>();
  private joyX = 0;
  private joyY = 0;
  /** Called on action hotkey presses (not repeats). The game decides whether to act. */
  onAction: ((a: ActionKey) => void) | null = null;
  /** Whether keys should be captured (preventDefault) right now. */
  isActive: () => boolean = () => false;
  /** Whether movement keys should register right now. */
  isBlocked: () => boolean = () => false;

  constructor() {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.clearKeys());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });
    document.addEventListener('focusin', (e) => {
      if (isTypingTarget(e.target as Element | null)) this.clearKeys();
    });
  }

  typing(): boolean {
    return isTypingTarget(document.activeElement);
  }

  private dirOf(e: KeyboardEvent): 'up' | 'down' | 'left' | 'right' | undefined {
    if (e.code && e.code !== 'Unidentified') return MOVE_CODES[e.code];
    return MOVE_KEYS[(e.key || '').toLowerCase()];
  }

  private actionOf(e: KeyboardEvent): ActionKey | undefined {
    if (e.code && e.code !== 'Unidentified') return ACTION_CODES[e.code];
    return ACTION_KEYS[(e.key || '').toLowerCase()];
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target as Element | null) || this.typing()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const dir = this.dirOf(e);
    const action = this.actionOf(e);
    const active = this.isActive();
    if (dir) {
      if (active) e.preventDefault();
      if (!this.isBlocked()) {
        this.held.add(dir);
        this.codeDir.set(e.code || e.key, dir);
      }
      return;
    }
    if (action) {
      // Space would also "click" a focused button; keep it for the game while in play.
      if (active) e.preventDefault();
      if (!e.repeat) this.onAction?.(action);
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    const id = e.code || e.key;
    const dir = this.codeDir.get(id) ?? this.dirOf(e);
    if (dir) {
      this.codeDir.delete(id);
      // Another key may still hold the same direction (e.g. W and ArrowUp).
      let still = false;
      for (const d of this.codeDir.values()) if (d === dir) still = true;
      if (!still) this.held.delete(dir);
    }
    if (this.isActive() && this.actionOf(e) === 'use' && (e.code === 'Space' || e.key === ' ') && !this.typing()) e.preventDefault();
  }

  clearKeys(): void {
    this.held.clear();
    this.codeDir.clear();
  }

  clear(): void {
    this.clearKeys();
    this.joyX = 0;
    this.joyY = 0;
  }

  setJoystick(x: number, y: number): void {
    this.joyX = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
    this.joyY = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
  }

  /** Combined keyboard + joystick movement vector. */
  read(out: InputVector): InputVector {
    let kx = 0;
    let ky = 0;
    if (this.held.has('left')) kx -= 1;
    if (this.held.has('right')) kx += 1;
    if (this.held.has('up')) ky -= 1;
    if (this.held.has('down')) ky += 1;
    let x = kx;
    let y = ky;
    const kl = Math.hypot(kx, ky);
    if (kl > 0) {
      x /= kl;
      y /= kl;
    }
    const jl = Math.hypot(this.joyX, this.joyY);
    if (jl > JOY_DEADZONE) {
      x += this.joyX;
      y += this.joyY;
    }
    const len = Math.hypot(x, y);
    if (len < 1e-6) {
      out.x = 0;
      out.y = 0;
      out.mag = 0;
      return out;
    }
    out.x = x / len;
    out.y = y / len;
    // Keyboard is always full speed; the joystick is analog (rescaled past the dead zone).
    out.mag = kl > 0 ? 1 : Math.min(1, (Math.min(1, len) - JOY_DEADZONE) / (1 - JOY_DEADZONE) + 0.15);
    return out;
  }
}
