import { CalendarUpdatedV1 } from '@broker/contracts/events/calendar.updated/v1';
import { InstrumentCreatedV1 } from '@broker/contracts/events/instrument.created/v1';
import { InstrumentStatusChangedV1 } from '@broker/contracts/events/instrument.status_changed/v1';
import { InstrumentSymbolChangedV1 } from '@broker/contracts/events/instrument.symbol_changed/v1';
import { InstrumentTradabilityChangedV1 } from '@broker/contracts/events/instrument.tradability_changed/v1';
import { InstrumentTradingRulesChangedV1 } from '@broker/contracts/events/instrument.trading_rules_changed/v1';
import { InstrumentUpdatedV1 } from '@broker/contracts/events/instrument.updated/v1';
import { RoutineCompletedV1 } from '@broker/contracts/events/routine.completed/v1';
import { SessionScheduleUpdatedV1 } from '@broker/contracts/events/session_schedule.updated/v1';
import { BusinessDate, Decimal, Instant } from '@broker/domain-kernel';
import type { EventDefinition, EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type {
  BackofficeTask,
  ReferenceEvent,
  ReferenceStore,
  ReferenceTx,
} from '../application/ports.js';
import type { CalendarDay, StoredSchedule } from '../domain/calendar.js';
import type { ChangeRequest } from '../domain/change-request.js';
import type { Instrument, TypeDefaults } from '../domain/instrument.js';
import type { SymbolHistoryEntry } from '../domain/symbol-history.js';
import type { TradingRulesValues, TradingRuleVersion } from '../domain/trading-rules.js';

type Row = Record<string, unknown>;

const EVENTS: Record<ReferenceEvent['type'], EventDefinition> = {
  'instrument.created': InstrumentCreatedV1,
  'instrument.updated': InstrumentUpdatedV1,
  'instrument.status_changed': InstrumentStatusChangedV1,
  'instrument.tradability_changed': InstrumentTradabilityChangedV1,
  'instrument.symbol_changed': InstrumentSymbolChangedV1,
  'instrument.trading_rules_changed': InstrumentTradingRulesChangedV1,
  'calendar.updated': CalendarUpdatedV1,
  'session_schedule.updated': SessionScheduleUpdatedV1,
  'routine.completed': RoutineCompletedV1,
};
const ACTOR = { type: 'SYSTEM' as const, id: 'reference-data-service' };
/** Chave do escopo global das regras nos índices e nas travas. */
const GLOBAL_SCOPE = '00000000-0000-0000-0000-000000000000';

const inst = (v: unknown): Instant => Instant.ofEpochMillis((v as Date).getTime());
const instOrNull = (v: unknown): Instant | null => (v ? inst(v) : null);
const str = (v: unknown) => (v as string | null) ?? null;
/** Decimal com ao menos 2 casas (0.3 → "0.30", 0.085 → "0.085"), como na API. */
const rate = (v: unknown): string => {
  const d = v as Decimal;
  return d.toFixed(Math.max(2, d.decimalPlaces()));
};
const rateOrNull = (v: unknown) => (v === null || v === undefined ? null : rate(v));
const lock = (opts?: { forUpdate?: boolean }) => (opts?.forUpdate ? sql` FOR UPDATE` : sql``);

const INSTRUMENT_COLUMNS = sql`id, symbol, isin, short_name, long_name, asset_type, share_class, sector, subsector,
  lot_size, tick_size, short_sale_enabled, day_trade_enabled, collateral_eligible, haircut, tax_category, status,
  status_reason, tradable, logo_url, source, stale_since, created_at, updated_at`;

const toInstrument = (r: Row): Instrument => ({
  id: r['id'] as string,
  symbol: r['symbol'] as string,
  isin: str(r['isin']),
  shortName: str(r['short_name']),
  longName: str(r['long_name']),
  assetType: r['asset_type'] as Instrument['assetType'],
  shareClass: r['share_class'] as Instrument['shareClass'],
  sector: str(r['sector']),
  subsector: str(r['subsector']),
  lotSize: r['lot_size'] as number,
  tickSize: rate(r['tick_size']),
  shortSaleEnabled: r['short_sale_enabled'] as boolean,
  dayTradeEnabled: r['day_trade_enabled'] as boolean,
  collateralEligible: r['collateral_eligible'] as boolean,
  haircut: rateOrNull(r['haircut']),
  taxCategory: r['tax_category'] as Instrument['taxCategory'],
  status: r['status'] as Instrument['status'],
  statusReason: str(r['status_reason']),
  tradable: r['tradable'] as boolean,
  logoUrl: str(r['logo_url']),
  source: r['source'] as Instrument['source'],
  staleSince: instOrNull(r['stale_since']),
  createdAt: inst(r['created_at']),
  updatedAt: inst(r['updated_at']),
});

const toDefaults = (r: Row): TypeDefaults => ({
  assetType: r['asset_type'] as TypeDefaults['assetType'],
  lotSize: r['lot_size'] as number,
  tickSize: rate(r['tick_size']),
  shortSaleEnabled: r['short_sale_enabled'] as boolean,
  dayTradeEnabled: r['day_trade_enabled'] as boolean,
  collateralEligible: r['collateral_eligible'] as boolean,
  haircut: rateOrNull(r['haircut']),
  taxCategory: r['tax_category'] as TypeDefaults['taxCategory'],
});

const HISTORY_COLUMNS = sql`instrument_id, symbol, valid_from::text AS valid_from, valid_to::text AS valid_to, conversion_ratio`;
const toHistory = (r: Row): SymbolHistoryEntry => ({
  instrumentId: r['instrument_id'] as string,
  symbol: r['symbol'] as string,
  validFrom: BusinessDate.parse(r['valid_from'] as string),
  validTo: BusinessDate.parse(r['valid_to'] as string),
  conversionRatio:
    r['conversion_ratio'] === null ? null : (r['conversion_ratio'] as Decimal).toString(),
});

const toRequest = (r: Row): ChangeRequest => ({
  id: r['id'] as string,
  type: r['type'] as ChangeRequest['type'],
  targetId: r['target_id'] as string,
  payload: r['payload'] as Record<string, unknown>,
  currentState: r['current_state'] as Record<string, unknown>,
  justification: r['justification'] as string,
  makerId: r['maker_id'] as string,
  status: r['status'] as ChangeRequest['status'],
  createdAt: inst(r['created_at']),
  expiresAt: inst(r['expires_at']),
  decidedBy: str(r['decided_by']),
  decidedAt: instOrNull(r['decided_at']),
  decisionReason: str(r['decision_reason']),
});

const toTask = (r: Row): BackofficeTask => ({
  id: r['id'] as string,
  kind: r['kind'] as BackofficeTask['kind'],
  dedupeKey: r['dedupe_key'] as string,
  instrumentId: str(r['instrument_id']),
  data: r['data'] as Record<string, unknown>,
  status: r['status'] as BackofficeTask['status'],
  createdAt: inst(r['created_at']),
  resolvedBy: str(r['resolved_by']),
  resolvedAt: instOrNull(r['resolved_at']),
});

/** Colunas de `instrument_trading_rules` ↔ campos de `TradingRulesValues`. */
const RULE_COLUMNS: Record<
  keyof TradingRulesValues,
  { column: string; kind: 'rate' | 'int' | 'money' }
> = {
  rejectionBandPct: { column: 'rejection_band_pct', kind: 'rate' },
  staticAuctionBandPct: { column: 'static_auction_band_pct', kind: 'rate' },
  dynamicAuctionBandPct: { column: 'dynamic_auction_band_pct', kind: 'rate' },
  volatilityAuctionDurationS: { column: 'volatility_auction_duration_s', kind: 'int' },
  volatilityAuctionExtensionS: { column: 'volatility_auction_extension_s', kind: 'int' },
  auctionRandomEndMaxS: { column: 'auction_random_end_max_s', kind: 'int' },
  maxOrderQuantity: { column: 'max_order_quantity', kind: 'int' },
  maxOrderNotional: { column: 'max_order_notional', kind: 'money' },
  marketProtectionPct: { column: 'market_protection_pct', kind: 'rate' },
  smmSpreadBps: { column: 'smm_spread_bps', kind: 'int' },
};

const toRuleVersion = (r: Row): TradingRuleVersion => {
  const values: Record<string, unknown> = {};
  for (const [field, { column, kind }] of Object.entries(RULE_COLUMNS)) {
    const v = r[column];
    if (v === null || v === undefined) continue;
    values[field] =
      kind === 'int' ? Number(v) : kind === 'money' ? (v as Decimal).toFixed(2) : rate(v);
  }
  return {
    id: r['id'] as string,
    instrumentId: str(r['instrument_id']),
    values: values as Partial<TradingRulesValues>,
    validFrom: inst(r['valid_from']),
    validTo: instOrNull(r['valid_to']),
    approvalRequestId: r['approval_request_id'] as string,
  };
};

const toSchedule = (r: Row): StoredSchedule => ({
  id: r['id'] as string,
  name: r['name'] as string,
  dayType: r['day_type'] as StoredSchedule['dayType'],
  phases: r['phases'] as StoredSchedule['phases'],
  validFrom: r['valid_from'] as string,
  validTo: str(r['valid_to']),
});

/** Adaptador do banco do reference-data; eventos na outbox, na transação do efeito (ADR-0008). */
export class PostgresReferenceStore implements ReferenceStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: ReferenceTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  /** Unidade de trabalho sobre uma transação já aberta (ex.: a do consumidor, com a inbox). */
  tx(trx: Kysely<unknown>): ReferenceTx {
    const publisher = this.publisher;
    const one = async <T>(q: RawBuilder<Row>, map: (r: Row) => T): Promise<T | null> => {
      const row = (await q.execute(trx)).rows[0];
      return row ? map(row) : null;
    };
    const many = async <T>(q: RawBuilder<Row>, map: (r: Row) => T): Promise<T[]> =>
      (await q.execute(trx)).rows.map(map);

    return {
      // ------------------------------------------------------------ instrumentos
      instrument: (id, opts) =>
        one(
          sql<Row>`SELECT ${INSTRUMENT_COLUMNS} FROM instrument WHERE id = ${id}${lock(opts)}`,
          toInstrument,
        ),
      instrumentBySymbol: (symbol, opts) =>
        one(
          sql<Row>`SELECT ${INSTRUMENT_COLUMNS} FROM instrument WHERE symbol = ${symbol}
                   ORDER BY (status = 'DELISTED'), updated_at DESC LIMIT 1${lock(opts)}`,
          toInstrument,
        ),
      async insertInstrument(i) {
        await sql`
          INSERT INTO instrument (id, symbol, isin, short_name, long_name, asset_type, share_class, sector, subsector,
            lot_size, tick_size, short_sale_enabled, day_trade_enabled, collateral_eligible, haircut, tax_category,
            status, status_reason, tradable, logo_url, source, stale_since, created_at, updated_at)
          VALUES (${i.id}, ${i.symbol}, ${i.isin}, ${i.shortName}, ${i.longName}, ${i.assetType}, ${i.shareClass},
            ${i.sector}, ${i.subsector}, ${i.lotSize}, ${i.tickSize}, ${i.shortSaleEnabled}, ${i.dayTradeEnabled},
            ${i.collateralEligible}, ${i.haircut}, ${i.taxCategory}, ${i.status}, ${i.statusReason}, ${i.tradable},
            ${i.logoUrl}, ${i.source}, ${i.staleSince?.toString() ?? null}, ${i.createdAt.toString()},
            ${i.updatedAt.toString()})`.execute(trx);
      },
      async saveInstrument(i) {
        await sql`
          UPDATE instrument SET symbol = ${i.symbol}, isin = ${i.isin}, short_name = ${i.shortName},
            long_name = ${i.longName}, asset_type = ${i.assetType}, share_class = ${i.shareClass}, sector = ${i.sector},
            subsector = ${i.subsector}, lot_size = ${i.lotSize}, tick_size = ${i.tickSize},
            short_sale_enabled = ${i.shortSaleEnabled}, day_trade_enabled = ${i.dayTradeEnabled},
            collateral_eligible = ${i.collateralEligible}, haircut = ${i.haircut}, tax_category = ${i.taxCategory},
            status = ${i.status}, status_reason = ${i.statusReason}, tradable = ${i.tradable}, logo_url = ${i.logoUrl},
            stale_since = ${i.staleSince?.toString() ?? null}, updated_at = ${i.updatedAt.toString()}
          WHERE id = ${i.id}`.execute(trx);
      },
      instruments: (f) =>
        many(
          sql<Row>`SELECT ${INSTRUMENT_COLUMNS} FROM instrument
                   WHERE true
                   ${f.tradable === undefined ? sql`` : sql`AND tradable = ${f.tradable}`}
                   ${f.status ? sql`AND status = ${f.status}` : sql``}
                   ${f.after ? sql`AND symbol > ${f.after}` : sql``}
                   ORDER BY symbol, id LIMIT ${f.limit}`,
          toInstrument,
        ),
      searchInstruments: (text, limit) => {
        const prefix = `${text.replace(/[\\%_]/g, '\\$&')}%`;
        const contains = `%${text.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
        return many(
          sql<Row>`SELECT ${INSTRUMENT_COLUMNS} FROM instrument
                   WHERE status <> 'DELISTED'
                     AND (symbol LIKE ${prefix} OR lower(short_name) LIKE ${contains} OR lower(long_name) LIKE ${contains})
                   ORDER BY (symbol LIKE ${prefix}) DESC, tradable DESC, symbol LIMIT ${limit}`,
          toInstrument,
        );
      },
      async tradableCount() {
        const { rows } = await sql<{
          n: string;
        }>`SELECT count(*) AS n FROM instrument WHERE tradable`.execute(trx);
        return Number(rows[0]!.n);
      },
      async lockUniverse() {
        // Trava transacional por chave fixa: inclusões concorrentes não passam juntas do limite.
        await sql`SELECT pg_advisory_xact_lock(hashtext('reference.universe'))`.execute(trx);
      },
      staleInstruments: () =>
        many(
          sql<Row>`SELECT ${INSTRUMENT_COLUMNS} FROM instrument
                   WHERE stale_since IS NOT NULL AND status IN ('PENDING', 'ACTIVE')`,
          toInstrument,
        ),

      // ------------------------------------------------------------ padrões por tipo
      async typeDefaults(type) {
        return (await one(
          sql<Row>`SELECT * FROM instrument_type_default WHERE asset_type = ${type}`,
          toDefaults,
        ))!;
      },
      allTypeDefaults: () =>
        many(sql<Row>`SELECT * FROM instrument_type_default ORDER BY asset_type`, toDefaults),
      async saveTypeDefaults(d) {
        await sql`
          UPDATE instrument_type_default SET lot_size = ${d.lotSize}, tick_size = ${d.tickSize},
            short_sale_enabled = ${d.shortSaleEnabled}, day_trade_enabled = ${d.dayTradeEnabled},
            collateral_eligible = ${d.collateralEligible}, haircut = ${d.haircut}, tax_category = ${d.taxCategory}
          WHERE asset_type = ${d.assetType}`.execute(trx);
      },

      // ------------------------------------------------------------ histórico de tickers
      async insertSymbolHistory(h) {
        await sql`
          INSERT INTO instrument_symbol_history (instrument_id, symbol, valid_from, valid_to, conversion_ratio)
          VALUES (${h.instrumentId}, ${h.symbol}, ${h.validFrom.toString()}, ${h.validTo.toString()},
                  ${h.conversionRatio})`.execute(trx);
      },
      historyBySymbol: (symbol) =>
        many(
          sql<Row>`SELECT ${HISTORY_COLUMNS} FROM instrument_symbol_history WHERE symbol = ${symbol}
                   ORDER BY valid_to DESC`,
          toHistory,
        ),
      historyOf: (instrumentId) =>
        many(
          sql<Row>`SELECT ${HISTORY_COLUMNS} FROM instrument_symbol_history WHERE instrument_id = ${instrumentId}
                   ORDER BY valid_to DESC`,
          toHistory,
        ),

      // ------------------------------------------------------------ solicitações
      async insertChangeRequest(r) {
        await sql`
          INSERT INTO change_request (id, type, target_id, payload, current_state, justification, maker_id, status,
            created_at, expires_at)
          VALUES (${r.id}, ${r.type}, ${r.targetId}, ${JSON.stringify(r.payload)}, ${JSON.stringify(r.currentState)},
            ${r.justification}, ${r.makerId}, ${r.status}, ${r.createdAt.toString()}, ${r.expiresAt.toString()})`.execute(
          trx,
        );
      },
      changeRequest: (id, opts) =>
        one(sql<Row>`SELECT * FROM change_request WHERE id = ${id}${lock(opts)}`, toRequest),
      changeRequests: (status, limit) =>
        many(
          sql<Row>`SELECT * FROM change_request ${status ? sql`WHERE status = ${status}` : sql``}
                   ORDER BY created_at DESC LIMIT ${limit}`,
          toRequest,
        ),
      async saveChangeRequest(r) {
        await sql`
          UPDATE change_request SET status = ${r.status}, decided_by = ${r.decidedBy},
            decided_at = ${r.decidedAt?.toString() ?? null}, decision_reason = ${r.decisionReason}
          WHERE id = ${r.id}`.execute(trx);
      },
      duePendingRequests: (now, limit) =>
        many(
          sql<Row>`SELECT * FROM change_request WHERE status = 'PENDING' AND expires_at <= ${now.toString()}
                   ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`,
          toRequest,
        ),
      pendingFor: (type, targetId) =>
        one(
          sql<Row>`SELECT * FROM change_request WHERE status = 'PENDING' AND type = ${type} AND target_id = ${targetId}`,
          toRequest,
        ),

      // ------------------------------------------------------------ tarefas
      async insertTask(t) {
        const res = await sql`
          INSERT INTO backoffice_task (id, kind, dedupe_key, instrument_id, data, status, created_at)
          VALUES (${t.id}, ${t.kind}, ${t.dedupeKey}, ${t.instrumentId}, ${JSON.stringify(t.data)}, ${t.status},
                  ${t.createdAt.toString()})
          ON CONFLICT (dedupe_key) DO NOTHING`.execute(trx);
        return Number(res.numAffectedRows ?? 0) === 1;
      },
      task: (id, opts) =>
        one(sql<Row>`SELECT * FROM backoffice_task WHERE id = ${id}${lock(opts)}`, toTask),
      tasks: (status, limit) =>
        many(
          sql<Row>`SELECT * FROM backoffice_task ${status ? sql`WHERE status = ${status}` : sql``}
                   ORDER BY created_at DESC LIMIT ${limit}`,
          toTask,
        ),
      async saveTask(t) {
        await sql`
          UPDATE backoffice_task SET status = ${t.status}, resolved_by = ${t.resolvedBy},
            resolved_at = ${t.resolvedAt?.toString() ?? null}
          WHERE id = ${t.id}`.execute(trx);
      },

      // ------------------------------------------------------------ regras de negociação
      ruleVersions: (instrumentId) =>
        many(
          sql<Row>`SELECT * FROM instrument_trading_rules
                   WHERE ${instrumentId === null ? sql`instrument_id IS NULL` : sql`instrument_id = ${instrumentId}`}
                   ORDER BY valid_from DESC`,
          toRuleVersion,
        ),
      async insertRuleVersion(v) {
        const cols = Object.entries(RULE_COLUMNS);
        const value = (field: string) => (v.values as Record<string, unknown>)[field] ?? null;
        await sql`
          INSERT INTO instrument_trading_rules (id, instrument_id, ${sql.join(cols.map(([, c]) => sql.ref(c.column)))},
            valid_from, valid_to, approval_request_id)
          VALUES (${v.id}, ${v.instrumentId}, ${sql.join(cols.map(([f]) => sql`${value(f)}`))},
            ${v.validFrom.toString()}, ${v.validTo?.toString() ?? null}, ${v.approvalRequestId})`.execute(
          trx,
        );
      },
      async closeRuleVersion(id, validTo) {
        await sql`UPDATE instrument_trading_rules SET valid_to = ${validTo.toString()} WHERE id = ${id}`.execute(
          trx,
        );
      },
      async lockRules(instrumentId) {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`reference.rules:${instrumentId ?? GLOBAL_SCOPE}`}))`.execute(
          trx,
        );
      },

      // ------------------------------------------------------------ calendário
      calendarDays: () =>
        many(
          sql<Row>`SELECT date::text AS date, day_type, description FROM trading_calendar ORDER BY date`,
          (r): CalendarDay => ({
            date: BusinessDate.parse(r['date'] as string),
            dayType: r['day_type'] as CalendarDay['dayType'],
            description: str(r['description']),
          }),
        ),
      async upsertCalendarDays(rows) {
        for (const d of rows) {
          await sql`
            INSERT INTO trading_calendar (date, day_type, description)
            VALUES (${d.date.toString()}, ${d.dayType}, ${d.description})
            ON CONFLICT (date) DO UPDATE SET day_type = EXCLUDED.day_type, description = EXCLUDED.description`.execute(
            trx,
          );
        }
      },
      schedules: () =>
        many(
          sql<Row>`SELECT id, name, day_type, phases, valid_from::text AS valid_from, valid_to::text AS valid_to
                   FROM session_schedule ORDER BY day_type, valid_from`,
          toSchedule,
        ),
      async insertSchedule(s) {
        await sql`
          INSERT INTO session_schedule (id, name, day_type, phases, valid_from, valid_to)
          VALUES (${s.id}, ${s.name}, ${s.dayType}, ${JSON.stringify(s.phases)}, ${s.validFrom}, ${s.validTo})`.execute(
          trx,
        );
      },
      async closeSchedule(id, validTo) {
        await sql`UPDATE session_schedule SET valid_to = ${validTo} WHERE id = ${id}`.execute(trx);
      },
      async calendarVersion(opts) {
        const { rows } = await sql<{ version: number }>`
          SELECT version FROM calendar_state WHERE id = 1${opts?.lock ? sql` FOR UPDATE` : sql``}`.execute(
          trx,
        );
        return rows[0]!.version;
      },
      async bumpCalendarVersion() {
        const { rows } = await sql<{ version: number }>`
          UPDATE calendar_state SET version = version + 1 WHERE id = 1 RETURNING version`.execute(
          trx,
        );
        return rows[0]!.version;
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
