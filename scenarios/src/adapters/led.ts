import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { Money } from '@broker/domain-kernel';
import { computeBalances, settlementDays } from '@broker/ledger-service/domain/balances';
import type { ScenarioAdapter } from '../runner.js';

interface LedInputs {
  calendario: 'b3-2026-2027';
  liquidado: string;
  holds: string;
  pendentes: { descricao: string; valor: string; dias_uteis: number }[];
}

const calendars = { 'b3-2026-2027': () => new TradingCalendar(b3Calendar2026To2027) };

/** Ledger (LED-*): saldos da CUST_CASH pelo domínio do ledger-service (Financeiro §4). */
export const ledAdapter: ScenarioAdapter = (raw, ctx) => {
  const inputs = raw as LedInputs;
  const factory = calendars[inputs.calendario];
  if (!factory) throw new Error(`calendário desconhecido: ${String(inputs.calendario)}`);
  const calendar = factory();
  const brl = (v: string) => Money.of(v, 'BRL');
  const days = settlementDays(calendar, ctx.clock.now().businessDate());
  const b = computeBalances(
    {
      settled: brl(inputs.liquidado),
      pending: inputs.pendentes.map((p) => ({
        valueDate: calendar.nextBusinessDay(days.d0, p.dias_uteis),
        amount: brl(p.valor),
      })),
    },
    days,
    brl(inputs.holds),
  );
  return {
    liquidado: b.settled.toString(),
    projetado: {
      d0: b.projected.d0.toString(),
      d1: b.projected.d1.toString(),
      d2: b.projected.d2.toString(),
    },
    projetado_total: b.projectedTotal.toString(),
    sacavel: b.withdrawable.toString(),
  };
};
