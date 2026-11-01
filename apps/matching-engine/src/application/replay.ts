import { InstrumentEngine } from '../domain/engine.js';
import type { EngineStore } from './ports.js';

const PAGE = 5000;

/** JSON com chaves em ordem: o `jsonb` não guarda a ordem em que as chaves foram escritas. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

export interface ReplayReport {
  instrumentId: string;
  inputs: number;
  outputs: number;
  identical: boolean;
  firstDifference: string | null;
}

/**
 * Reprocessa o journal inteiro num Motor à parte e confere as saídas gravadas (ADR-0005, ferramenta
 * de replay). Só lê: é a forma de ver, em produção, se o determinismo de RN-ME-002 segue valendo.
 */
export async function replayAndCompare(
  store: EngineStore,
  instrumentId: string,
): Promise<ReplayReport> {
  const engine = new InstrumentEngine(instrumentId);
  const regenerated = new Map<string, string>();
  let inputs = 0;
  for (;;) {
    const page = await store.journalAfter(instrumentId, engine.inputSeq, PAGE);
    if (page.length === 0) break;
    for (const entry of page) {
      inputs++;
      for (const output of engine.process(entry.input))
        regenerated.set(
          `${output.board}#${output.engineSeq}`,
          canonical({ eventType: output.eventType, payload: output.payload }),
        );
    }
  }

  const stored = await store.outputsOf(instrumentId);
  let firstDifference: string | null = null;
  for (const row of stored.rows) {
    const key = `${row.board}#${row.engineSeq}`;
    const expected = canonical({ eventType: row.eventType, payload: row.payload });
    if (regenerated.get(key) !== expected) {
      firstDifference = key;
      break;
    }
    regenerated.delete(key);
  }
  // Sobrou algo: o replay gerou uma saída que não está gravada.
  firstDifference ??= regenerated.keys().next().value ?? null;
  return {
    instrumentId,
    inputs,
    outputs: stored.count,
    identical: firstDifference === null,
    firstDifference,
  };
}
