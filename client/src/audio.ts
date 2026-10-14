// WebAudio synthesizer: every SoundName is generated procedurally (no audio files).
// The AudioContext is created and resumed on the first user gesture (browser autoplay policy).

import type { AudioApi, SoundName } from './context';

const MUTE_KEY = 'amongrugs.muted';
const MASTER_VOLUME = 0.55;
/** Ignore repeats of the same sound closer together than this (ms). */
const MIN_REPEAT_MS = 40;

type Wave = OscillatorType;

interface ToneOpts {
  type: Wave;
  freq: number;
  /** Exponential glide target. */
  freqEnd?: number;
  start: number;
  dur: number;
  gain: number;
  attack?: number;
  /** Fraction of `dur` spent at full gain before the exponential decay. */
  hold?: number;
  detune?: number;
  filter?: { type: BiquadFilterType; freq: number; freqEnd?: number; q?: number };
  out?: AudioNode;
}

interface NoiseOpts {
  start: number;
  dur: number;
  gain: number;
  filter: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  attack?: number;
  out?: AudioNode;
}

function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(m: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

export function createAudio(): AudioApi {
  let ac: AudioContext | null = null;
  let master: GainNode | null = null;
  let bus: AudioNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let distCurve: Float32Array<ArrayBuffer> | null = null;
  let muted = loadMuted();
  const lastPlayed = new Map<SoundName, number>();

  function ensureContext(): AudioContext | null {
    if (ac) return ac;
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ac = new Ctor();
    } catch {
      ac = null;
      return null;
    }
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    master = ac.createGain();
    master.gain.value = muted ? 0 : MASTER_VOLUME;
    master.connect(comp);
    comp.connect(ac.destination);
    bus = master;
    // One second of white noise, reused by every noisy sound.
    const len = ac.sampleRate;
    noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    distCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      distCurve[i] = Math.tanh(x * 3.2);
    }
    return ac;
  }

  function unlock(): void {
    const a = ensureContext();
    if (!a) return;
    if (a.state !== 'running') {
      a.resume().catch(() => {
        /* will retry on the next gesture */
      });
      // iOS: playing a silent buffer inside the gesture fully unlocks output.
      try {
        const b = a.createBuffer(1, 1, 22050);
        const s = a.createBufferSource();
        s.buffer = b;
        s.connect(a.destination);
        s.start(0);
      } catch {
        /* ignore */
      }
    }
  }

  for (const ev of ['pointerdown', 'keydown', 'touchend', 'click'] as const) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  }

  // ---------- building blocks ----------

  function tone(a: AudioContext, o: ToneOpts): void {
    const out = o.out ?? bus;
    if (!out) return;
    const osc = a.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.freq, o.start);
    if (o.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), o.start + o.dur);
    if (o.detune) osc.detune.value = o.detune;
    const g = a.createGain();
    const attack = o.attack ?? 0.005;
    const holdEnd = o.start + attack + Math.max(0, (o.dur - attack) * (o.hold ?? 0));
    g.gain.setValueAtTime(0.0001, o.start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), o.start + attack);
    g.gain.setValueAtTime(Math.max(0.0002, o.gain), holdEnd);
    g.gain.exponentialRampToValueAtTime(0.0001, o.start + o.dur);
    let node: AudioNode = osc;
    if (o.filter) {
      const f = a.createBiquadFilter();
      f.type = o.filter.type;
      f.frequency.setValueAtTime(o.filter.freq, o.start);
      if (o.filter.freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(10, o.filter.freqEnd), o.start + o.dur);
      f.Q.value = o.filter.q ?? 0.7;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(out);
    osc.start(o.start);
    osc.stop(o.start + o.dur + 0.05);
  }

  function noise(a: AudioContext, o: NoiseOpts): void {
    const out = o.out ?? bus;
    if (!out || !noiseBuf) return;
    const src = a.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = a.createBiquadFilter();
    f.type = o.filter;
    f.frequency.setValueAtTime(o.freq, o.start);
    if (o.freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(10, o.freqEnd), o.start + o.dur);
    f.Q.value = o.q ?? 1;
    const g = a.createGain();
    const attack = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, o.start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), o.start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, o.start + o.dur);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(o.start, Math.random() * 0.5);
    src.stop(o.start + o.dur + 0.05);
  }

  /** A short-lived distortion bus for gritty sounds. */
  function grit(a: AudioContext, start: number, dur: number, amount: number): AudioNode | null {
    if (!bus || !distCurve) return null;
    const shaper = a.createWaveShaper();
    shaper.curve = distCurve;
    shaper.oversample = '2x';
    const g = a.createGain();
    g.gain.value = amount;
    shaper.connect(g);
    g.connect(bus);
    // Disconnect after use so the graph doesn't grow.
    window.setTimeout(() => {
      try {
        shaper.disconnect();
        g.disconnect();
      } catch {
        /* ignore */
      }
    }, (start - a.currentTime + dur + 0.5) * 1000);
    return shaper;
  }

  const NOTE = (semitonesFromA4: number) => 440 * Math.pow(2, semitonesFromA4 / 12);

  // ---------- the sounds ----------

  const synth: Record<SoundName, (a: AudioContext, t: number) => void> = {
    click(a, t) {
      tone(a, { type: 'square', freq: 1500, freqEnd: 900, start: t, dur: 0.045, gain: 0.07, filter: { type: 'lowpass', freq: 4000 } });
      noise(a, { start: t, dur: 0.02, gain: 0.05, filter: 'highpass', freq: 5000 });
    },

    taskDone(a, t) {
      const notes = [NOTE(15), NOTE(19), NOTE(22), NOTE(27)]; // C6 E6 G6 C7
      notes.forEach((f, i) => {
        const s = t + i * 0.075;
        tone(a, { type: 'sine', freq: f, start: s, dur: 0.55, gain: 0.16, attack: 0.004 });
        tone(a, { type: 'triangle', freq: f * 2, start: s, dur: 0.25, gain: 0.04, attack: 0.004 });
      });
      noise(a, { start: t + 0.2, dur: 0.4, gain: 0.025, filter: 'highpass', freq: 9000 });
    },

    kill(a, t) {
      const g = grit(a, t, 0.6, 0.55);
      // Dissonant stab chord.
      for (const f of [NOTE(-10), NOTE(-9), NOTE(-4)]) {
        tone(a, { type: 'sawtooth', freq: f * 2, freqEnd: f * 1.2, start: t, dur: 0.42, gain: 0.12, out: g ?? undefined, filter: { type: 'lowpass', freq: 3200, freqEnd: 500 } });
      }
      // Body thump + slash.
      tone(a, { type: 'sine', freq: 160, freqEnd: 40, start: t, dur: 0.35, gain: 0.5 });
      noise(a, { start: t, dur: 0.22, gain: 0.35, filter: 'bandpass', freq: 3500, freqEnd: 400, q: 1.4 });
    },

    meeting(a, t) {
      // Two-tone siren followed by a swelling "on air" pad.
      for (let i = 0; i < 6; i++) {
        const f = i % 2 === 0 ? 880 : 660;
        tone(a, { type: 'square', freq: f, start: t + i * 0.13, dur: 0.12, gain: 0.09, hold: 0.6, filter: { type: 'lowpass', freq: 2600 } });
      }
      const s = t + 0.8;
      for (const f of [NOTE(-9), NOTE(-5), NOTE(-2)]) {
        tone(a, { type: 'triangle', freq: f, start: s, dur: 0.9, gain: 0.09, attack: 0.25, hold: 0.2 });
      }
      noise(a, { start: t, dur: 0.12, gain: 0.08, filter: 'highpass', freq: 3000 });
    },

    vote(a, t) {
      tone(a, { type: 'sine', freq: 660, freqEnd: 990, start: t, dur: 0.09, gain: 0.18 });
      tone(a, { type: 'triangle', freq: 1320, start: t + 0.05, dur: 0.12, gain: 0.07 });
    },

    eject(a, t) {
      noise(a, { start: t, dur: 1.5, gain: 0.32, filter: 'bandpass', freq: 3200, freqEnd: 180, q: 2.2, attack: 0.35 });
      tone(a, { type: 'sine', freq: 520, freqEnd: 70, start: t + 0.1, dur: 1.3, gain: 0.12, attack: 0.2 });
    },

    sabotage(a, t) {
      const g = grit(a, t, 1.0, 0.4);
      for (const d of [-14, 0, 14]) {
        tone(a, { type: 'sawtooth', freq: 440, freqEnd: 95, start: t, dur: 0.85, gain: 0.1, detune: d, out: g ?? undefined, filter: { type: 'lowpass', freq: 2600, freqEnd: 300, q: 4 } });
      }
      for (let i = 0; i < 4; i++) {
        tone(a, { type: 'square', freq: 1800 - i * 300, start: t + 0.05 + i * 0.06, dur: 0.04, gain: 0.05 });
      }
    },

    alarm(a, t) {
      tone(a, { type: 'square', freq: 988, start: t, dur: 0.13, gain: 0.08, hold: 0.7, filter: { type: 'lowpass', freq: 3000 } });
      tone(a, { type: 'square', freq: 988, start: t + 0.2, dur: 0.13, gain: 0.08, hold: 0.7, filter: { type: 'lowpass', freq: 3000 } });
      tone(a, { type: 'sine', freq: 494, start: t, dur: 0.33, gain: 0.05, hold: 0.5 });
    },

    win(a, t) {
      const seq = [NOTE(3), NOTE(7), NOTE(10), NOTE(15)]; // C5 E5 G5 C6
      seq.forEach((f, i) => {
        tone(a, { type: 'triangle', freq: f, start: t + i * 0.12, dur: 0.22, gain: 0.15 });
        tone(a, { type: 'square', freq: f, start: t + i * 0.12, dur: 0.12, gain: 0.035, filter: { type: 'lowpass', freq: 2500 } });
      });
      const s = t + 0.5;
      for (const f of [NOTE(15), NOTE(19), NOTE(22), NOTE(27)]) {
        tone(a, { type: 'triangle', freq: f, start: s, dur: 1.2, gain: 0.1, attack: 0.02, hold: 0.35 });
        tone(a, { type: 'sawtooth', freq: f, start: s, dur: 1.0, gain: 0.02, detune: 8, filter: { type: 'lowpass', freq: 3000 } });
      }
      noise(a, { start: s, dur: 0.9, gain: 0.03, filter: 'highpass', freq: 8000 });
    },

    lose(a, t) {
      const seq = [NOTE(-2), NOTE(-6), NOTE(-9)]; // G4 Eb4 C4
      seq.forEach((f, i) => {
        tone(a, { type: 'sawtooth', freq: f, start: t + i * 0.22, dur: 0.3, gain: 0.1, filter: { type: 'lowpass', freq: 1800 } });
      });
      const s = t + 0.66;
      tone(a, { type: 'sawtooth', freq: NOTE(-22), freqEnd: NOTE(-26), start: s, dur: 1.3, gain: 0.16, hold: 0.3, filter: { type: 'lowpass', freq: 900, freqEnd: 200 } });
      tone(a, { type: 'sine', freq: NOTE(-34), start: s, dur: 1.3, gain: 0.25, hold: 0.3 });
      noise(a, { start: s, dur: 0.8, gain: 0.08, filter: 'lowpass', freq: 600 });
    },

    vent(a, t) {
      tone(a, { type: 'sine', freq: 150, freqEnd: 45, start: t, dur: 0.2, gain: 0.45 });
      noise(a, { start: t, dur: 0.07, gain: 0.22, filter: 'bandpass', freq: 1300, q: 3 });
      tone(a, { type: 'square', freq: 2300, start: t, dur: 0.03, gain: 0.03 });
      tone(a, { type: 'sine', freq: 110, freqEnd: 50, start: t + 0.1, dur: 0.15, gain: 0.25 });
      noise(a, { start: t + 0.1, dur: 0.05, gain: 0.1, filter: 'bandpass', freq: 900, q: 3 });
    },

    reveal(a, t) {
      tone(a, { type: 'sine', freq: 80, freqEnd: 32, start: t, dur: 1.4, gain: 0.5, hold: 0.1 });
      noise(a, { start: t, dur: 0.8, gain: 0.18, filter: 'lowpass', freq: 500, freqEnd: 80 });
      tone(a, { type: 'triangle', freq: 300, freqEnd: 1200, start: t + 0.05, dur: 1.0, gain: 0.05, attack: 0.4 });
      for (const f of [NOTE(-21), NOTE(-14), NOTE(-9)]) {
        tone(a, { type: 'sawtooth', freq: f, start: t + 0.1, dur: 1.6, gain: 0.04, attack: 0.3, hold: 0.3, filter: { type: 'lowpass', freq: 1200 } });
      }
    },

    error(a, t) {
      tone(a, { type: 'square', freq: 196, start: t, dur: 0.09, gain: 0.09, hold: 0.6, filter: { type: 'lowpass', freq: 1400 } });
      tone(a, { type: 'square', freq: 147, start: t + 0.1, dur: 0.12, gain: 0.09, hold: 0.6, filter: { type: 'lowpass', freq: 1400 } });
    },
  };

  return {
    play(name: SoundName): void {
      if (muted) return;
      const a = ac;
      if (!a) return; // not unlocked by a gesture yet
      if (a.state !== 'running') {
        a.resume().catch(() => {
          /* ignore */
        });
        return;
      }
      const nowMs = performance.now();
      const last = lastPlayed.get(name) ?? -Infinity;
      if (nowMs - last < MIN_REPEAT_MS) return;
      lastPlayed.set(name, nowMs);
      try {
        synth[name](a, a.currentTime + 0.005);
      } catch {
        /* never let audio break the game */
      }
    },
    setMuted(m: boolean): void {
      muted = m;
      saveMuted(m);
      if (ac && master) {
        master.gain.cancelScheduledValues(ac.currentTime);
        master.gain.setTargetAtTime(m ? 0 : MASTER_VOLUME, ac.currentTime, 0.02);
      }
    },
    isMuted(): boolean {
      return muted;
    },
  };
}
