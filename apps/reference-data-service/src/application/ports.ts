import type { BusinessDate, Instant } from '@broker/domain-kernel';
import type { CalendarDay, StoredSchedule } from '../domain/calendar.js';
import type { ChangeRequest, ChangeRequestStatus } from '../domain/change-request.js';
import type { AssetType, Instrument, TypeDefaults } from '../domain/instrument.js';
import type { SymbolHistoryEntry } from '../domain/symbol-history.js';
import type { TradingRuleVersion } from '../domain/trading-rules.js';

/** Tarefa para o backoffice (renomeação a confirmar, calendário acabando, catálogo). */
export type TaskKind =
  'SYMBOL_RENAME_CONFIRMATION' | 'CALENDAR_COVERAGE_ENDING' | 'TRADABLE_REMOVED_FROM_CATALOG';
export type TaskStatus = 'OPEN' | 'DONE' | 'DISMISSED';

export interface BackofficeTask {
  id: string;
  kind: TaskKind;
  /** Chave de idempotência: a mesma situação não abre duas tarefas. */
  dedupeKey: string;
  instrumentId: string | null;
  data: Record<string, unknown>;
  status: TaskStatus;
  createdAt: Instant;
  resolvedBy: string | null;
  resolvedAt: Instant | null;
}

/** Eventos que o serviço publica pela outbox (Catálogo de eventos §4). */
export type ReferenceEvent =
  | { type: 'instrument.created' | 'instrument.updated'; payload: Record<string, unknown> }
  | {
      type: 'instrument.status_changed';
      payload: { instrumentId: string; symbol: string; from: string; to: string; reason: string };
    }
  | {
      type: 'instrument.tradability_changed';
      payload: {
        instrumentId: string;
        symbol: string;
        oddLotSymbol: string | null;
        lotSize: number;
        tradable: boolean;
        approvalRequestId: string;
      };
    }
  | {
      type: 'instrument.symbol_changed';
      payload: {
        instrumentId: string;
        oldSymbol: string;
        newSymbol: string;
        effectiveDate: string;
      };
    }
  | {
      type: 'instrument.trading_rules_changed';
      payload: {
        ruleId: string;
        instrumentId: string | null;
        rules: Record<string, unknown>;
        validFrom: string;
        approvalRequestId: string;
      };
    }
  | { type: 'calendar.updated'; payload: { from: string; to: string; calendar: object } }
  | {
      type: 'session_schedule.updated';
      payload: { from: string; to: string | null; calendar: object };
    }
  | {
      type: 'routine.completed';
      payload: {
        routineName: string;
        businessDate: string;
        executionId: string;
        stats?: Record<string, unknown>;
      };
    };

export interface InstrumentFilter {
  tradable?: boolean;
  status?: Instrument['status'];
  limit: number;
  /** Cursor: o último símbolo da página anterior. */
  after?: string;
}

/** Unidade de trabalho: tudo numa transação do banco do serviço, com a outbox. */
export interface ReferenceTx {
  instrument(id: string, opts?: { forUpdate?: boolean }): Promise<Instrument | null>;
  /** Instrumento com o ticker atual (o não deslistado, se houver dois). */
  instrumentBySymbol(symbol: string, opts?: { forUpdate?: boolean }): Promise<Instrument | null>;
  insertInstrument(i: Instrument): Promise<void>;
  saveInstrument(i: Instrument): Promise<void>;
  instruments(filter: InstrumentFilter): Promise<Instrument[]>;
  /** Busca por prefixo do ticker ou trecho do nome (RN-INS-010). */
  searchInstruments(text: string, limit: number): Promise<Instrument[]>;
  tradableCount(): Promise<number>;
  /** Trava o universo: serializa inclusões concorrentes contra o limite. */
  lockUniverse(): Promise<void>;
  /** Instrumentos com defasagem informada (para a suspensão automática). */
  staleInstruments(): Promise<Instrument[]>;

  typeDefaults(type: AssetType): Promise<TypeDefaults>;
  allTypeDefaults(): Promise<TypeDefaults[]>;
  saveTypeDefaults(d: TypeDefaults): Promise<void>;

  insertSymbolHistory(h: SymbolHistoryEntry): Promise<void>;
  /** Entradas do histórico com o ticker, da mais recente. */
  historyBySymbol(symbol: string): Promise<SymbolHistoryEntry[]>;
  historyOf(instrumentId: string): Promise<SymbolHistoryEntry[]>;

  insertChangeRequest(r: ChangeRequest): Promise<void>;
  changeRequest(id: string, opts?: { forUpdate?: boolean }): Promise<ChangeRequest | null>;
  changeRequests(status: ChangeRequestStatus | undefined, limit: number): Promise<ChangeRequest[]>;
  saveChangeRequest(r: ChangeRequest): Promise<void>;
  /** Pendentes vencidas, travadas para expirar. */
  duePendingRequests(now: Instant, limit: number): Promise<ChangeRequest[]>;
  /** Já existe solicitação pendente para o mesmo alvo e tipo? */
  pendingFor(type: ChangeRequest['type'], targetId: string): Promise<ChangeRequest | null>;

  /** `false` se já existia tarefa com a mesma `dedupeKey`. */
  insertTask(t: BackofficeTask): Promise<boolean>;
  task(id: string, opts?: { forUpdate?: boolean }): Promise<BackofficeTask | null>;
  tasks(status: TaskStatus | undefined, limit: number): Promise<BackofficeTask[]>;
  saveTask(t: BackofficeTask): Promise<void>;

  ruleVersions(instrumentId: string | null): Promise<TradingRuleVersion[]>;
  insertRuleVersion(v: TradingRuleVersion): Promise<void>;
  closeRuleVersion(id: string, validTo: Instant): Promise<void>;
  /** Trava o escopo das regras (global ou o instrumento) para a nova vigência. */
  lockRules(instrumentId: string | null): Promise<void>;

  calendarDays(): Promise<CalendarDay[]>;
  upsertCalendarDays(rows: readonly CalendarDay[]): Promise<void>;
  schedules(): Promise<StoredSchedule[]>;
  insertSchedule(s: StoredSchedule): Promise<void>;
  closeSchedule(id: string, validTo: string): Promise<void>;
  /** Versão do calendário (cresce a cada mudança); `lock` trava para alterar. */
  calendarVersion(opts?: { lock?: boolean }): Promise<number>;
  bumpCalendarVersion(): Promise<number>;

  publish(event: ReferenceEvent, partitionKey: string): Promise<void>;
}

export interface ReferenceStore {
  transaction<T>(fn: (tx: ReferenceTx) => Promise<T>): Promise<T>;
}

/**
 * Ordens abertas por instrumento, para recusar a retirada do universo (RN-INS-013). O OMS chega na
 * Fase 2; até lá o adaptador local responde zero.
 */
export interface OpenOrdersPort {
  openOrdersCount(instrumentId: string): Promise<number>;
}

/** Alerta ao backoffice (log, tarefa e, adiante, o notification-service). */
export interface BackofficeAlert {
  kind: TaskKind;
  message: string;
  data: Record<string, unknown>;
}

export type { BusinessDate };
