import type { BusinessDate, Instant } from '@broker/domain-kernel';
import type { Disposition } from '../domain/acceptance.js';
import type { BudgetLevel, ProviderUsage } from '../domain/budget.js';
import type { ExternalQuote, QuoteWarning } from '../domain/quote.js';
import type { ReferenceState } from '../domain/reference-price.js';
import type { CatalogEntry, DailyCandle } from './provider.js';

/** Cópia local do instrumento (`instrument.*` do reference-data-service). */
export interface InstrumentRef {
  instrumentId: string;
  symbol: string;
  tickSize: string;
  tradable: boolean;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELISTED';
}

/** Última leitura aceita por símbolo (`external_quote`). */
export interface StoredQuote {
  symbol: string;
  instrumentId: string | null;
  kind: 'INSTRUMENT' | 'INDEX';
  quote: ExternalQuote;
  fetchedAt: Instant;
  provider: string;
  rawSha256: string;
  stale: boolean;
  staleSince: Instant | null;
}

export interface HistoryRow {
  id: string;
  symbol: string;
  instrumentId: string | null;
  provider: string;
  fetchedAt: Instant;
  quoteTime: Instant;
  quote: ExternalQuote;
  rawSha256: string;
  disposition: Disposition;
  warnings: QuoteWarning[];
}

export interface QuarantineRow {
  symbol: string;
  price: string;
  quoteTime: Instant;
  since: Instant;
  jumpPct: string;
}

export interface ScheduleRow {
  symbol: string;
  nextReadAt: Instant;
  unchangedRetries: number;
  lastQuoteTime: Instant | null;
}

export interface UsageRow {
  usage: ProviderUsage | null;
  usageReadAt: Instant | null;
  sentSinceUsage: number;
  quotaExhausted: boolean;
  level: BudgetLevel;
  /** Impressão digital do token recusado com `401` (para até ele mudar, Brapi §10). */
  authBlockedToken: string | null;
}

export type AlertKind =
  | 'UNAUTHORIZED'
  | 'QUOTA_EXHAUSTED'
  | 'BUDGET_LEVEL'
  | 'QUOTE_QUARANTINED'
  | 'DEPRECATION'
  | 'SCHEMA_DRIFT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'INVALID_BODY'
  | 'BAD_REQUEST';

/** Alerta ao backoffice (Brapi §11): gravado, logado e, adiante, entregue pelo notification. */
export interface ProviderAlert {
  id: string;
  kind: AlertKind;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  data: Record<string, unknown>;
  createdAt: Instant;
}

export interface ManualOverrideRow {
  id: string;
  instrumentId: string;
  price: string;
  validFrom: Instant;
  validUntil: Instant;
  createdBy: string;
  reason: string;
  createdAt: Instant;
}

export interface JobRow {
  id: string;
  routineName: string;
  businessDate: BusinessDate;
  executionId: string;
  status: 'PENDING' | 'DONE' | 'FAILED';
}

/** Eventos que o serviço publica pela outbox (Catálogo de eventos §5). */
export type MarketDataEvent =
  | { type: 'market_data.external_quote_received'; payload: Record<string, unknown> }
  | {
      type: 'market_data.provider_budget_level_changed';
      payload: { from: string; to: string; remaining: number; projectedExhaustion: string | null };
    }
  | {
      type: 'market_data.instrument_stale';
      payload: { instrumentId: string; staleSince: string };
    }
  | {
      type: 'market_data.catalog_synced';
      payload: { newSymbols: CatalogEntry[]; inactiveSymbols: string[]; syncedAt: string };
    }
  | {
      type: 'market_data.symbol_rename_detected';
      payload: {
        oldSymbol: string;
        newSymbol: string;
        effectiveDate: string;
        conversionRatio?: string;
      };
    }
  | {
      type: 'market_data.reference_price_updated';
      payload: {
        instrumentId: string;
        seq: number;
        price: string;
        origin: string;
        anchorPrice: string;
        externalQuoteTime: string | null;
        at: string;
      };
    }
  | {
      type: 'routine.completed' | 'routine.failed';
      payload: {
        routineName: string;
        businessDate: string;
        executionId: string;
        stats?: Record<string, unknown>;
        reason?: string;
      };
    };

/** Unidade de trabalho: tudo numa transação do banco do serviço, com a outbox. */
export interface MarketDataTx {
  instrument(id: string): Promise<InstrumentRef | null>;
  instrumentBySymbol(symbol: string): Promise<InstrumentRef | null>;
  upsertInstrument(i: InstrumentRef): Promise<void>;
  tradableInstruments(): Promise<InstrumentRef[]>;

  catalogSymbols(): Promise<Map<string, boolean>>;
  upsertCatalog(entries: readonly CatalogEntry[], at: Instant): Promise<void>;
  deactivateCatalog(symbols: readonly string[], at: Instant): Promise<void>;
  /** `false` se a renomeação já tinha sido publicada. */
  markRenameSeen(oldSymbol: string, newSymbol: string): Promise<boolean>;

  quote(symbol: string, opts?: { forUpdate?: boolean }): Promise<StoredQuote | null>;
  quotes(): Promise<StoredQuote[]>;
  saveQuote(q: StoredQuote): Promise<void>;
  markStale(symbol: string, since: Instant): Promise<void>;
  insertHistory(h: HistoryRow): Promise<void>;
  /** Replay (RN-BRP-060): a última leitura real aceita com `quote_time ≤ at`. */
  replayReading(symbol: string, at: Instant): Promise<HistoryRow | null>;
  quarantine(symbol: string): Promise<QuarantineRow | null>;
  saveQuarantine(q: QuarantineRow): Promise<void>;
  clearQuarantine(symbol: string): Promise<void>;

  schedules(): Promise<ScheduleRow[]>;
  saveSchedule(s: ScheduleRow): Promise<void>;

  upsertCandles(
    symbol: string,
    candles: readonly DailyCandle[],
    source: 'HISTORY' | 'CLOSE_SNAPSHOT',
  ): Promise<void>;
  candles(
    symbol: string,
    from?: BusinessDate,
    to?: BusinessDate,
  ): Promise<(DailyCandle & { source: string })[]>;
  historyFetchedAt(symbol: string): Promise<Instant | null>;
  markHistoryFetched(symbol: string, at: Instant): Promise<void>;

  usage(opts?: { forUpdate?: boolean }): Promise<UsageRow>;
  saveUsage(u: UsageRow): Promise<void>;
  capabilityUnavailableUntil(capability: string): Promise<Instant | null>;
  markCapabilityUnavailable(capability: string, until: Instant, reason: string): Promise<void>;

  insertAlert(a: ProviderAlert): Promise<void>;
  alerts(limit: number): Promise<ProviderAlert[]>;

  referenceState(
    instrumentId: string,
    opts?: { forUpdate?: boolean },
  ): Promise<ReferenceState | null>;
  saveReferenceState(s: ReferenceState): Promise<void>;
  overrides(instrumentId: string, from: Instant, to: Instant): Promise<ManualOverrideRow[]>;
  insertOverride(o: ManualOverrideRow): Promise<void>;
  noiseEnabled(instrumentId: string): Promise<boolean | null>;
  setNoise(instrumentId: string, enabled: boolean, by: string, at: Instant): Promise<void>;

  enqueueJob(j: JobRow): Promise<void>;
  pendingJobs(limit: number): Promise<JobRow[]>;
  finishJob(id: string, status: 'DONE' | 'FAILED'): Promise<void>;
  /** `false` se o job periódico já rodou no período (ex.: semana ISO). */
  claimPeriodicRun(job: string, period: string, at: Instant): Promise<boolean>;
  releasePeriodicRun(job: string, period: string): Promise<void>;

  publish(event: MarketDataEvent, partitionKey: string): Promise<void>;
}

export interface MarketDataStore {
  transaction<T>(fn: (tx: MarketDataTx) => Promise<T>): Promise<T>;
}

/** Cache da brapi no Valkey (D16, Brapi §7): resposta normalizada por chave, com validade. */
export interface ProviderCache {
  get<T>(key: string): Promise<{ value: T; storedAt: Instant } | null>;
  set(key: string, value: unknown, storedAt: Instant, ttlMs: number): Promise<void>;
}

/** Corpo bruto por 30 dias no bucket `brapi-raw` (RN-BRP-061), para depurar o adaptador. */
export interface RawStorage {
  put(key: string, body: string): Promise<void>;
}

/**
 * Instrumentos com posição ou ordem aberta (P0, RN-BRP-042). OMS e custódia chegam nas Fases 2–3;
 * até lá, ninguém tem posição e todo o universo fica em P1.
 */
export interface ExposurePort {
  exposedInstruments(): Promise<ReadonlySet<string>>;
}

/** Evento corporativo conhecido para o instrumento (o salto não vai para a quarentena, RN-BRP-071). */
export interface CorporateActionsPort {
  knownActionOn(instrumentId: string, date: BusinessDate): Promise<boolean>;
}
