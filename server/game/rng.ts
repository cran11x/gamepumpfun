// Small deterministic random helpers. The Room takes an injectable `rng: () => number` in [0, 1)
// so tests can seed it; production uses Math.random.

/** Mulberry32: tiny, fast, good-enough 32-bit seeded PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). Guards against rng() returning exactly 1 or garbage. */
export function randomIndex(rng: () => number, n: number): number {
  if (n <= 1) return 0;
  const r = rng();
  const safe = Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.9999999999) : 0;
  return Math.floor(safe * n);
}

/** In-place Fisher-Yates shuffle. Returns the same array for chaining. */
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIndex(rng, i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** `count` distinct items picked uniformly at random (fewer if the source is smaller). */
export function sample<T>(source: readonly T[], count: number, rng: () => number): T[] {
  return shuffle(source.slice(), rng).slice(0, Math.max(0, Math.min(count, source.length)));
}
