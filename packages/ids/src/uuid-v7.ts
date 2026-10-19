import { randomFillSync } from 'node:crypto';

export interface UuidV7Options {
  /** Relógio em milissegundos Unix. Injetável para testes e relógio virtual (RN-CLK-001). */
  now?: () => number;
  /** Preenche o buffer com bytes aleatórios. Injetável para testes determinísticos. */
  randomFill?: (bytes: Uint8Array) => void;
}

export type UuidV7Generator = () => string;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * Gerador de UUID versão 7 (RFC 9562), gerado pela aplicação (RN-PAD-060).
 *
 * Layout: 48 bits de timestamp (ms) | versão 7 | 12 bits `rand_a` | variante 10 | 62 bits `rand_b`.
 * Monotonicidade (RFC 9562 §6.2, método 1): dentro do mesmo milissegundo, `rand_a` funciona como
 * contador de 12 bits, então IDs gerados em sequência pelo mesmo gerador são sempre crescentes na
 * ordem lexicográfica. Se o contador estourar, ou o relógio voltar, o timestamp avança 1 ms.
 */
export function createUuidV7Generator(options: UuidV7Options = {}): UuidV7Generator {
  const now = options.now ?? Date.now;
  const randomFill = options.randomFill ?? ((b: Uint8Array) => void randomFillSync(b));
  let lastMs = -1;
  let counter = 0;

  return () => {
    const bytes = new Uint8Array(16);
    randomFill(bytes);

    let ms = now();
    if (ms > lastMs) {
      // Novo milissegundo: o contador recomeça num valor aleatório da metade inferior (deixa folga).
      counter = ((bytes[6]! & 0x07) << 8) | bytes[7]!;
    } else {
      ms = lastMs;
      counter += 1;
      if (counter > 0xfff) {
        ms += 1;
        counter = 0;
      }
    }
    lastMs = ms;

    // 48 bits de timestamp, big-endian.
    let t = ms;
    for (let i = 5; i >= 0; i--) {
      bytes[i] = t % 256;
      t = Math.floor(t / 256);
    }
    bytes[6] = 0x70 | (counter >> 8);
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | (bytes[8]! & 0x3f);

    const h = Array.from(bytes, (b) => HEX[b]).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}

/** Gerador padrão do processo (relógio da máquina e `crypto`). */
export const uuidv7: UuidV7Generator = createUuidV7Generator();

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isUuidV7 = (value: string): boolean => UUID_V7.test(value);

/** Milissegundos Unix embutidos num UUID v7. */
export function uuidV7Timestamp(value: string): number {
  if (!isUuidV7(value)) throw new Error(`não é UUID v7: ${value}`);
  return parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
}
