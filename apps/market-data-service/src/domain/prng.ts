/**
 * Gerador pseudoaleatório semeado (ADR-0009, RN-SYN-002): `Math.random` é proibido no domínio. A
 * semente é um texto (ex.: `local|<instrument_id>|2026-10-16`) e o estado cabe em quatro inteiros
 * de 32 bits, que vão para o banco junto com o estado do preço de referência. Mesma semente e
 * mesma sequência de chamadas dão sempre os mesmos números.
 */
export type PrngState = readonly [number, number, number, number];

/** cyrb128: espalha o texto da semente nos quatro inteiros iniciais. */
export function seedState(seed: string): PrngState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32 (Small Fast Counter): rápido, período longo e estado pequeno. */
export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(state: PrngState) {
    [this.a, this.b, this.c, this.d] = state;
  }

  static fromSeed(seed: string): Prng {
    return new Prng(seedState(seed));
  }

  state(): PrngState {
    return [this.a, this.b, this.c, this.d];
  }

  /** Uniforme em [0, 1). */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Inteiro uniforme em [min, max] (inclusivo). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Normal padrão por Box–Muller (consome sempre dois uniformes: a sequência fica estável). */
  gaussian(): number {
    const u1 = 1 - this.next();
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
