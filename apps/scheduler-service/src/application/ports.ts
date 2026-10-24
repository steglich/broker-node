import type { BusinessDate, Instant } from '@broker/domain-kernel';
import type { ExecutionRecord, RoutineDefinition } from '../domain/routines.js';

export interface StoredExecution extends ExecutionRecord {
  executionId: string;
  attempt: number;
  scheduledFor: Instant;
  triggeredAt: Instant;
  completedAt: Instant | null;
  failureReason: string | null;
  catchUp: boolean;
}

export type ClockMode = 'REAL' | 'ACCELERATED' | 'VIRTUAL';

export interface StoredClock {
  mode: ClockMode;
  virtualNow: Instant;
  speedFactor: number;
}

/** Eventos que o agendador publica (via outbox, na transação do efeito). */
export type SchedulerEvent =
  | {
      type: 'routine.triggered';
      payload: {
        routineName: string;
        businessDate: string;
        executionId: string;
        attempt: number;
        scheduledFor: string;
        catchUp: boolean;
      };
    }
  | {
      type: 'clock.ticked';
      payload: { virtualNow: string; mode: 'ACCELERATED' | 'VIRTUAL'; speedFactor: number };
    };

/** Unidade de trabalho: tudo o que acontece numa transação do banco do agendador. */
export interface SchedulerTx {
  /**
   * Trava e lê o cursor do catch-up (primeira data com rotina por disparar). A trava serializa os
   * passos: mesmo dois "líderes" ao mesmo tempo não decidem sobre o mesmo estado (fencing pelo banco).
   */
  lockCursor(): Promise<BusinessDate | null>;
  setCursor(date: BusinessDate): Promise<void>;
  executionsFrom(date: BusinessDate): Promise<StoredExecution[]>;
  /** `false` se já existia execução para (rotina, data): a chave de idempotência (RN-ROT-001). */
  insertExecution(e: {
    routineName: string;
    businessDate: BusinessDate;
    executionId: string;
    scheduledFor: Instant;
    triggeredAt: Instant;
    catchUp: boolean;
  }): Promise<boolean>;
  /** Conclui ou falha a execução, só se o `executionId` for o da tentativa atual. */
  finish(e: {
    routineName: string;
    businessDate: BusinessDate;
    executionId: string;
    status: 'COMPLETED' | 'FAILED';
    at: Instant;
    reason?: string;
  }): Promise<'UPDATED' | 'STALE' | 'UNKNOWN'>;
  /** Nova tentativa de uma execução `FAILED`; devolve a execução atualizada ou `null`. */
  retry(e: {
    routineName: string;
    businessDate: BusinessDate;
    executionId: string;
    at: Instant;
  }): Promise<StoredExecution | null>;
  loadClock(): Promise<StoredClock | null>;
  saveClock(clock: StoredClock): Promise<void>;
  publish(event: SchedulerEvent): Promise<void>;
}

export interface SchedulerStore {
  transaction<T>(fn: (tx: SchedulerTx) => Promise<T>): Promise<T>;
  definitions(): Promise<RoutineDefinition[]>;
  executions(filter: { from: BusinessDate; to: BusinessDate }): Promise<StoredExecution[]>;
}
