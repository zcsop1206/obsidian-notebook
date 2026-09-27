// A seeded pseudo-random generator (mulberry32) so tests and the fixture are reproducible.
import type { RandomSource } from '../src/format/ids';

export interface Seeded {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [a, b). */
  range(a: number, b: number): number;
  /** Fills bytes, for the id helpers. */
  bytes: RandomSource;
}

export function seeded(seed: number): Seeded {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    bytes: out => {
      for (let i = 0; i < out.length; i++) out[i] = Math.floor(next() * 256);
    },
  };
}
