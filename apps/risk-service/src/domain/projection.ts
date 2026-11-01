import { Decimal } from '@broker/domain-kernel';
import { estimatedCosts, cents } from './costs.js';
import { isCashHold, type Hold } from './holds.js';

export type Side = 'BUY' | 'SELL';

/** Ponta de um negócio que ainda pesa em `U`: principal sem lançamento ou custos sem nota. */
export interface UnbookedTrade {
  tradeId: string;
  side: Side;
  instrumentId: string;
  quantity: number;
  notional: Decimal;
  estimatedCost: Decimal;
  tradingDate: string;
  /** O ledger lançou o principal: ele já está em `P2` (ADR-0003). */
  booked: boolean;
  /** O ledger lançou os custos da nota. */
  feesBooked: boolean;
}

/** Projeção de uma conta (Risco §4): tudo o que a decisão pré-trade lê, sem chamadas síncronas. */
export interface AccountProjection {
  accountId: string;
  /** `null` até chegar `account.opened`: sem status conhecido, nada é aprovado (RN-RSK-002). */
  status: string | null;
  settled: Decimal;
  d0: Decimal;
  d1: Decimal;
  d2: Decimal;
  /** Sequência da `CUST_CASH` já refletida nos saldos. */
  lastLedgerSeq: number;
  /** Chave `trade_id:side`: a mesma conta pode estar nas duas pontas de um negócio. */
  trades: Map<string, UnbookedTrade>;
  /** Soma de `trades` já com sinal: comprar reduz, vender aumenta, custos sempre reduzem. */
  unbooked: Decimal;
  positions: Map<string, number>;
  holds: Map<string, Hold>;
  openOrders: Set<string>;
}

export const emptyProjection = (accountId: string): AccountProjection => ({
  accountId,
  status: null,
  settled: new Decimal(0),
  d0: new Decimal(0),
  d1: new Decimal(0),
  d2: new Decimal(0),
  lastLedgerSeq: 0,
  trades: new Map(),
  unbooked: new Decimal(0),
  positions: new Map(),
  holds: new Map(),
  openOrders: new Set(),
});

export const tradeKey = (tradeId: string, side: Side): string => `${tradeId}:${side}`;

/** O que a ponta soma em `U` agora. */
export function unbookedValue(t: UnbookedTrade): Decimal {
  const principal = t.booked
    ? new Decimal(0)
    : t.side === 'SELL'
      ? t.notional
      : t.notional.negated();
  return t.feesBooked ? principal : principal.minus(t.estimatedCost);
}

export function buildTrade(input: {
  tradeId: string;
  side: Side;
  instrumentId: string;
  quantity: number;
  price: Decimal;
  tradingDate: string;
  booked: boolean;
}): UnbookedTrade {
  const notional = cents(input.price.times(input.quantity));
  return {
    tradeId: input.tradeId,
    side: input.side,
    instrumentId: input.instrumentId,
    quantity: input.quantity,
    notional,
    estimatedCost: estimatedCosts(notional),
    tradingDate: input.tradingDate,
    booked: input.booked,
    feesBooked: false,
  };
}

/** Troca a ponta (ou a retira, com `null`), mantendo `U` igual à soma das pontas. */
export function replaceTrade(p: AccountProjection, key: string, next: UnbookedTrade | null): void {
  const previous = p.trades.get(key);
  if (previous) p.unbooked = p.unbooked.minus(unbookedValue(previous));
  if (next && !(next.booked && next.feesBooked)) {
    p.trades.set(key, next);
    p.unbooked = p.unbooked.plus(unbookedValue(next));
  } else {
    p.trades.delete(key);
  }
}

export function movePosition(p: AccountProjection, instrumentId: string, delta: number): void {
  const quantity = (p.positions.get(instrumentId) ?? 0) + delta;
  if (quantity === 0) p.positions.delete(instrumentId);
  else p.positions.set(instrumentId, quantity);
}

const cashHolds = (p: AccountProjection): Decimal => {
  let total = new Decimal(0);
  for (const h of p.holds.values()) if (isCashHold(h)) total = total.plus(h.remainingAmount);
  return total;
};

/** `BP_cash = P2 + U − H` (RN-BP-001). Sem `G` e `L`, que são da margem (Fase 5). */
export const buyingPower = (p: AccountProjection): Decimal =>
  p.d2.plus(p.unbooked).minus(cashHolds(p));

/**
 * Sacável do Risco: o `withdrawable_balance` (Financeiro §4) com `P2 + U` no lugar de `P2`. Compra
 * executada e ainda não lançada já não está disponível, e venda do dia só libera em D+2: o menor dos
 * dois é o que não gasta o mesmo saldo (RN-RSK-004, RSK-030).
 */
export function withdrawable(p: AccountProjection): Decimal {
  const free = Decimal.min(p.settled, p.d0, p.d1, p.d2, p.d2.plus(p.unbooked)).minus(cashHolds(p));
  return Decimal.max(free, 0);
}

/** `Q_disp` (Risco §4.3). Sem `BTC_LENT`, que chega com o aluguel (Fase 5). */
export function availableQuantity(p: AccountProjection, instrumentId: string): number {
  let held = 0;
  for (const h of p.holds.values())
    if (h.type === 'ORDER_POSITION' && h.resource === instrumentId)
      held += h.remainingQuantity ?? 0;
  return (p.positions.get(instrumentId) ?? 0) - held;
}
