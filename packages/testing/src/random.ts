/** Gerador pseudoaleatório com semente (mulberry32): mesma semente, mesma sequência. */
export interface SeededRandom {
  /** Número em [0, 1). */
  next(): number;
  /** Inteiro em [min, max]. */
  int(min: number, max: number): number;
}

export function seededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (min, max) => min + Math.floor(next() * (max - min + 1)) };
}
