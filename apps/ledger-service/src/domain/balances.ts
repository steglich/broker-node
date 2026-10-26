import type { TradingCalendar } from '@broker/calendar';
import { type BusinessDate, Money } from '@broker/domain-kernel';

/** D0 (o dia útil corrente), D1 e D2 pelo calendário (Financeiro §4). */
export interface SettlementDays {
  d0: BusinessDate;
  d1: BusinessDate;
  d2: BusinessDate;
}

/**
 * Fora de dia útil (fim de semana, feriado), o "dia útil corrente" é o próximo: é nele que o
 * dinheiro pendente passa a contar.
 */
export function settlementDays(calendar: TradingCalendar, today: BusinessDate): SettlementDays {
  const d0 = calendar.isBusinessDay(today) ? today : calendar.nextBusinessDay(today);
  return { d0, d1: calendar.nextBusinessDay(d0), d2: calendar.nextBusinessDay(d0, 2) };
}

/** O que o banco soma para uma conta: liquidado e pendentes por data-valor. */
export interface BalanceInputs {
  settled: Money;
  pending: readonly { valueDate: BusinessDate; amount: Money }[];
}

export interface Balances {
  settled: Money;
  projected: { d0: Money; d1: Money; d2: Money };
  projectedTotal: Money;
  holds: Money;
  withdrawable: Money;
}

/**
 * Saldos da `CUST_CASH` (Financeiro §4, RN-LED-020):
 *
 * - `projected(Dn)` = liquidado + pendentes com `value_date ≤ Dn`;
 * - `withdrawable` = max(0, min(liquidado, P(D0), P(D1), P(D2)) − holds que afetam saque): nunca
 *   inclui crédito não liquidado nem deixa um dia futuro negativo por causa do saque.
 */
export function computeBalances(
  input: BalanceInputs,
  days: SettlementDays,
  holds: Money,
): Balances {
  const zero = Money.zero(input.settled.currency);
  const upTo = (day: BusinessDate) =>
    input.pending
      .filter((p) => !p.valueDate.isAfter(day))
      .reduce((acc, p) => acc.plus(p.amount), input.settled);
  const projected = { d0: upTo(days.d0), d1: upTo(days.d1), d2: upTo(days.d2) };
  const projectedTotal = input.pending.reduce((acc, p) => acc.plus(p.amount), input.settled);
  const floor = [input.settled, projected.d0, projected.d1, projected.d2].reduce((a, b) =>
    b.compare(a) < 0 ? b : a,
  );
  const free = floor.minus(holds);
  return {
    settled: input.settled,
    projected,
    projectedTotal,
    holds,
    withdrawable: free.compare(zero) > 0 ? free : zero,
  };
}
