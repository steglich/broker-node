import { RiskBuyingPowerChangedV1 } from '@broker/contracts/events/risk.buying_power_changed/v1';
import { RiskHoldAdjustedV1 } from '@broker/contracts/events/risk.hold_adjusted/v1';
import { RiskHoldConsumedV1 } from '@broker/contracts/events/risk.hold_consumed/v1';
import { RiskHoldCreatedV1 } from '@broker/contracts/events/risk.hold_created/v1';
import { RiskHoldReleasedV1 } from '@broker/contracts/events/risk.hold_released/v1';
import { RiskPretradeApprovedV1 } from '@broker/contracts/events/risk.pretrade_approved/v1';
import { RiskPretradeRejectedV1 } from '@broker/contracts/events/risk.pretrade_rejected/v1';
import { Decimal, Instant } from '@broker/domain-kernel';
import type { EventDefinition, EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type {
  PreTradeResponse,
  RiskEvent,
  RiskStore,
  RiskTx,
  RiskUnit,
  TradeRow,
} from '../application/ports.js';
import type { Hold, HoldStatus, HoldType, ReferenceType } from '../domain/holds.js';
import {
  emptyProjection,
  tradeKey,
  unbookedValue,
  type AccountProjection,
  type Side,
  type UnbookedTrade,
} from '../domain/projection.js';

type Row = Record<string, unknown>;

const EVENTS: Record<RiskEvent['type'], EventDefinition> = {
  'risk.hold_created': RiskHoldCreatedV1,
  'risk.hold_adjusted': RiskHoldAdjustedV1,
  'risk.hold_released': RiskHoldReleasedV1,
  'risk.hold_consumed': RiskHoldConsumedV1,
  'risk.pretrade_approved': RiskPretradeApprovedV1,
  'risk.pretrade_rejected': RiskPretradeRejectedV1,
  'risk.buying_power_changed': RiskBuyingPowerChangedV1,
};
const ACTOR = { type: 'SYSTEM' as const, id: 'risk-service' };

const inst = (v: unknown): Instant => Instant.ofEpochMillis((v as Date).getTime());
const numOrNull = (v: unknown) => (v === null ? null : Number(v));
/** `date` chega como `Date` à meia-noite local: as partes locais são a própria data. */
const dateText = (v: unknown): string => {
  if (!(v instanceof Date)) return v as string;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};

const toHold = (r: Row): Hold => ({
  id: r['id'] as string,
  accountId: r['account_id'] as string,
  type: r['type'] as HoldType,
  resource: r['resource'] as string,
  originalAmount: r['original_amount'] as Decimal,
  remainingAmount: r['remaining_amount'] as Decimal,
  originalQuantity: numOrNull(r['original_quantity']),
  remainingQuantity: numOrNull(r['remaining_quantity']),
  referenceType: r['reference_type'] as ReferenceType,
  referenceId: r['reference_id'] as string,
  status: r['status'] as HoldStatus,
  createdAt: inst(r['created_at']),
  updatedAt: inst(r['updated_at']),
});

const toTradeRow = (r: Row): TradeRow => ({
  tradeId: r['trade_id'] as string,
  side: r['side'] as Side,
  accountId: r['account_id'] as string,
  instrumentId: (r['instrument_id'] as string | null) ?? null,
  quantity: Number(r['quantity']),
  notional: r['notional'] as Decimal,
  estimatedCost: r['estimated_cost'] as Decimal,
  tradingDate: r['trading_date'] ? dateText(r['trading_date']) : '',
  executed: r['executed'] as boolean,
  booked: r['booked'] as boolean,
  feesBooked: r['fees_booked'] as boolean,
  busted: r['busted'] as boolean,
});

const toUnbooked = (t: TradeRow): UnbookedTrade => ({
  tradeId: t.tradeId,
  side: t.side,
  instrumentId: t.instrumentId!,
  quantity: t.quantity,
  notional: t.notional,
  estimatedCost: t.estimatedCost,
  tradingDate: t.tradingDate,
  booked: t.booked,
  feesBooked: t.feesBooked,
});

/** Monta as projeções das contas das linhas lidas (uma conta ou, ao assumir, todas). */
async function readProjections(
  db: Kysely<unknown>,
  where: (column: string) => RawBuilder<unknown>,
): Promise<Map<string, AccountProjection>> {
  const accounts = new Map<string, AccountProjection>();
  const of = (id: string) => {
    let p = accounts.get(id);
    if (!p) {
      p = emptyProjection(id);
      accounts.set(id, p);
    }
    return p;
  };
  const rows = async (query: RawBuilder<unknown>) => (await query.execute(db)).rows as Row[];
  for (const r of await rows(
    sql`SELECT * FROM account_risk_projection WHERE ${where('account_id')}`,
  )) {
    const p = of(r['account_id'] as string);
    p.status = (r['account_status'] as string | null) ?? null;
    p.settled = r['settled_balance'] as Decimal;
    p.d0 = r['projected_d0'] as Decimal;
    p.d1 = r['projected_d1'] as Decimal;
    p.d2 = r['projected_d2'] as Decimal;
    p.lastLedgerSeq = Number(r['last_ledger_seq']);
  }
  for (const r of await rows(sql`SELECT * FROM risk_position WHERE ${where('account_id')}`))
    of(r['account_id'] as string).positions.set(
      r['instrument_id'] as string,
      Number(r['quantity']),
    );
  for (const r of await rows(sql`
    SELECT * FROM risk_trade
    WHERE ${where('account_id')} AND executed AND NOT busted AND NOT (booked AND fees_booked)`)) {
    const t = toUnbooked(toTradeRow(r));
    const p = of(r['account_id'] as string);
    p.trades.set(tradeKey(t.tradeId, t.side), t);
    p.unbooked = p.unbooked.plus(unbookedValue(t));
  }
  for (const r of await rows(sql`
    SELECT * FROM hold WHERE ${where('account_id')} AND status = 'ACTIVE'`)) {
    const h = toHold(r);
    of(h.accountId).holds.set(h.id, h);
  }
  for (const r of await rows(sql`
    SELECT account_id, reference_id FROM hold_reference
    WHERE ${where('account_id')} AND reference_type = 'ORDER' AND terminal_at IS NULL`))
    of(r['account_id'] as string).openOrders.add(r['reference_id'] as string);
  return accounts;
}

export class PostgresRiskStore implements RiskStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: RiskTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)), { retries: 3 });
  }

  async begin(): Promise<RiskUnit> {
    const trx = await this.db.startTransaction().execute();
    return {
      tx: this.tx(trx),
      commit: () => trx.commit().execute(),
      rollback: () => trx.rollback().execute(),
    };
  }

  async bumpEpoch(): Promise<number> {
    const { rows } = await sql<{ epoch: bigint }>`
      UPDATE risk_leader SET epoch = epoch + 1 WHERE id = 1 RETURNING epoch`.execute(this.db);
    return Number(rows[0]!.epoch);
  }

  async loadAll() {
    const accounts = await readProjections(this.db, () => sql`true`);
    const { rows } = await sql<Row>`SELECT * FROM risk_price`.execute(this.db);
    return {
      accounts: [...accounts.values()],
      prices: rows.map((r) => ({
        instrumentId: r['instrument_id'] as string,
        price: r['price'] as Decimal,
        seq: Number(r['seq']),
      })),
    };
  }

  /** A mesma unidade de trabalho sobre uma transação já aberta (consumidor de eventos). */
  tx(trx: Kysely<unknown>): RiskTx {
    const publisher = this.publisher;
    const one = async (query: RawBuilder<unknown>) =>
      ((await query.execute(trx)).rows[0] as Row | undefined) ?? null;

    return {
      async holdsEpoch(epoch) {
        const r = await one(sql`SELECT epoch FROM risk_leader WHERE id = 1 FOR SHARE`);
        return Number(r!['epoch']) === epoch;
      },

      async lockAccount(accountId) {
        await sql`
          INSERT INTO account_risk_projection (account_id) VALUES (${accountId})
          ON CONFLICT (account_id) DO NOTHING`.execute(trx);
        await sql`
          SELECT 1 FROM account_risk_projection WHERE account_id = ${accountId} FOR UPDATE`.execute(
          trx,
        );
      },
      async loadAccount(accountId) {
        const accounts = await readProjections(trx, (c) => sql`${sql.ref(c)} = ${accountId}`);
        return accounts.get(accountId) ?? emptyProjection(accountId);
      },
      async saveBalances(p) {
        await sql`
          UPDATE account_risk_projection
          SET settled_balance = ${p.settled}, projected_d0 = ${p.d0}, projected_d1 = ${p.d1},
              projected_d2 = ${p.d2}, last_ledger_seq = ${p.lastLedgerSeq}
          WHERE account_id = ${p.accountId}`.execute(trx);
      },
      async saveStatus(p) {
        await sql`
          UPDATE account_risk_projection SET account_status = ${p.status}
          WHERE account_id = ${p.accountId}`.execute(trx);
      },
      async savePosition(p, instrumentId) {
        await sql`
          INSERT INTO risk_position (account_id, instrument_id, quantity)
          VALUES (${p.accountId}, ${instrumentId}, ${p.positions.get(instrumentId) ?? 0})
          ON CONFLICT (account_id, instrument_id) DO UPDATE SET quantity = EXCLUDED.quantity`.execute(
          trx,
        );
      },

      async trade(tradeId, side) {
        const r = await one(sql`
          SELECT * FROM risk_trade WHERE trade_id = ${tradeId} AND side = ${side}`);
        return r ? toTradeRow(r) : null;
      },
      async tradeSides(tradeId) {
        const { rows } = await sql<Row>`
          SELECT * FROM risk_trade WHERE trade_id = ${tradeId} ORDER BY account_id, side`.execute(
          trx,
        );
        return rows.map(toTradeRow);
      },
      async saveTrade(t) {
        await sql`
          INSERT INTO risk_trade (trade_id, side, account_id, instrument_id, quantity, notional,
                                  estimated_cost, trading_date, executed, booked, fees_booked, busted)
          VALUES (${t.tradeId}, ${t.side}, ${t.accountId}, ${t.instrumentId}, ${t.quantity}, ${t.notional},
                  ${t.estimatedCost}, ${t.tradingDate || null}, ${t.executed}, ${t.booked}, ${t.feesBooked}, ${t.busted})
          ON CONFLICT (trade_id, side) DO UPDATE SET
            instrument_id = EXCLUDED.instrument_id, quantity = EXCLUDED.quantity,
            notional = EXCLUDED.notional, estimated_cost = EXCLUDED.estimated_cost,
            trading_date = EXCLUDED.trading_date, executed = EXCLUDED.executed,
            booked = EXCLUDED.booked, fees_booked = EXCLUDED.fees_booked, busted = EXCLUDED.busted`.execute(
          trx,
        );
      },
      async bookFees(accountId, upTo) {
        await sql`
          UPDATE risk_trade SET fees_booked = true
          WHERE account_id = ${accountId} AND executed AND trading_date <= ${upTo}`.execute(trx);
      },

      async hold(id, opts) {
        const r = await one(
          sql`SELECT * FROM hold WHERE id = ${id}${opts?.forUpdate ? sql` FOR UPDATE` : sql``}`,
        );
        return r ? toHold(r) : null;
      },
      async holdOfReference(type, id, holdType) {
        const r = await one(sql`
          SELECT * FROM hold
          WHERE reference_type = ${type} AND reference_id = ${id} AND type = ${holdType}`);
        return r ? toHold(r) : null;
      },
      async saveHold(h) {
        await sql`
          INSERT INTO hold (id, account_id, type, resource, original_amount, remaining_amount,
                            original_quantity, remaining_quantity, reference_type, reference_id,
                            status, created_at, updated_at)
          VALUES (${h.id}, ${h.accountId}, ${h.type}, ${h.resource}, ${h.originalAmount}, ${h.remainingAmount},
                  ${h.originalQuantity}, ${h.remainingQuantity}, ${h.referenceType}, ${h.referenceId},
                  ${h.status}, ${h.createdAt.toString()}, ${h.updatedAt.toString()})
          ON CONFLICT (id) DO UPDATE SET
            original_amount = EXCLUDED.original_amount, remaining_amount = EXCLUDED.remaining_amount,
            original_quantity = EXCLUDED.original_quantity,
            remaining_quantity = EXCLUDED.remaining_quantity,
            status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`.execute(trx);
      },

      async openReference(type, id, accountId) {
        await sql`
          INSERT INTO hold_reference (reference_type, reference_id, account_id)
          VALUES (${type}, ${id}, ${accountId})
          ON CONFLICT (reference_type, reference_id) DO NOTHING`.execute(trx);
        const r = await one(sql`
          SELECT terminal_at FROM hold_reference
          WHERE reference_type = ${type} AND reference_id = ${id}`);
        return r!['terminal_at'] === null;
      },
      async closeReference(type, id, accountId, status, at) {
        await sql`
          INSERT INTO hold_reference (reference_type, reference_id, account_id, status, terminal_at)
          VALUES (${type}, ${id}, ${accountId}, ${status}, ${at.toString()})
          ON CONFLICT (reference_type, reference_id) DO UPDATE
          SET status = EXCLUDED.status,
              terminal_at = coalesce(hold_reference.terminal_at, EXCLUDED.terminal_at)`.execute(
          trx,
        );
      },
      async orphanHolds(before, limit) {
        const { rows } = await sql<Row>`
          SELECT h.id, h.account_id FROM hold h
          JOIN hold_reference r
            ON r.reference_type = h.reference_type AND r.reference_id = h.reference_id
          WHERE h.status = 'ACTIVE' AND r.terminal_at <= ${before.toString()}
          ORDER BY r.terminal_at LIMIT ${limit}`.execute(trx);
        return rows.map((r) => ({ id: r['id'] as string, accountId: r['account_id'] as string }));
      },

      async decision(requestId) {
        const r = await one(sql`
          SELECT response FROM pretrade_decision WHERE request_id = ${requestId}`);
        return r ? (r['response'] as PreTradeResponse) : null;
      },
      async saveDecision(requestId, accountId, response, at) {
        await sql`
          INSERT INTO pretrade_decision (request_id, account_id, response, created_at)
          VALUES (${requestId}, ${accountId}, ${JSON.stringify(response)}::jsonb, ${at.toString()})`.execute(
          trx,
        );
      },

      async savePrice(instrumentId, price, seq) {
        const { rows } = await sql`
          INSERT INTO risk_price (instrument_id, price, seq) VALUES (${instrumentId}, ${price}, ${seq})
          ON CONFLICT (instrument_id) DO UPDATE SET price = EXCLUDED.price, seq = EXCLUDED.seq
          WHERE risk_price.seq < EXCLUDED.seq
          RETURNING instrument_id`.execute(trx);
        return rows.length > 0;
      },

      async publish(event, partitionKey) {
        await publisher.publish(trx, EVENTS[event.type], event.payload, {
          partitionKey,
          aggregateType: 'account',
          aggregateId: partitionKey,
          actor: ACTOR,
        });
      },
    };
  }
}
