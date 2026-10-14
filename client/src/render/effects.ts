// Transient visual effects: rug slash, task sparkle, bridge hatch pops, rings, screen flash,
// screen shake, glitch, and the DEV DUMP red pulse with falling red candles.
// Particles live in fixed pools so nothing is allocated per frame.

import { COLORS, FONT_MONO, FONT_TITLE, rgba } from './palette';
import { clamp, TAU } from './util';

type G = CanvasRenderingContext2D;

const PK = { Spark: 0, Puff: 1, Shard: 2, Star: 3 } as const;
type PK = (typeof PK)[keyof typeof PK];

interface Particle {
  active: boolean;
  kind: PK;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  rot: number;
  vr: number;
  gravity: number;
  drag: number;
}

interface Candle {
  active: boolean;
  x: number;
  y: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  alpha: number;
  hollow: boolean;
}

type FxKind = 'slash' | 'sparkle' | 'hatch' | 'ring';

interface Fx {
  kind: FxKind;
  x: number;
  y: number;
  age: number;
  dur: number;
  color: string;
  text: string;
}

const MAX_PARTICLES = 360;
const MAX_CANDLES = 70;

export class Effects {
  private readonly parts: Particle[] = [];
  private readonly candles: Candle[] = [];
  private fx: Fx[] = [];
  private shakeMag = 0;
  private flashColor = '#ffffff';
  private flashAlpha = 0;
  private flashDecay = 2;
  private glitch = 0;
  private candleAcc = 0;
  /** 0..1, how strongly the DEV DUMP overlay is shown (eased). */
  dumpLevel = 0;
  readonly shake = { x: 0, y: 0 };

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.parts.push({ active: false, kind: PK.Spark, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1, color: '#fff', rot: 0, vr: 0, gravity: 0, drag: 0 });
    }
    for (let i = 0; i < MAX_CANDLES; i++) {
      this.candles.push({ active: false, x: 0, y: 0, vy: 0, w: 0, h: 0, rot: 0, vr: 0, alpha: 0, hollow: false });
    }
  }

  reset(): void {
    for (const p of this.parts) p.active = false;
    for (const c of this.candles) c.active = false;
    this.fx = [];
    this.shakeMag = 0;
    this.flashAlpha = 0;
    this.glitch = 0;
    this.dumpLevel = 0;
  }

  private spawn(kind: PK, x: number, y: number, vx: number, vy: number, life: number, size: number, color: string, gravity = 0, drag = 1.5): void {
    for (const p of this.parts) {
      if (p.active) continue;
      p.active = true;
      p.kind = kind;
      p.x = x;
      p.y = y;
      p.vx = vx;
      p.vy = vy;
      p.life = life;
      p.max = life;
      p.size = size;
      p.color = color;
      p.rot = Math.random() * TAU;
      p.vr = (Math.random() - 0.5) * 10;
      p.gravity = gravity;
      p.drag = drag;
      return;
    }
  }

  // ---------- triggers ----------

  addShake(mag: number): void {
    this.shakeMag = Math.max(this.shakeMag, mag);
  }

  flash(color: string, alpha: number, seconds: number): void {
    this.flashColor = color;
    this.flashAlpha = Math.max(this.flashAlpha, alpha);
    this.flashDecay = alpha / Math.max(0.05, seconds);
  }

  startGlitch(seconds: number): void {
    this.glitch = Math.max(this.glitch, seconds);
  }

  slash(x: number, y: number, strong: boolean): void {
    this.fx.push({ kind: 'slash', x, y, age: 0, dur: 1.3, color: COLORS.rug, text: '-99%' });
    for (let i = 0; i < (strong ? 26 : 16); i++) {
      const a = Math.random() * TAU;
      const sp = 80 + Math.random() * 260;
      this.spawn(PK.Shard, x, y - 10, Math.cos(a) * sp, Math.sin(a) * sp - 60, 0.6 + Math.random() * 0.5, 2 + Math.random() * 3.5, Math.random() < 0.7 ? COLORS.rug : '#ffffff', 380, 2.2);
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU;
      this.spawn(PK.Puff, x, y - 6, Math.cos(a) * 40, Math.sin(a) * 30, 0.5 + Math.random() * 0.3, 7 + Math.random() * 6, 'rgba(255,59,92,0.35)', 0, 3);
    }
    this.addShake(strong ? 11 : 5);
    if (strong) this.flash(COLORS.rug, 0.28, 0.35);
  }

  sparkle(x: number, y: number): void {
    this.fx.push({ kind: 'sparkle', x, y, age: 0, dur: 1.4, color: COLORS.pump, text: '+PUMP' });
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * TAU;
      const sp = 60 + Math.random() * 170;
      this.spawn(PK.Star, x, y, Math.cos(a) * sp, Math.sin(a) * sp - 40, 0.6 + Math.random() * 0.6, 2.5 + Math.random() * 3, Math.random() < 0.5 ? COLORS.pump : COLORS.gold, 120, 2.6);
    }
  }

  hatch(x: number, y: number): void {
    this.fx.push({ kind: 'hatch', x, y, age: 0, dur: 0.65, color: COLORS.sol, text: '' });
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const sp = 40 + Math.random() * 70;
      this.spawn(PK.Puff, x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.45 + Math.random() * 0.35, 5 + Math.random() * 6, Math.random() < 0.5 ? 'rgba(153,69,255,0.35)' : 'rgba(150,160,180,0.3)', -20, 3);
    }
  }

  ring(x: number, y: number, color: string): void {
    this.fx.push({ kind: 'ring', x, y, age: 0, dur: 0.9, color, text: '' });
  }

  // ---------- update + draw ----------

  update(dt: number, dumpActive: boolean): void {
    for (const p of this.parts) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy = p.vy * d + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    for (const f of this.fx) f.age += dt;
    if (this.fx.length && this.fx.some((f) => f.age >= f.dur)) this.fx = this.fx.filter((f) => f.age < f.dur);

    this.shakeMag *= Math.exp(-dt * 7);
    if (this.shakeMag < 0.05) this.shakeMag = 0;
    this.shake.x = (Math.random() * 2 - 1) * this.shakeMag;
    this.shake.y = (Math.random() * 2 - 1) * this.shakeMag;
    this.flashAlpha = Math.max(0, this.flashAlpha - this.flashDecay * dt);
    this.glitch = Math.max(0, this.glitch - dt);
    this.dumpLevel = clamp(this.dumpLevel + (dumpActive ? dt * 1.5 : -dt * 2), 0, 1);

    for (const c of this.candles) {
      if (!c.active) continue;
      c.y += c.vy * dt;
      c.rot += c.vr * dt;
      if (c.y > 2400) c.active = false;
    }
  }

  /** World-space effects. `g` has the world transform. */
  drawWorld(g: G): void {
    for (const p of this.parts) {
      if (!p.active) continue;
      const a = clamp(p.life / p.max, 0, 1);
      switch (p.kind) {
        case PK.Spark:
          g.fillStyle = p.color;
          g.globalAlpha = a;
          g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
          break;
        case PK.Puff:
          g.fillStyle = p.color;
          g.globalAlpha = a;
          g.beginPath();
          g.arc(p.x, p.y, p.size * (1.6 - a * 0.6), 0, TAU);
          g.fill();
          break;
        case PK.Shard:
          g.save();
          g.globalAlpha = a;
          g.translate(p.x, p.y);
          g.rotate(p.rot);
          g.fillStyle = p.color;
          g.beginPath();
          g.moveTo(-p.size, -p.size * 0.6);
          g.lineTo(p.size, 0);
          g.lineTo(-p.size * 0.4, p.size * 0.7);
          g.closePath();
          g.fill();
          g.restore();
          break;
        case PK.Star: {
          g.globalAlpha = a;
          g.fillStyle = p.color;
          const s = p.size * (0.6 + a * 0.4);
          g.fillRect(p.x - s, p.y - s * 0.22, s * 2, s * 0.44);
          g.fillRect(p.x - s * 0.22, p.y - s, s * 0.44, s * 2);
          break;
        }
      }
    }
    g.globalAlpha = 1;

    for (const f of this.fx) {
      const p = f.age / f.dur;
      switch (f.kind) {
        case 'slash':
          this.drawSlash(g, f, p);
          break;
        case 'sparkle':
          this.drawSparkle(g, f, p);
          break;
        case 'hatch':
          this.drawHatch(g, f, p);
          break;
        case 'ring': {
          g.strokeStyle = rgba(f.color, 0.8 * (1 - p));
          g.lineWidth = 4 * (1 - p) + 1;
          g.beginPath();
          g.arc(f.x, f.y, 14 + p * 70, 0, TAU);
          g.stroke();
          break;
        }
      }
    }
  }

  private drawSlash(g: G, f: Fx, p: number): void {
    const t = f.age;
    // Burst glow.
    if (t < 0.35) {
      const a = 1 - t / 0.35;
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = rgba(COLORS.rug, 0.45 * a);
      g.beginPath();
      g.arc(f.x, f.y - 10, 30 + t * 120, 0, TAU);
      g.fill();
      g.restore();
    }
    // Three claw slashes drawn in quickly, then fading.
    const draw = clamp(t / 0.16, 0, 1);
    const fade = t < 0.5 ? 1 : clamp(1 - (t - 0.5) / 0.4, 0, 1);
    if (fade > 0) {
      g.save();
      g.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const off = (i - 1) * 13;
        const x0 = f.x + 26 + off;
        const y0 = f.y - 42 + off * 0.3;
        const x1 = f.x - 26 + off;
        const y1 = f.y + 18 + off * 0.3;
        const k = clamp(draw * 1.4 - i * 0.2, 0, 1);
        if (k <= 0) continue;
        const ex = x0 + (x1 - x0) * k;
        const ey = y0 + (y1 - y0) * k;
        g.strokeStyle = rgba(COLORS.rug, 0.9 * fade);
        g.lineWidth = 7;
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(ex, ey);
        g.stroke();
        g.strokeStyle = rgba('#ffffff', 0.95 * fade);
        g.lineWidth = 2.2;
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(ex, ey);
        g.stroke();
      }
      g.restore();
    }
    // "-99%" pops and floats up.
    if (t > 0.12) {
      const tt = t - 0.12;
      const a = clamp(1 - (p - 0.55) / 0.45, 0, 1);
      const pop = tt < 0.15 ? 0.6 + (tt / 0.15) * 0.6 : 1.2 - Math.min(0.2, (tt - 0.15) * 0.8);
      g.save();
      g.translate(f.x, f.y - 52 - tt * 28);
      g.scale(pop, pop);
      g.rotate(-0.08);
      g.globalAlpha = a;
      g.font = `20px ${FONT_TITLE}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 5;
      g.lineJoin = 'round';
      g.strokeStyle = '#1a0006';
      g.strokeText(f.text, 0, 0);
      g.fillStyle = COLORS.rug;
      g.fillText(f.text, 0, 0);
      g.restore();
    }
  }

  private drawSparkle(g: G, f: Fx, p: number): void {
    const t = f.age;
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = rgba(COLORS.pump, 0.85 * (1 - p));
    g.lineWidth = 3 * (1 - p) + 1;
    g.beginPath();
    g.arc(f.x, f.y, 16 + p * 60, 0, TAU);
    g.stroke();
    g.strokeStyle = rgba(COLORS.gold, 0.6 * (1 - p));
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(f.x, f.y, 8 + p * 36, 0, TAU);
    g.stroke();
    g.restore();
    const a = clamp(1 - (p - 0.5) / 0.5, 0, 1);
    g.save();
    g.globalAlpha = a;
    g.translate(f.x, f.y - 34 - t * 26);
    const s = t < 0.15 ? 0.7 + (t / 0.15) * 0.4 : 1.1;
    g.scale(s, s);
    g.font = `700 15px ${FONT_MONO}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 4;
    g.lineJoin = 'round';
    g.strokeStyle = '#03140a';
    g.strokeText(f.text, 0, 0);
    g.fillStyle = COLORS.pump;
    g.fillText(f.text, 0, 0);
    g.restore();
  }

  private drawHatch(g: G, f: Fx, p: number): void {
    // Lid flips up and drops back; a glowing hole underneath.
    const lift = Math.sin(Math.min(1, p) * Math.PI);
    g.save();
    g.translate(f.x, f.y);
    g.fillStyle = rgba(COLORS.sol, 0.35 * lift);
    g.beginPath();
    g.ellipse(0, 0, 22, 15, 0, 0, TAU);
    g.fill();
    g.fillStyle = '#020305';
    g.fillRect(-16, -11, 32, 22);
    g.translate(0, -lift * 16);
    g.rotate(-lift * 0.35);
    g.fillStyle = '#1d2534';
    g.fillRect(-18, -12, 36, 24);
    g.strokeStyle = rgba(COLORS.sol, 0.9);
    g.lineWidth = 2;
    g.strokeRect(-18, -12, 36, 24);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < 4; i++) g.fillRect(-15, -9 + i * 5.2, 30, 1.6);
    g.restore();
  }

  /** Screen-space overlays. `g` has the DPR-only transform; (w, h) are CSS pixels. */
  drawScreen(g: G, w: number, h: number, t: number, dt: number, vignette: CanvasGradient | null, dumpUrgency: number): void {
    // DEV DUMP: red pulse + falling red candles.
    if (this.dumpLevel > 0.001) {
      const speed = 2.2 + dumpUrgency * 4;
      const pulse = 0.55 + 0.45 * Math.sin(t * speed);
      if (vignette) {
        g.globalAlpha = this.dumpLevel * (0.55 + 0.45 * pulse);
        g.fillStyle = vignette;
        g.fillRect(0, 0, w, h);
        g.globalAlpha = 1;
      }
      if (this.dumpLevel > 0.5) {
        this.candleAcc += dt * (5 + dumpUrgency * 8) * (w / 1200 + 0.5);
        while (this.candleAcc >= 1) {
          this.candleAcc -= 1;
          this.spawnCandle(w);
        }
      }
    }
    let anyCandle = false;
    for (const c of this.candles) {
      if (!c.active) continue;
      if (c.y - c.h > h + 40 || this.dumpLevel <= 0.001) {
        c.active = false;
        continue;
      }
      anyCandle = true;
      g.save();
      g.translate(c.x, c.y);
      g.rotate(c.rot);
      g.globalAlpha = c.alpha * this.dumpLevel;
      g.fillStyle = COLORS.rug;
      g.fillRect(-0.75, -c.h / 2 - c.h * 0.35, 1.5, c.h * 1.7);
      if (c.hollow) {
        g.strokeStyle = COLORS.rug;
        g.lineWidth = 2;
        g.strokeRect(-c.w / 2, -c.h / 2, c.w, c.h);
      } else {
        g.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      }
      g.restore();
    }
    if (!anyCandle) this.candleAcc = Math.min(this.candleAcc, 1);

    // Glitch (RPC DOWN start).
    if (this.glitch > 0) {
      const a = clamp(this.glitch / 0.6, 0, 1);
      for (let i = 0; i < 7; i++) {
        const y = Math.random() * h;
        const bh = 2 + Math.random() * 18;
        g.fillStyle = i % 2 ? rgba('#22e5ff', 0.12 * a) : rgba(COLORS.rug, 0.1 * a);
        g.fillRect(0, y, w, bh);
      }
      g.fillStyle = `rgba(0,0,0,${0.18 * a})`;
      for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 1);
    }

    // Flash.
    if (this.flashAlpha > 0.001) {
      g.fillStyle = rgba(this.flashColor, this.flashAlpha);
      g.fillRect(0, 0, w, h);
    }
  }

  private spawnCandle(w: number): void {
    for (const c of this.candles) {
      if (c.active) continue;
      c.active = true;
      c.x = Math.random() * w;
      c.h = 18 + Math.random() * 44;
      c.w = 6 + Math.random() * 7;
      c.y = -c.h - 20;
      c.vy = 150 + Math.random() * 230;
      c.rot = (Math.random() - 0.5) * 0.5;
      c.vr = (Math.random() - 0.5) * 1.2;
      c.alpha = 0.25 + Math.random() * 0.45;
      c.hollow = Math.random() < 0.25;
      return;
    }
  }
}
