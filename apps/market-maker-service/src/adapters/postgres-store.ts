import { EngineCancelOrderV1 } from '@broker/contracts/events/engine.cancel_order/v1';
import { EngineNewOrderV1 } from '@broker/contracts/events/engine.new_order/v1';
import { SmmInstrumentActivatedV1 } from '@broker/contracts/events/smm.instrument_activated/v1';
import { SmmMetricsV1 } from '@broker/contracts/events/smm.metrics/v1';
import { SmmStatusChangedV1 } from '@broker/contracts/events/smm.status_changed/v1';
import { Decimal, Instant } from '@broker/domain-kernel';
import type { EventDefinition, EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type {
  ChangeRequest,
  Control,
  Fill,
  InstrumentState,
  SmmEvent,
  SmmStore,
  SmmTx,
} from '../application/ports.js';
import { resolveParams, type SmmParams } from '../domain/params.js';
import type { Phase } from '../domain/phases.js';
import type { Side } from '../domain/position.js';
import type { LiveOrder } from '../domain/quotes.js';

type Row = Record<string, unknown>;

const EVENTS: Record<SmmEvent['type'], EventDefinition> = {
  'engine.new_order': EngineNewOrderV1,
  'engine.cancel_order': EngineCancelOrderV1,
  'smm.status_changed': SmmStatusChangedV1,
  'smm.metrics': SmmMetricsV1,
  'smm.instrument_activated': SmmInstrumentActivatedV1,
};
const ACTOR = { type: 'SYSTEM' as const, id: 'market-maker-service' };

const inst = (v: unknown): Instant => Instant.ofEpochMillis((v as Date).getTime());
const instOrNull = (v: unknown): Instant | null => (v ? inst(v) : null);
const dec = (v: unknown) => (v as Decimal | null) ?? null;
const iso = (i: Instant | null) => i?.toString() ?? null;
const text = (d: Decimal | null) => d?.toFixed() ?? null;
const lock = (opts?: { forUpdate?: boolean }) => (opts?.forUpdate ? sql` FOR UPDATE` : sql``);

const toInstrument = (r: Row): InstrumentState => ({
  id: r['instrument_id'] as string,
  symbol: (r['symbol'] as string | null) ?? null,
  lotSize: (r['lot_size'] as number | null) ?? null,
  tickSize: dec(r['tick_size']),
  oddLot: r['odd_lot'] as boolean,
  tradable: r['tradable'] as boolean,
  status: r['status'] as string,
  enabled: r['enabled'] as boolean,
  activatedAt: instOrNull(r['activated_at']),
  initialStock: Number(r['initial_stock']),
  ownPhase: (r['own_phase'] as Phase | null) ?? null,
  reference: dec(r['reference_price']),
  referenceSeq: Number(r['reference_seq']),
  externalQuoteTime: instOrNull(r['external_quote_time']),
  staleSince: instOrNull(r['stale_since']),
  staleAt: instOrNull(r['stale_at']),
  stopped: r['stopped'] as boolean,
  bandReference: dec(r['band_reference']),
  rejectionBandPct: dec(r['rejection_band_pct']),
  position: {
    inventory: Number(r['inventory']),
    averageCost: r['average_cost'] as Decimal,
    cashFlow: r['cash_flow'] as Decimal,
    realizedPnl: r['realized_pnl'] as Decimal,
    volume: Number(r['volume']),
  },
  liveOrders: r['live_orders'] as LiveOrder[],
  lastReference: dec(r['last_reference']),
  lastRequoteAt: instOrNull(r['last_requote_at']),
  spreadMultiplier: r['spread_multiplier'] as number,
  bestBid: dec(r['best_bid']),
  bestAsk: dec(r['best_ask']),
  requotes: Number(r['requotes']),
  quotedMs: Number(r['quoted_ms']),
  quotedSince: instOrNull(r['quoted_since']),
});

const toControl = (r: Row): Control => ({
  marketPhase: r['market_phase'] as Phase,
  globalEnabled: r['global_enabled'] as boolean,
});

const toRequest = (r: Row): ChangeRequest => ({
  id: r['id'] as string,
  type: r['type'] as ChangeRequest['type'],
  payload: r['payload'] as Record<string, unknown>,
  currentState: r['current_state'] as string,
  justification: r['justification'] as string,
  makerId: r['maker_id'] as string,
  status: r['status'] as ChangeRequest['status'],
  createdAt: inst(r['created_at']),
  expiresAt: inst(r['expires_at']),
  decidedBy: (r['decided_by'] as string | null) ?? null,
  decidedAt: instOrNull(r['decided_at']),
  decisionReason: (r['decision_reason'] as string | null) ?? null,
});

const toFill = (r: Row): Fill => ({
  tradeId: r['trade_id'] as string,
  side: r['side'] as Side,
  instrumentId: r['instrument_id'] as string,
  quantity: Number(r['quantity']),
  price: r['price'] as Decimal,
  engineSeq: Number(r['engine_seq']),
  executedAt: inst(r['executed_at']),
});

export class PostgresSmmStore implements SmmStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: SmmTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  /** A unidade de trabalho numa transação já aberta (a do consumidor, com a inbox). */
  tx(trx: Kysely<unknown>): SmmTx {
    const publisher = this.publisher;
    return {
      async control() {
        const { rows } = await sql<Row>`SELECT * FROM smm_control WHERE id = 1`.execute(trx);
        return toControl(rows[0]!);
      },
      async lockControl() {
        const { rows } = await sql<Row>`SELECT * FROM smm_control WHERE id = 1 FOR UPDATE`.execute(
          trx,
        );
        return toControl(rows[0]!);
      },
      async saveControl(c) {
        await sql`
          UPDATE smm_control SET market_phase = ${c.marketPhase}, global_enabled = ${c.globalEnabled}
          WHERE id = 1`.execute(trx);
      },

      async lockInstrument(id) {
        await sql`INSERT INTO smm_state (instrument_id) VALUES (${id}) ON CONFLICT DO NOTHING`.execute(
          trx,
        );
        const { rows } =
          await sql<Row>`SELECT * FROM smm_state WHERE instrument_id = ${id} FOR UPDATE`.execute(
            trx,
          );
        return toInstrument(rows[0]!);
      },
      async instrument(id) {
        const { rows } =
          await sql<Row>`SELECT * FROM smm_state WHERE instrument_id = ${id}`.execute(trx);
        return rows[0] ? toInstrument(rows[0]) : null;
      },
      async instrumentIds() {
        const { rows } = await sql<{ instrument_id: string }>`
          SELECT instrument_id FROM smm_state WHERE activated_at IS NOT NULL ORDER BY instrument_id`.execute(
          trx,
        );
        return rows.map((r) => r.instrument_id);
      },
      async saveInstrument(i) {
        await sql`
          UPDATE smm_state SET
            symbol = ${i.symbol}, lot_size = ${i.lotSize}, tick_size = ${text(i.tickSize)},
            odd_lot = ${i.oddLot}, tradable = ${i.tradable}, status = ${i.status}, enabled = ${i.enabled},
            activated_at = ${iso(i.activatedAt)}, initial_stock = ${i.initialStock}, own_phase = ${i.ownPhase},
            reference_price = ${text(i.reference)}, reference_seq = ${i.referenceSeq},
            external_quote_time = ${iso(i.externalQuoteTime)}, stale_since = ${iso(i.staleSince)},
            stale_at = ${iso(i.staleAt)}, stopped = ${i.stopped}, band_reference = ${text(i.bandReference)},
            rejection_band_pct = ${text(i.rejectionBandPct)}, inventory = ${i.position.inventory},
            average_cost = ${i.position.averageCost.toFixed()}, cash_flow = ${i.position.cashFlow.toFixed()},
            realized_pnl = ${i.position.realizedPnl.toFixed()}, volume = ${i.position.volume},
            live_orders = ${JSON.stringify(i.liveOrders)}, last_reference = ${text(i.lastReference)},
            last_requote_at = ${iso(i.lastRequoteAt)}, spread_multiplier = ${i.spreadMultiplier},
            best_bid = ${text(i.bestBid)}, best_ask = ${text(i.bestAsk)}, requotes = ${i.requotes},
            quoted_ms = ${i.quotedMs}, quoted_since = ${iso(i.quotedSince)}
          WHERE instrument_id = ${i.id}`.execute(trx);
      },

      async paramsAt(instrumentId, at) {
        const { rows } = await sql<{ instrument_id: string | null; params: Partial<SmmParams> }>`
          SELECT instrument_id, params FROM smm_parameters
          WHERE (instrument_id IS NULL OR instrument_id = ${instrumentId})
            AND valid_from <= ${at.toString()}
          ORDER BY valid_from, id`.execute(trx);
        return resolveParams(
          rows.filter((r) => r.instrument_id === null).map((r) => r.params),
          rows.filter((r) => r.instrument_id !== null).map((r) => r.params),
        );
      },
      async insertParams(p) {
        const res = await sql`
          INSERT INTO smm_parameters (id, instrument_id, params, valid_from, approval_request_id)
          VALUES (${p.id}, ${p.instrumentId}, ${JSON.stringify(p.params)}, ${p.validFrom.toString()}, ${p.approvalRequestId})
          ON CONFLICT (id) DO NOTHING`.execute(trx);
        return Number(res.numAffectedRows ?? 0n) > 0;
      },

      async applyBookChange(c) {
        await sql`INSERT INTO smm_state (instrument_id) VALUES (${c.instrumentId}) ON CONFLICT DO NOTHING`.execute(
          trx,
        );
        const res = await sql`
          UPDATE smm_state SET book_seq = ${c.engineSeq}
          WHERE instrument_id = ${c.instrumentId} AND book_seq < ${c.engineSeq}`.execute(trx);
        if (Number(res.numAffectedRows ?? 0n) === 0) return false;
        if (c.quantity === 0)
          await sql`
            DELETE FROM smm_book_level
            WHERE instrument_id = ${c.instrumentId} AND side = ${c.side} AND price = ${c.price.toFixed()}`.execute(
            trx,
          );
        else
          await sql`
            INSERT INTO smm_book_level (instrument_id, side, price, quantity)
            VALUES (${c.instrumentId}, ${c.side}, ${c.price.toFixed()}, ${c.quantity})
            ON CONFLICT (instrument_id, side, price) DO UPDATE SET quantity = EXCLUDED.quantity`.execute(
            trx,
          );
        return true;
      },
      async bookLevels(instrumentId) {
        const { rows } = await sql<Row>`
          SELECT side, price, quantity FROM smm_book_level WHERE instrument_id = ${instrumentId}`.execute(
          trx,
        );
        return rows.map((r) => ({
          side: r['side'] as Side,
          price: new Decimal(r['price'] as Decimal),
          quantity: Number(r['quantity']),
        }));
      },

      async insertFill(f) {
        const res = await sql`
          INSERT INTO smm_fill (trade_id, side, instrument_id, quantity, price, engine_seq, executed_at)
          VALUES (${f.tradeId}, ${f.side}, ${f.instrumentId}, ${f.quantity}, ${f.price.toFixed()}, ${f.engineSeq}, ${f.executedAt.toString()})
          ON CONFLICT (trade_id, side) DO NOTHING`.execute(trx);
        return Number(res.numAffectedRows ?? 0n) > 0;
      },
      async bustFills(tradeId) {
        const res = await sql`
          UPDATE smm_fill SET busted = true WHERE trade_id = ${tradeId} AND NOT busted`.execute(
          trx,
        );
        return Number(res.numAffectedRows ?? 0n) > 0;
      },
      async fills(instrumentId) {
        const { rows } = await sql<Row>`
          SELECT * FROM smm_fill WHERE instrument_id = ${instrumentId} AND NOT busted
          ORDER BY executed_at, engine_seq, side`.execute(trx);
        return rows.map(toFill);
      },

      async insertChangeRequest(r) {
        await sql`
          INSERT INTO smm_change_request (id, type, payload, current_state, justification, maker_id, status, created_at, expires_at)
          VALUES (${r.id}, ${r.type}, ${JSON.stringify(r.payload)}, ${r.currentState}, ${r.justification},
            ${r.makerId}, ${r.status}, ${r.createdAt.toString()}, ${r.expiresAt.toString()})`.execute(
          trx,
        );
      },
      async saveChangeRequest(r) {
        await sql`
          UPDATE smm_change_request SET status = ${r.status}, decided_by = ${r.decidedBy},
            decided_at = ${iso(r.decidedAt)}, decision_reason = ${r.decisionReason}
          WHERE id = ${r.id}`.execute(trx);
      },
      async changeRequest(id, opts) {
        const { rows } = await sql<Row>`
          SELECT * FROM smm_change_request WHERE id = ${id}${lock(opts)}`.execute(trx);
        return rows[0] ? toRequest(rows[0]) : null;
      },
      async changeRequests(status, limit) {
        const { rows } = await sql<Row>`
          SELECT * FROM smm_change_request ${status ? sql`WHERE status = ${status}` : sql``}
          ORDER BY created_at DESC LIMIT ${limit}`.execute(trx);
        return rows.map(toRequest);
      },
      async duePendingRequests(now, limit) {
        const { rows } = await sql<Row>`
          SELECT * FROM smm_change_request WHERE status = 'PENDING' AND expires_at <= ${now.toString()}
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
