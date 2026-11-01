import { EngineBandUpdateV1 } from '@broker/contracts/events/engine.band_update/v1';
import { EnginePhaseChangeV1 } from '@broker/contracts/events/engine.phase_change/v1';
import { RoutineCompletedV1 } from '@broker/contracts/events/routine.completed/v1';
import { SessionCircuitBreakerTriggeredV1 } from '@broker/contracts/events/session.circuit_breaker_triggered/v1';
import { SessionHaltEndedV1 } from '@broker/contracts/events/session.halt_ended/v1';
import { SessionHaltStartedV1 } from '@broker/contracts/events/session.halt_started/v1';
import { SessionPhaseChangedV1 } from '@broker/contracts/events/session.phase_changed/v1';
import { SessionTradingDayClosedV1 } from '@broker/contracts/events/session.trading_day_closed/v1';
import { SessionTradingDayOpenedV1 } from '@broker/contracts/events/session.trading_day_opened/v1';
import { BusinessDate, Instant, type Decimal } from '@broker/domain-kernel';
import type { EventDefinition, EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type {
  Auction,
  ChangeRequest,
  CircuitBreakerEvent,
  ClosingPrice,
  Halt,
  InstrumentState,
  MarketState,
  SessionAlert,
  SessionEvent,
  SessionStore,
  SessionTx,
} from '../application/ports.js';
import type { Phase } from '../domain/phases.js';
import { resolveRules, type SessionRules } from '../domain/trading-rules.js';

type Row = Record<string, unknown>;

const EVENTS: Record<SessionEvent['type'], EventDefinition> = {
  'session.trading_day_opened': SessionTradingDayOpenedV1,
  'session.trading_day_closed': SessionTradingDayClosedV1,
  'session.phase_changed': SessionPhaseChangedV1,
  'session.halt_started': SessionHaltStartedV1,
  'session.halt_ended': SessionHaltEndedV1,
  'session.circuit_breaker_triggered': SessionCircuitBreakerTriggeredV1,
  'engine.phase_change': EnginePhaseChangeV1,
  'engine.band_update': EngineBandUpdateV1,
  'routine.completed': RoutineCompletedV1,
};
const ACTOR = { type: 'SYSTEM' as const, id: 'trading-session-service' };

const inst = (v: unknown): Instant => Instant.ofEpochMillis((v as Date).getTime());
const instOrNull = (v: unknown): Instant | null => (v ? inst(v) : null);
const dec = (v: unknown) => (v as Decimal | null) ?? null;
const dateOf = (v: unknown): BusinessDate => BusinessDate.parse(v as string);
const dateOrNull = (v: unknown): BusinessDate | null => (v ? dateOf(v) : null);
const bigOrNull = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as bigint));
const iso = (i: Instant | null) => i?.toString() ?? null;
const lock = (opts?: { forUpdate?: boolean }) => (opts?.forUpdate ? sql` FOR UPDATE` : sql``);

const DATE = sql.raw(`to_char(business_date, 'YYYY-MM-DD') AS business_date`);

const toMarket = (r: Row): MarketState => ({
  phase: r['phase'] as Phase,
  scheduledPhase: r['scheduled_phase'] as Phase,
  since: inst(r['since']),
  expectedEndAt: instOrNull(r['expected_end_at']),
  reason: r['reason'] as string,
  businessDate: dateOrNull(r['business_date']),
});

const INSTRUMENT_COLUMNS =
  sql.raw(`instrument_id, symbol, tradable, status, phase, since, expected_end_at,
  reason, engine_phase, previous_close, band_reference_price, last_trade_price,
  to_char(last_trade_date, 'YYYY-MM-DD') AS last_trade_date, last_trade_seq, external_price, external_quote_time`);

const toInstrument = (r: Row): InstrumentState => ({
  id: r['instrument_id'] as string,
  symbol: r['symbol'] as string,
  tradable: r['tradable'] as boolean,
  status: r['status'] as string,
  phase: (r['phase'] as Phase | null) ?? null,
  since: instOrNull(r['since']),
  expectedEndAt: instOrNull(r['expected_end_at']),
  reason: (r['reason'] as string | null) ?? null,
  enginePhase: (r['engine_phase'] as Phase | null) ?? null,
  previousClose: dec(r['previous_close']),
  bandReferencePrice: dec(r['band_reference_price']),
  lastTradePrice: dec(r['last_trade_price']),
  lastTradeDate: dateOrNull(r['last_trade_date']),
  lastTradeSeq: bigOrNull(r['last_trade_seq']),
  externalPrice: dec(r['external_price']),
  externalQuoteTime: instOrNull(r['external_quote_time']),
});

const toHalt = (r: Row): Halt => ({
  id: r['id'] as string,
  scope: r['scope'] as string,
  reasonCode: r['reason_code'] as string,
  description: (r['description'] as string | null) ?? null,
  startedAt: inst(r['started_at']),
  endedAt: instOrNull(r['ended_at']),
  resumeAt: instOrNull(r['resume_at']),
  resumeAuctionS: r['resume_auction_s'] as number,
  cancelAllOnHalt: r['cancel_all_on_halt'] as boolean,
  actorId: r['actor_id'] as string,
  approvalRequestId: (r['approval_request_id'] as string | null) ?? null,
});

const AUCTION_COLUMNS =
  sql.raw(`id, instrument_id, type, status, market_scoped, ${`to_char(business_date, 'YYYY-MM-DD') AS business_date`},
  started_at, expected_end_at, effective_end_at, extensions, theoretical_price, theoretical_quantity, price, quantity`);

const toAuction = (r: Row): Auction => ({
  id: r['id'] as string,
  instrumentId: r['instrument_id'] as string,
  type: r['type'] as Auction['type'],
  status: r['status'] as Auction['status'],
  marketScoped: r['market_scoped'] as boolean,
  businessDate: dateOf(r['business_date']),
  startedAt: inst(r['started_at']),
  expectedEndAt: inst(r['expected_end_at']),
  effectiveEndAt: instOrNull(r['effective_end_at']),
  extensions: r['extensions'] as number,
  theoreticalPrice: dec(r['theoretical_price']),
  theoreticalQuantity: bigOrNull(r['theoretical_quantity']),
  price: dec(r['price']),
  quantity: bigOrNull(r['quantity']),
});

const toCircuitBreaker = (r: Row): CircuitBreakerEvent => ({
  id: r['id'] as string,
  businessDate: dateOf(r['business_date']),
  level: r['level'] as number,
  indexChange: dec(r['index_change_percent']),
  origin: r['origin'] as CircuitBreakerEvent['origin'],
  triggeredAt: inst(r['triggered_at']),
  resumesAt: inst(r['resumes_at']),
});

const toClosing = (r: Row): ClosingPrice => ({
  instrumentId: r['instrument_id'] as string,
  businessDate: dateOf(r['business_date']),
  price: r['price'] as Decimal,
  source: r['source'] as ClosingPrice['source'],
  externalClose: dec(r['external_close']),
  divergenceAlert: r['divergence_alert'] as boolean,
});

const toAlert = (r: Row): SessionAlert => ({
  id: r['id'] as string,
  kind: r['kind'] as string,
  dedupeKey: r['dedupe_key'] as string,
  message: r['message'] as string,
  data: r['data'] as Record<string, unknown>,
  createdAt: inst(r['created_at']),
});

const toRequest = (r: Row): ChangeRequest => ({
  id: r['id'] as string,
  type: r['type'] as ChangeRequest['type'],
  payload: r['payload'] as Record<string, unknown>,
  currentState: r['current_state'] as Record<string, unknown>,
  justification: r['justification'] as string,
  makerId: r['maker_id'] as string,
  status: r['status'] as ChangeRequest['status'],
  createdAt: inst(r['created_at']),
  expiresAt: inst(r['expires_at']),
  decidedBy: (r['decided_by'] as string | null) ?? null,
  decidedAt: instOrNull(r['decided_at']),
  decisionReason: (r['decision_reason'] as string | null) ?? null,
});

export class PostgresSessionStore implements SessionStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  /** A unidade de trabalho sobre uma transação já aberta (a do consumidor, com inbox e offset). */
  tx(trx: Kysely<unknown>): SessionTx {
    const publisher = this.publisher;
    const readMarket = async (suffix: ReturnType<typeof lock>) =>
      toMarket(
        (
          await sql<Row>`
            SELECT phase, scheduled_phase, since, expected_end_at, reason,
              to_char(business_date, 'YYYY-MM-DD') AS business_date
            FROM market_phase_state WHERE id = 1${suffix}`.execute(trx)
        ).rows[0]!,
      );
    return {
      lockMarket: () => readMarket(sql` FOR UPDATE`),
      market: () => readMarket(sql``),
      async saveMarket(m) {
        await sql`
          UPDATE market_phase_state SET phase = ${m.phase}, scheduled_phase = ${m.scheduledPhase},
            since = ${m.since.toString()}, expected_end_at = ${iso(m.expectedEndAt)}, reason = ${m.reason},
            business_date = ${m.businessDate?.toString() ?? null}
          WHERE id = 1`.execute(trx);
      },

      async instrument(id, opts) {
        const { rows } = await sql<Row>`
          SELECT ${INSTRUMENT_COLUMNS} FROM instrument_phase_state WHERE instrument_id = ${id}${lock(opts)}`.execute(
          trx,
        );
        return rows[0] ? toInstrument(rows[0]) : null;
      },
      async instrumentBySymbol(symbol) {
        const { rows } = await sql<Row>`
          SELECT ${INSTRUMENT_COLUMNS} FROM instrument_phase_state WHERE symbol = ${symbol}
          ORDER BY tradable DESC LIMIT 1`.execute(trx);
        return rows[0] ? toInstrument(rows[0]) : null;
      },
      async tradableInstruments() {
        const { rows } = await sql<Row>`
          SELECT ${INSTRUMENT_COLUMNS} FROM instrument_phase_state WHERE tradable ORDER BY symbol`.execute(
          trx,
        );
        return rows.map(toInstrument);
      },
      async upsertInstrumentCopy(i) {
        await sql`
          INSERT INTO instrument_phase_state (instrument_id, symbol, tradable, status)
          VALUES (${i.id}, ${i.symbol}, ${i.tradable}, ${i.status})
          ON CONFLICT (instrument_id) DO UPDATE SET symbol = EXCLUDED.symbol,
            tradable = EXCLUDED.tradable, status = EXCLUDED.status`.execute(trx);
      },
      async saveInstrument(i) {
        await sql`
          UPDATE instrument_phase_state SET phase = ${i.phase}, since = ${iso(i.since)},
            expected_end_at = ${iso(i.expectedEndAt)}, reason = ${i.reason}, engine_phase = ${i.enginePhase},
            previous_close = ${i.previousClose}, band_reference_price = ${i.bandReferencePrice},
            external_price = ${i.externalPrice}, external_quote_time = ${iso(i.externalQuoteTime)}
          WHERE instrument_id = ${i.id}`.execute(trx);
      },
      async recordContinuousTrade(t) {
        await sql`
          UPDATE instrument_phase_state SET last_trade_price = ${t.price},
            last_trade_date = ${t.tradingDate.toString()}, last_trade_seq = ${t.engineSeq.toString()}
          WHERE instrument_id = ${t.instrumentId}
            AND (last_trade_seq IS NULL OR last_trade_seq < ${t.engineSeq.toString()})`.execute(
          trx,
        );
      },

      async tradingDay(date) {
        const { rows } = await sql<{ status: string }>`
          SELECT status FROM trading_day WHERE business_date = ${date.toString()}`.execute(trx);
        return rows[0] ?? null;
      },
      async openTradingDay(date, at) {
        await sql`
          INSERT INTO trading_day (business_date, status, opened_at)
          VALUES (${date.toString()}, 'OPEN', ${at.toString()})
          ON CONFLICT (business_date) DO UPDATE SET status = 'OPEN', opened_at = EXCLUDED.opened_at`.execute(
          trx,
        );
      },
      async closeTradingDay(date, at) {
        await sql`
          INSERT INTO trading_day (business_date, status, closed_at)
          VALUES (${date.toString()}, 'CLOSED', ${at.toString()})
          ON CONFLICT (business_date) DO UPDATE SET status = 'CLOSED', closed_at = EXCLUDED.closed_at`.execute(
          trx,
        );
      },
      async insertTransition(t) {
        await sql`
          INSERT INTO phase_transition (id, scope, from_phase, to_phase, reason, effective_at, actor)
          VALUES (${t.id}, ${t.scope}, ${t.from}, ${t.to}, ${t.reason}, ${t.effectiveAt.toString()}, ${t.actor})`.execute(
          trx,
        );
      },

      async insertHalt(h) {
        const res = await sql`
          INSERT INTO halt (id, scope, reason_code, description, started_at, resume_at, resume_auction_s,
            cancel_all_on_halt, actor_id, approval_request_id)
          VALUES (${h.id}, ${h.scope}, ${h.reasonCode}, ${h.description}, ${h.startedAt.toString()},
            ${iso(h.resumeAt)}, ${h.resumeAuctionS}, ${h.cancelAllOnHalt}, ${h.actorId}, ${h.approvalRequestId})
          ON CONFLICT (scope, reason_code) WHERE ended_at IS NULL DO NOTHING`.execute(trx);
        return Number(res.numAffectedRows ?? 0n) > 0;
      },
      async saveHalt(h) {
        await sql`UPDATE halt SET ended_at = ${iso(h.endedAt)}, resume_at = ${iso(h.resumeAt)} WHERE id = ${h.id}`.execute(
          trx,
        );
      },
      async halt(id) {
        const { rows } = await sql<Row>`SELECT * FROM halt WHERE id = ${id}`.execute(trx);
        return rows[0] ? toHalt(rows[0]) : null;
      },
      async activeHalts(scope) {
        const { rows } = await sql<Row>`
          SELECT * FROM halt WHERE ended_at IS NULL ${scope ? sql`AND scope = ${scope}` : sql``}
          ORDER BY started_at`.execute(trx);
        return rows.map(toHalt);
      },
      async halts({ active, limit }) {
        const filter =
          active === undefined
            ? sql``
            : active
              ? sql`WHERE ended_at IS NULL`
              : sql`WHERE ended_at IS NOT NULL`;
        const { rows } = await sql<Row>`
          SELECT * FROM halt ${filter} ORDER BY started_at DESC LIMIT ${limit}`.execute(trx);
        return rows.map(toHalt);
      },

      async insertAuction(a) {
        await sql`
          INSERT INTO auction (id, instrument_id, type, status, market_scoped, business_date, started_at, expected_end_at)
          VALUES (${a.id}, ${a.instrumentId}, ${a.type}, ${a.status}, ${a.marketScoped}, ${a.businessDate.toString()},
            ${a.startedAt.toString()}, ${a.expectedEndAt.toString()})`.execute(trx);
      },
      async saveAuction(a) {
        await sql`
          UPDATE auction SET status = ${a.status}, market_scoped = ${a.marketScoped},
            expected_end_at = ${a.expectedEndAt.toString()}, effective_end_at = ${iso(a.effectiveEndAt)},
            extensions = ${a.extensions}, price = ${a.price},
            quantity = ${a.quantity?.toString() ?? null}
          WHERE id = ${a.id}`.execute(trx);
      },
      async auction(id, opts) {
        const { rows } = await sql<Row>`
          SELECT ${AUCTION_COLUMNS} FROM auction WHERE id = ${id}${lock(opts)}`.execute(trx);
        return rows[0] ? toAuction(rows[0]) : null;
      },
      async liveAuctions(instrumentId) {
        const { rows } = await sql<Row>`
          SELECT ${AUCTION_COLUMNS} FROM auction WHERE status IN ('OPEN', 'HELD')
          ${instrumentId ? sql`AND instrument_id = ${instrumentId}` : sql``}
          ORDER BY started_at, id`.execute(trx);
        return rows.map(toAuction);
      },
      async recordIndicative(i) {
        await sql`
          UPDATE auction SET theoretical_price = ${i.price}, theoretical_quantity = ${i.quantity.toString()}
          WHERE id = ${i.auctionId} AND status IN ('OPEN', 'HELD')`.execute(trx);
      },

      async circuitBreakerEvents(date) {
        const { rows } = await sql<Row>`
          SELECT id, ${DATE}, level, index_change_percent, origin, triggered_at, resumes_at
          FROM circuit_breaker_event WHERE business_date = ${date.toString()} ORDER BY level`.execute(
          trx,
        );
        return rows.map(toCircuitBreaker);
      },
      async insertCircuitBreaker(e) {
        await sql`
          INSERT INTO circuit_breaker_event (id, business_date, level, index_change_percent, origin, triggered_at, resumes_at)
          VALUES (${e.id}, ${e.businessDate.toString()}, ${e.level}, ${e.indexChange}, ${e.origin},
            ${e.triggeredAt.toString()}, ${e.resumesAt.toString()})`.execute(trx);
      },

      async completedClosingCall(instrumentId, date) {
        const { rows } = await sql<Row>`
          SELECT ${AUCTION_COLUMNS} FROM auction
          WHERE instrument_id = ${instrumentId} AND business_date = ${date.toString()}
            AND type = 'CLOSING' AND status = 'COMPLETED'
          ORDER BY effective_end_at DESC LIMIT 1`.execute(trx);
        return rows[0] ? toAuction(rows[0]) : null;
      },
      async upsertClosingPrice(c) {
        await sql`
          INSERT INTO closing_price (instrument_id, business_date, price, source, external_close, divergence_alert)
          VALUES (${c.instrumentId}, ${c.businessDate.toString()}, ${c.price}, ${c.source}, ${c.externalClose}, ${c.divergenceAlert})
          ON CONFLICT (instrument_id, business_date) DO UPDATE SET price = EXCLUDED.price, source = EXCLUDED.source,
            external_close = EXCLUDED.external_close, divergence_alert = EXCLUDED.divergence_alert`.execute(
          trx,
        );
      },
      async closingPrice(instrumentId, date) {
        const { rows } = await sql<Row>`
          SELECT instrument_id, ${DATE}, price, source, external_close, divergence_alert FROM closing_price
          WHERE instrument_id = ${instrumentId} AND business_date = ${date.toString()}`.execute(
          trx,
        );
        return rows[0] ? toClosing(rows[0]) : null;
      },
      async closingPrices(date) {
        const { rows } = await sql<Row>`
          SELECT instrument_id, ${DATE}, price, source, external_close, divergence_alert FROM closing_price
          WHERE business_date = ${date.toString()} ORDER BY instrument_id`.execute(trx);
        return rows.map(toClosing);
      },

      async routine(name, date) {
        const { rows } = await sql<{
          execution_id: string;
          status: 'PENDING' | 'COMPLETED';
          stats: Record<string, unknown>;
        }>`
          SELECT execution_id, status, stats FROM session_routine
          WHERE routine_name = ${name} AND business_date = ${date.toString()}`.execute(trx);
        const r = rows[0];
        return r ? { executionId: r.execution_id, status: r.status, stats: r.stats } : null;
      },
      async saveRoutine(r) {
        await sql`
          INSERT INTO session_routine (routine_name, business_date, execution_id, status, stats)
          VALUES (${r.name}, ${r.date.toString()}, ${r.executionId}, ${r.status}, ${JSON.stringify(r.stats)})
          ON CONFLICT (routine_name, business_date) DO UPDATE SET execution_id = EXCLUDED.execution_id,
            status = EXCLUDED.status, stats = EXCLUDED.stats`.execute(trx);
      },

      async rulesAt(instrumentId, at) {
        const { rows } = await sql<{ instrument_id: string | null; rules: Partial<SessionRules> }>`
          SELECT DISTINCT ON (instrument_id) instrument_id, rules FROM trading_rule_version
          WHERE (instrument_id IS NULL OR instrument_id = ${instrumentId}) AND valid_from <= ${at.toString()}
          ORDER BY instrument_id, valid_from DESC`.execute(trx);
        return resolveRules(
          rows.find((r) => r.instrument_id === null)?.rules ?? null,
          rows.find((r) => r.instrument_id !== null)?.rules ?? null,
        );
      },
      async insertRuleVersion(r) {
        await sql`
          INSERT INTO trading_rule_version (rule_id, instrument_id, rules, valid_from)
          VALUES (${r.ruleId}, ${r.instrumentId}, ${JSON.stringify(r.rules)}, ${r.validFrom.toString()})
          ON CONFLICT (rule_id) DO NOTHING`.execute(trx);
      },

      async watch() {
        const { rows } = await sql<Row>`SELECT * FROM market_watch WHERE id = 1`.execute(trx);
        const r = rows[0]!;
        return {
          indexLast: dec(r['index_last']),
          indexPreviousClose: dec(r['index_previous_close']),
          indexQuoteTime: instOrNull(r['index_quote_time']),
          lastMarketDataAt: instOrNull(r['last_market_data_at']),
          budgetLevel: r['budget_level'] as string,
        };
      },
      async saveIndex(i) {
        await sql`
          UPDATE market_watch SET index_last = ${i.last}, index_previous_close = ${i.previousClose},
            index_quote_time = ${i.quoteTime.toString()}
          WHERE id = 1`.execute(trx);
      },
      async touchMarketData(at) {
        await sql`UPDATE market_watch SET last_market_data_at = ${at.toString()} WHERE id = 1`.execute(
          trx,
        );
      },
      async saveBudgetLevel(level) {
        await sql`UPDATE market_watch SET budget_level = ${level} WHERE id = 1`.execute(trx);
      },

      async insertAlert(a) {
        const res = await sql`
          INSERT INTO session_alert (id, kind, dedupe_key, message, data, created_at)
          VALUES (${a.id}, ${a.kind}, ${a.dedupeKey}, ${a.message}, ${JSON.stringify(a.data)}, ${a.createdAt.toString()})
          ON CONFLICT (dedupe_key) DO NOTHING`.execute(trx);
        return Number(res.numAffectedRows ?? 0n) > 0;
      },
      async alerts(limit) {
        const { rows } = await sql<Row>`
          SELECT * FROM session_alert ORDER BY created_at DESC, id LIMIT ${limit}`.execute(trx);
        return rows.map(toAlert);
      },

      async insertChangeRequest(r) {
        await sql`
          INSERT INTO session_change_request (id, type, payload, current_state, justification, maker_id, status, created_at, expires_at)
          VALUES (${r.id}, ${r.type}, ${JSON.stringify(r.payload)}, ${JSON.stringify(r.currentState)}, ${r.justification},
            ${r.makerId}, ${r.status}, ${r.createdAt.toString()}, ${r.expiresAt.toString()})`.execute(
          trx,
        );
      },
      async saveChangeRequest(r) {
        await sql`
          UPDATE session_change_request SET status = ${r.status}, decided_by = ${r.decidedBy},
            decided_at = ${iso(r.decidedAt)}, decision_reason = ${r.decisionReason}
          WHERE id = ${r.id}`.execute(trx);
      },
      async changeRequest(id, opts) {
        const { rows } = await sql<Row>`
          SELECT * FROM session_change_request WHERE id = ${id}${lock(opts)}`.execute(trx);
        return rows[0] ? toRequest(rows[0]) : null;
      },
      async changeRequests(status, limit) {
        const { rows } = await sql<Row>`
          SELECT * FROM session_change_request ${status ? sql`WHERE status = ${status}` : sql``}
          ORDER BY created_at DESC LIMIT ${limit}`.execute(trx);
        return rows.map(toRequest);
      },
      async duePendingRequests(now, limit) {
        const { rows } = await sql<Row>`
          SELECT * FROM session_change_request WHERE status = 'PENDING' AND expires_at <= ${now.toString()}
          ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`.execute(trx);
        return rows.map(toRequest);
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
