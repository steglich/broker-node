import type { ScheduledPhase } from '@broker/calendar';

/** Fases do pregão (Pregão §4.1). `AFTER_MARKET` existe no contrato, mas fica desativada (Q-04). */
export type Phase =
  | 'CLOSED'
  | 'PRE_TRADING'
  | 'PRE_OPENING'
  | 'CONTINUOUS'
  | 'CLOSING_CALL'
  | 'POST_CLOSE'
  | 'AFTER_MARKET'
  | 'VOLATILITY_AUCTION'
  | 'HALTED';

/**
 * Ordem de restrição pelo que cada fase permite na tabela do Pregão §4.1 (ordens aceitas, execução,
 * cancelamento): quanto maior, mais restritiva. Em `CLOSED` e `PRE_TRADING` ainda entram agendadas e
 * o cancelamento é livre; `POST_CLOSE` só agenda para D+1; `HALTED` só cancela.
 */
const RESTRICTION: Record<Phase, number> = {
  CONTINUOUS: 0,
  VOLATILITY_AUCTION: 1,
  PRE_OPENING: 2,
  CLOSING_CALL: 3,
  PRE_TRADING: 4,
  CLOSED: 5,
  AFTER_MARKET: 6,
  POST_CLOSE: 7,
  HALTED: 8,
};

/** RN-SES-001: a fase efetiva é a mais restritiva entre o mercado e o instrumento. */
export function effectivePhase(market: Phase, instrument: Phase | null): Phase {
  if (instrument === null) return market;
  return RESTRICTION[instrument] > RESTRICTION[market] ? instrument : market;
}

/** Rotinas de fase do agendador (Pregão §8) → a fase da grade que cada uma inicia. */
export const ROUTINE_PHASES: Readonly<Record<string, ScheduledPhase>> = {
  pre_trading: 'PRE_TRADING',
  pre_opening: 'PRE_OPENING',
  continuous: 'CONTINUOUS',
  closing_call: 'CLOSING_CALL',
  post_close: 'POST_CLOSE',
  session_close: 'CLOSED',
};

export const CALENDAR_CHECK_ROUTINE = 'calendar_check';
