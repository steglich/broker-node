import type { Board } from './book.js';

/** FNV-1a de 32 bits: o suficiente para misturar o `instrument_id` nos IDs gerados. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const IdKind = { TRADE: 0, AUCTION: 1, EVENT: 2 } as const;
export type IdKind = (typeof IdKind)[keyof typeof IdKind];

const hex = (value: number, digits: number) => value.toString(16).padStart(digits, '0');

/**
 * UUID no formato v7 calculado só da entrada, sem acaso: o replay precisa regenerar os mesmos
 * `trade_id`, `auction_id` e `eventId` (RN-ME-002, RN-REC-002). O tempo vem na frente, como num v7
 * comum, e a unicidade vem do par (livro, `engine_seq`).
 */
export function deterministicId(
  ts: number,
  instrumentHash: number,
  board: Board,
  engineSeq: number,
  kind: IdKind,
): string {
  const time = hex(ts, 12);
  const randA = hex(instrumentHash >>> 20, 3);
  const mixed = ((instrumentHash & 0x7ffff) << 1) | (board === 'MAIN' ? 0 : 1);
  const tail = hex(mixed, 5) + hex(engineSeq % 2 ** 40, 10);
  const variant = (8 | kind).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${randA}-${variant}${tail.slice(0, 3)}-${tail.slice(3)}`;
}

/**
 * Atraso do encerramento aleatório, em ms dentro de `[0, maxMs]` (RN-AUC-033): uma rodada do
 * mulberry32 sobre a semente gravada no journal.
 */
export function randomEndOffset(seed: number, maxMs: number): number {
  if (maxMs <= 0) return 0;
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return Math.floor(unit * (maxMs + 1));
}
