import { MarketDataCatalogSyncedV1 } from '@broker/contracts/events/market_data.catalog_synced/v1';
import { MarketDataExternalQuoteReceivedV1 } from '@broker/contracts/events/market_data.external_quote_received/v1';
import { MarketDataInstrumentStaleV1 } from '@broker/contracts/events/market_data.instrument_stale/v1';
import { MarketDataProviderBudgetLevelChangedV1 } from '@broker/contracts/events/market_data.provider_budget_level_changed/v1';
import { MarketDataReferencePriceUpdatedV1 } from '@broker/contracts/events/market_data.reference_price_updated/v1';
import { MarketDataSymbolRenameDetectedV1 } from '@broker/contracts/events/market_data.symbol_rename_detected/v1';
import { RoutineCompletedV1 } from '@broker/contracts/events/routine.completed/v1';
import { RoutineFailedV1 } from '@broker/contracts/events/routine.failed/v1';
import { BusinessDate, type Decimal, Instant } from '@broker/domain-kernel';
import type { EventDefinition, EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type {
  HistoryRow,
  InstrumentRef,
  JobRow,
  ManualOverrideRow,
  MarketDataEvent,
  MarketDataStore,
  MarketDataTx,
  ProviderAlert,
  StoredQuote,
  UsageRow,
} from '../application/ports.js';
import type { ProviderUsage } from '../domain/budget.js';
import type { ExternalQuote } from '../domain/quote.js';
import type { ReferenceState } from '../domain/reference-price.js';
import type { ReplaySource } from './replay-provider.js';

type Row = Record<string, unknown>;

const EVENTS: Record<MarketDataEvent['type'], EventDefinition> = {
  'market_data.external_quote_received': MarketDataExternalQuoteReceivedV1,
  'market_data.provider_budget_level_changed': MarketDataProviderBudgetLevelChangedV1,
  'market_data.instrument_stale': MarketDataInstrumentStaleV1,
  'market_data.catalog_synced': MarketDataCatalogSyncedV1,
  'market_data.symbol_rename_detected': MarketDataSymbolRenameDetectedV1,
  'market_data.reference_price_updated': MarketDataReferencePriceUpdatedV1,
  'routine.completed': RoutineCompletedV1,
  'routine.failed': RoutineFailedV1,
};
const ACTOR = { type: 'SYSTEM' as const, id: 'market-data-service' };

const inst = (v: unknown): Instant => Instant.ofEpochMillis((v as Date).getTime());
const instOrNull = (v: unknown): Instant | null => (v ? inst(v) : null);
const num = (v: unknown): string => (v as Decimal).toFixed();
const numOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : num(v));
const lock = (opts?: { forUpdate?: boolean }) => (opts?.forUpdate ? sql` FOR UPDATE` : sql``);

/** Cotação ↔ jsonb (instantes em texto). */
const quoteJson = (q: ExternalQuote) => JSON.stringify({ ...q, quoteTime: q.quoteTime.toString() });
const toQuote = (v: unknown): ExternalQuote => {
  const o = v as ExternalQuote & { quoteTime: string };
  return { ...o, quoteTime: Instant.parse(o.quoteTime) };
};

const toInstrument = (r: Row): InstrumentRef => ({
  instrumentId: r['instrument_id'] as string,
  symbol: r['symbol'] as string,
  tickSize: num(r['tick_size']),
  tradable: r['tradable'] as boolean,
  status: r['status'] as InstrumentRef['status'],
});

const toStored = (r: Row): StoredQuote => ({
  symbol: r['symbol'] as string,
  instrumentId: (r['instrument_id'] as string | null) ?? null,
  kind: r['kind'] as StoredQuote['kind'],
  quote: toQuote(r['data']),
  fetchedAt: inst(r['fetched_at']),
  provider: r['provider'] as string,
  rawSha256: r['raw_sha256'] as string,
  stale: r['stale'] as boolean,
  staleSince: instOrNull(r['stale_since']),
});

const toUsage = (v: unknown): ProviderUsage | null => {
  if (!v) return null;
  const u = v as Omit<ProviderUsage, 'window'> & {
    window: { type: ProviderUsage['window']['type']; start: string; end: string };
  };
  return {
    ...u,
    window: {
      type: u.window.type,
      start: Instant.parse(u.window.start),
      end: Instant.parse(u.window.end),
    },
  };
};

const toAlert = (r: Row): ProviderAlert => ({
  id: r['id'] as string,
  kind: r['kind'] as ProviderAlert['kind'],
  severity: r['severity'] as ProviderAlert['severity'],
  message: r['message'] as string,
  data: r['data'] as Record<string, unknown>,
  createdAt: inst(r['created_at']),
});

const toOverride = (r: Row): ManualOverrideRow => ({
  id: r['id'] as string,
  instrumentId: r['instrument_id'] as string,
  price: (r['price'] as Decimal).toFixed(4),
  validFrom: inst(r['valid_from']),
  validUntil: inst(r['valid_until']),
  createdBy: r['created_by'] as string,
  reason: r['reason'] as string,
  createdAt: inst(r['created_at']),
});

const toJob = (r: Row): JobRow => ({
  id: r['id'] as string,
  routineName: r['routine_name'] as string,
  businessDate: BusinessDate.parse(r['business_date'] as string),
  executionId: r['execution_id'] as string,
  status: r['status'] as JobRow['status'],
});

/** Persistência do market-data (Kysely + pg) com a outbox na mesma transação. */
export class PostgresMarketDataStore implements MarketDataStore, ReplaySource {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: MarketDataTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  /** Replay (RN-BRP-060): a última leitura real aceita até o instante. */
  async readingAt(symbol: string, at: Instant): Promise<ExternalQuote | null> {
    return (await this.transaction((tx) => tx.replayReading(symbol, at)))?.quote ?? null;
  }

  /** Unidade de trabalho sobre uma transação já aberta (ex.: a do consumidor, com a inbox). */
  tx(trx: Kysely<unknown>): MarketDataTx {
    const publisher = this.publisher;
    const one = async <T>(q: RawBuilder<Row>, map: (r: Row) => T): Promise<T | null> => {
      const row = (await q.execute(trx)).rows[0];
      return row ? map(row) : null;
    };
    const many = async <T>(q: RawBuilder<Row>, map: (r: Row) => T): Promise<T[]> =>
      (await q.execute(trx)).rows.map(map);

    return {
      // ------------------------------------------------------------ instrumentos e catálogo
      instrument: (id) =>
        one(sql<Row>`SELECT * FROM instrument_ref WHERE instrument_id = ${id}`, toInstrument),
      instrumentBySymbol: (symbol) =>
        one(
          sql<Row>`SELECT * FROM instrument_ref WHERE symbol = ${symbol}
                   ORDER BY (status = 'DELISTED'), updated_at DESC LIMIT 1`,
          toInstrument,
        ),
      async upsertInstrument(i) {
        await sql`
          INSERT INTO instrument_ref (instrument_id, symbol, tick_size, tradable, status, updated_at)
          VALUES (${i.instrumentId}, ${i.symbol}, ${i.tickSize}, ${i.tradable}, ${i.status}, now())
          ON CONFLICT (instrument_id) DO UPDATE SET symbol = EXCLUDED.symbol, tick_size = EXCLUDED.tick_size,
            tradable = EXCLUDED.tradable, status = EXCLUDED.status, updated_at = now()`.execute(
          trx,
        );
      },
      tradableInstruments: () =>
        many(
          sql<Row>`SELECT * FROM instrument_ref WHERE tradable AND status <> 'DELISTED' ORDER BY symbol`,
          toInstrument,
        ),
      async catalogSymbols() {
        const { rows } = await sql<{ symbol: string; active: boolean }>`
          SELECT symbol, active FROM catalog_entry`.execute(trx);
        return new Map(rows.map((r) => [r.symbol, r.active]));
      },
      async upsertCatalog(entries, at) {
        for (const e of entries) {
          await sql`
            INSERT INTO catalog_entry (symbol, short_name, long_name, asset_type, sector, logo_url, active,
                                       first_seen_at, last_seen_at)
            VALUES (${e.symbol}, ${e.shortName}, ${e.longName}, ${e.assetType}, ${e.sector}, ${e.logoUrl}, true,
                    ${at.toString()}, ${at.toString()})
            ON CONFLICT (symbol) DO UPDATE SET short_name = EXCLUDED.short_name, long_name = EXCLUDED.long_name,
              asset_type = EXCLUDED.asset_type, sector = EXCLUDED.sector, logo_url = EXCLUDED.logo_url,
              active = true, last_seen_at = EXCLUDED.last_seen_at`.execute(trx);
        }
      },
      async deactivateCatalog(symbols, at) {
        if (symbols.length === 0) return;
        await sql`UPDATE catalog_entry SET active = false, last_seen_at = ${at.toString()}
                  WHERE symbol = ANY(${[...symbols]})`.execute(trx);
      },
      async markRenameSeen(oldSymbol, newSymbol) {
        const { rows } = await sql`
          INSERT INTO symbol_rename_seen (old_symbol, new_symbol) VALUES (${oldSymbol}, ${newSymbol})
          ON CONFLICT DO NOTHING RETURNING 1`.execute(trx);
        return rows.length > 0;
      },

      // ------------------------------------------------------------ cotações
      quote: (symbol, opts) =>
        one(sql<Row>`SELECT * FROM external_quote WHERE symbol = ${symbol}${lock(opts)}`, toStored),
      quotes: () => many(sql<Row>`SELECT * FROM external_quote ORDER BY symbol`, toStored),
      async saveQuote(q) {
        await sql`
          INSERT INTO external_quote (symbol, instrument_id, kind, last_price, quote_time, data, fetched_at, provider,
                                      raw_sha256, stale, stale_since)
          VALUES (${q.symbol}, ${q.instrumentId}, ${q.kind}, ${q.quote.lastPrice}, ${q.quote.quoteTime.toString()},
                  ${quoteJson(q.quote)}, ${q.fetchedAt.toString()}, ${q.provider}, ${q.rawSha256}, ${q.stale},
                  ${q.staleSince?.toString() ?? null})
          ON CONFLICT (symbol) DO UPDATE SET instrument_id = EXCLUDED.instrument_id, kind = EXCLUDED.kind,
            last_price = EXCLUDED.last_price, quote_time = EXCLUDED.quote_time, data = EXCLUDED.data,
            fetched_at = EXCLUDED.fetched_at, provider = EXCLUDED.provider, raw_sha256 = EXCLUDED.raw_sha256,
            stale = EXCLUDED.stale, stale_since = EXCLUDED.stale_since`.execute(trx);
      },
      async markStale(symbol, since) {
        await sql`UPDATE external_quote SET stale = true, stale_since = ${since.toString()}
                  WHERE symbol = ${symbol}`.execute(trx);
      },
      async insertHistory(h) {
        await sql`
          INSERT INTO external_quote_history (id, symbol, instrument_id, provider, fetched_at, quote_time, data,
                                              raw_sha256, disposition, warnings)
          VALUES (${h.id}, ${h.symbol}, ${h.instrumentId}, ${h.provider}, ${h.fetchedAt.toString()},
                  ${h.quoteTime.toString()}, ${quoteJson(h.quote)}, ${h.rawSha256}, ${h.disposition},
                  ${JSON.stringify(h.warnings)})`.execute(trx);
      },
      replayReading: (symbol, at) =>
        one(
          sql<Row>`SELECT * FROM external_quote_history
                   WHERE symbol = ${symbol} AND provider = 'brapi' AND disposition = 'ACCEPTED'
                     AND quote_time <= ${at.toString()}
                   ORDER BY quote_time DESC LIMIT 1`,
          (r): HistoryRow => ({
            id: r['id'] as string,
            symbol: r['symbol'] as string,
            instrumentId: (r['instrument_id'] as string | null) ?? null,
            provider: r['provider'] as string,
            fetchedAt: inst(r['fetched_at']),
            quoteTime: inst(r['quote_time']),
            quote: toQuote(r['data']),
            rawSha256: r['raw_sha256'] as string,
            disposition: r['disposition'] as HistoryRow['disposition'],
            warnings: r['warnings'] as HistoryRow['warnings'],
          }),
        ),
      quarantine: (symbol) =>
        one(sql<Row>`SELECT * FROM quote_quarantine WHERE symbol = ${symbol}`, (r) => ({
          symbol: r['symbol'] as string,
          price: num(r['price']),
          quoteTime: inst(r['quote_time']),
          since: inst(r['since']),
          jumpPct: num(r['jump_pct']),
        })),
      async saveQuarantine(q) {
        await sql`
          INSERT INTO quote_quarantine (symbol, price, quote_time, since, jump_pct)
          VALUES (${q.symbol}, ${q.price}, ${q.quoteTime.toString()}, ${q.since.toString()}, ${q.jumpPct})
          ON CONFLICT (symbol) DO UPDATE SET price = EXCLUDED.price, quote_time = EXCLUDED.quote_time,
            since = EXCLUDED.since, jump_pct = EXCLUDED.jump_pct`.execute(trx);
      },
      async clearQuarantine(symbol) {
        await sql`DELETE FROM quote_quarantine WHERE symbol = ${symbol}`.execute(trx);
      },
      schedules: () =>
        many(sql<Row>`SELECT * FROM quote_schedule`, (r) => ({
          symbol: r['symbol'] as string,
          nextReadAt: inst(r['next_read_at']),
          unchangedRetries: r['unchanged_retries'] as number,
          lastQuoteTime: instOrNull(r['last_quote_time']),
        })),
      async saveSchedule(s) {
        await sql`
          INSERT INTO quote_schedule (symbol, next_read_at, unchanged_retries, last_quote_time)
          VALUES (${s.symbol}, ${s.nextReadAt.toString()}, ${s.unchangedRetries}, ${s.lastQuoteTime?.toString() ?? null})
          ON CONFLICT (symbol) DO UPDATE SET next_read_at = EXCLUDED.next_read_at,
            unchanged_retries = EXCLUDED.unchanged_retries, last_quote_time = EXCLUDED.last_quote_time`.execute(
          trx,
        );
      },

      // ------------------------------------------------------------ candles diários
      async upsertCandles(symbol, candles, source) {
        for (const c of candles) {
          await sql`
            INSERT INTO external_daily_candle (symbol, date, open, high, low, close, adjusted_close, volume, source)
            VALUES (${symbol}, ${c.date.toString()}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.adjustedClose},
                    ${c.volume}, ${source})
            ON CONFLICT (symbol, date) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
              close = EXCLUDED.close, adjusted_close = COALESCE(EXCLUDED.adjusted_close, external_daily_candle.adjusted_close),
              volume = EXCLUDED.volume, source = EXCLUDED.source`.execute(trx);
        }
      },
      candles: (symbol, from, to) =>
        many(
          sql<Row>`SELECT symbol, date::text AS date, open, high, low, close, adjusted_close, volume, source
                   FROM external_daily_candle WHERE symbol = ${symbol}
                   ${from ? sql`AND date >= ${from.toString()}` : sql``}
                   ${to ? sql`AND date <= ${to.toString()}` : sql``}
                   ORDER BY date`,
          (r) => ({
            date: BusinessDate.parse(r['date'] as string),
            open: num(r['open']),
            high: num(r['high']),
            low: num(r['low']),
            close: num(r['close']),
            adjustedClose: numOrNull(r['adjusted_close']),
            volume: num(r['volume']),
            source: r['source'] as string,
          }),
        ),
      async historyFetchedAt(symbol) {
        const { rows } = await sql<{ fetched_at: Date }>`
          SELECT fetched_at FROM history_fetch WHERE symbol = ${symbol}`.execute(trx);
        return rows[0] ? inst(rows[0].fetched_at) : null;
      },
      async markHistoryFetched(symbol, at) {
        await sql`INSERT INTO history_fetch (symbol, fetched_at) VALUES (${symbol}, ${at.toString()})
                  ON CONFLICT (symbol) DO UPDATE SET fetched_at = EXCLUDED.fetched_at`.execute(trx);
      },

      // ------------------------------------------------------------ provedor
      async usage(opts) {
        const r = (
          await sql<Row>`SELECT * FROM provider_usage WHERE id = 1${lock(opts)}`.execute(trx)
        ).rows[0]!;
        return {
          usage: toUsage(r['usage']),
          usageReadAt: instOrNull(r['usage_read_at']),
          sentSinceUsage: r['sent_since_usage'] as number,
          quotaExhausted: r['quota_exhausted'] as boolean,
          level: r['level'] as UsageRow['level'],
          authBlockedToken: (r['auth_blocked_token'] as string | null) ?? null,
        };
      },
      async saveUsage(u) {
        const usage = u.usage
          ? JSON.stringify({
              ...u.usage,
              window: {
                type: u.usage.window.type,
                start: u.usage.window.start.toString(),
                end: u.usage.window.end.toString(),
              },
            })
          : null;
        await sql`
          UPDATE provider_usage SET usage = ${usage}, usage_read_at = ${u.usageReadAt?.toString() ?? null},
            sent_since_usage = ${u.sentSinceUsage}, quota_exhausted = ${u.quotaExhausted}, level = ${u.level},
            auth_blocked_token = ${u.authBlockedToken}, updated_at = now()
          WHERE id = 1`.execute(trx);
      },
      async capabilityUnavailableUntil(capability) {
        const { rows } = await sql<{ until: Date }>`
          SELECT unavailable_until AS until FROM provider_capability WHERE capability = ${capability}`.execute(
          trx,
        );
        return rows[0] ? inst(rows[0].until) : null;
      },
      async markCapabilityUnavailable(capability, until, reason) {
        await sql`
          INSERT INTO provider_capability (capability, unavailable_until, reason)
          VALUES (${capability}, ${until.toString()}, ${reason})
          ON CONFLICT (capability) DO UPDATE SET unavailable_until = EXCLUDED.unavailable_until,
            reason = EXCLUDED.reason`.execute(trx);
      },
      async insertAlert(a) {
        await sql`
          INSERT INTO provider_alert (id, kind, severity, message, data, created_at)
          VALUES (${a.id}, ${a.kind}, ${a.severity}, ${a.message}, ${JSON.stringify(a.data)},
                  ${a.createdAt.toString()})`.execute(trx);
      },
      alerts: (limit) =>
        many(
          sql<Row>`SELECT * FROM provider_alert ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
          toAlert,
        ),

      // ------------------------------------------------------------ preço de referência
      referenceState: (instrumentId, opts) =>
        one(
          sql<Row>`SELECT state FROM reference_price_state WHERE instrument_id = ${instrumentId}${lock(opts)}`,
          (r) => r['state'] as ReferenceState,
        ),
      async saveReferenceState(s) {
        await sql`
          INSERT INTO reference_price_state (instrument_id, trading_date, state)
          VALUES (${s.instrumentId}, ${s.tradingDate}, ${JSON.stringify(s)})
          ON CONFLICT (instrument_id) DO UPDATE SET trading_date = EXCLUDED.trading_date, state = EXCLUDED.state,
            updated_at = now()`.execute(trx);
      },
      overrides: (instrumentId, from, to) =>
        many(
          sql<Row>`SELECT * FROM reference_override
                   WHERE instrument_id = ${instrumentId} AND valid_until > ${from.toString()}
                     AND valid_from < ${to.toString()}
                   ORDER BY valid_from, id`,
          toOverride,
        ),
      async insertOverride(o) {
        await sql`
          INSERT INTO reference_override (id, instrument_id, price, valid_from, valid_until, created_by, reason,
                                          created_at)
          VALUES (${o.id}, ${o.instrumentId}, ${o.price}, ${o.validFrom.toString()}, ${o.validUntil.toString()},
                  ${o.createdBy}, ${o.reason}, ${o.createdAt.toString()})`.execute(trx);
      },
      async noiseEnabled(instrumentId) {
        const { rows } = await sql<{ enabled: boolean }>`
          SELECT enabled FROM reference_noise WHERE instrument_id = ${instrumentId}`.execute(trx);
        return rows[0]?.enabled ?? null;
      },
      async setNoise(instrumentId, enabled, by, at) {
        await sql`
          INSERT INTO reference_noise (instrument_id, enabled, updated_by, updated_at)
          VALUES (${instrumentId}, ${enabled}, ${by}, ${at.toString()})
          ON CONFLICT (instrument_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by,
            updated_at = EXCLUDED.updated_at`.execute(trx);
      },

      // ------------------------------------------------------------ rotinas e jobs
      async enqueueJob(j) {
        // Novo disparo da mesma rotina e data (retentativa): volta a PENDING com o novo executionId.
        await sql`
          INSERT INTO provider_job (id, routine_name, business_date, execution_id, status)
          VALUES (${j.id}, ${j.routineName}, ${j.businessDate.toString()}, ${j.executionId}, 'PENDING')
          ON CONFLICT (routine_name, business_date) DO UPDATE SET execution_id = EXCLUDED.execution_id,
            status = 'PENDING', finished_at = NULL
          WHERE provider_job.execution_id <> EXCLUDED.execution_id`.execute(trx);
      },
      pendingJobs: (limit) =>
        many(
          sql<Row>`SELECT id, routine_name, business_date::text AS business_date, execution_id, status
                   FROM provider_job WHERE status = 'PENDING' ORDER BY created_at, id LIMIT ${limit}
                   FOR UPDATE SKIP LOCKED`,
          toJob,
        ),
      async finishJob(id, status) {
        await sql`UPDATE provider_job SET status = ${status}, finished_at = now() WHERE id = ${id}`.execute(
          trx,
        );
      },
      async claimPeriodicRun(job, period, at) {
        const { rows } = await sql`
          INSERT INTO provider_job_run (job, period_key, ran_at) VALUES (${job}, ${period}, ${at.toString()})
          ON CONFLICT DO NOTHING RETURNING 1`.execute(trx);
        return rows.length > 0;
      },

      async releasePeriodicRun(job, period) {
        await sql`DELETE FROM provider_job_run WHERE job = ${job} AND period_key = ${period}`.execute(
          trx,
        );
      },

      async publish(event, partitionKey) {
        await publisher.publish(trx, EVENTS[event.type], event.payload as never, {
          partitionKey,
          aggregateType: event.type.split('.')[0]!,
          aggregateId: partitionKey,
          actor: ACTOR,
        });
      },
    };
  }
}
