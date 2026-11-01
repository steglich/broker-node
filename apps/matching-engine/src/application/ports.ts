import type { EngineSnapshot } from '../domain/engine.js';
import type { EngineCommand, EngineInput } from '../domain/inputs.js';
import type { Board } from '../domain/book.js';

/** Entrada pronta para o journal: a `EngineInput` e a origem dela. */
export interface JournalEntry {
  instrumentId: string;
  input: EngineInput;
  /** `eventId` do comando; `null` nas entradas geradas pelo próprio sequenciador. */
  commandId: string | null;
  correlationId: string;
}

export interface OutputRow {
  instrumentId: string;
  board: Board;
  engineSeq: number;
  inputSeq: number;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: number;
  causationId: string | null;
  correlationId: string;
}

export interface DeadCommand {
  id: string;
  offset: bigint;
  raw: string;
  error: string;
}

export interface AppendBatch {
  partition: number;
  entries: readonly JournalEntry[];
  /** Offset a gravar na mesma transação; ausente nas entradas internas. */
  position?: { consumer: string; stream: string; offset: bigint };
  dead?: readonly DeadCommand[];
}

export interface StoredSnapshot {
  inputSeq: number;
  state: EngineSnapshot;
}

export interface OutputSummary {
  count: number;
  /** Cada saída gravada, na ordem de `engine_seq`, para comparar com um replay. */
  rows: readonly Pick<OutputRow, 'board' | 'engineSeq' | 'eventType' | 'payload'>[];
}

/** Persistência do Motor (D12). */
export interface EngineStore {
  instruments(partition: number): Promise<string[]>;
  allInstruments(): Promise<{ instrumentId: string; partition: number }[]>;
  latestSnapshot(instrumentId: string): Promise<StoredSnapshot | null>;
  /** Entradas depois de `afterSeq`, em ordem. */
  journalAfter(instrumentId: string, afterSeq: number, limit: number): Promise<JournalEntry[]>;
  /** Quais destes comandos já estão no journal. */
  knownCommands(instrumentIds: readonly string[], commandIds: readonly string[]): Promise<string[]>;
  /** RN-ME-003: grava o lote numa transação só, com `synchronous_commit = on`. */
  append(batch: AppendBatch): Promise<void>;
  /** Regravar uma saída é inócuo: quem já tem o `engine_seq` fica como está (RN-REC-002). */
  writeOutputs(rows: readonly OutputRow[]): Promise<void>;
  saveSnapshot(instrumentId: string, snapshot: EngineSnapshot, takenAt: number): Promise<void>;
  savedOffset(consumer: string, stream: string, partition: number): Promise<bigint | undefined>;
  /** Eventos de controle, fora de `engine_seq`: a recuperação não pode mudar as saídas. */
  publishRecovery(instrumentId: string): Promise<void>;
  outputsOf(instrumentId: string): Promise<OutputSummary>;
}

export type { EngineCommand };
