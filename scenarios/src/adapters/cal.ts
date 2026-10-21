import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { BusinessDate } from '@broker/domain-kernel';
import type { ScenarioAdapter } from '../runner.js';

type Query =
  | { id: string; op: 'next_business_day' | 'previous_business_day'; data: string; n?: number }
  | { id: string; op: 'is_business_day' | 'day_type'; data: string }
  | { id: string; op: 'business_days_between'; de: string; ate: string };

interface CalInputs {
  calendario: 'b3-2026-2027';
  consultas: Query[];
}

const calendars = { 'b3-2026-2027': () => new TradingCalendar(b3Calendar2026To2027) };

/** Calendário (CAL-*): cada consulta tem um `id`, e a saída é `resultados.<id>`. */
export const calAdapter: ScenarioAdapter = (raw) => {
  const inputs = raw as CalInputs;
  const factory = calendars[inputs.calendario];
  if (!factory) throw new Error(`calendário desconhecido: ${String(inputs.calendario)}`);
  const cal = factory();
  const d = BusinessDate.parse;
  const resultados: Record<string, unknown> = {};
  for (const q of inputs.consultas) {
    switch (q.op) {
      case 'next_business_day':
        resultados[q.id] = cal.nextBusinessDay(d(q.data), q.n ?? 1).toString();
        break;
      case 'previous_business_day':
        resultados[q.id] = cal.previousBusinessDay(d(q.data), q.n ?? 1).toString();
        break;
      case 'is_business_day':
        resultados[q.id] = cal.isBusinessDay(d(q.data));
        break;
      case 'day_type':
        resultados[q.id] = cal.dayType(d(q.data));
        break;
      case 'business_days_between':
        resultados[q.id] = cal.businessDaysBetween(d(q.de), d(q.ate));
        break;
    }
  }
  return { resultados };
};
