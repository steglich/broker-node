/** Fases do pregão (Pregão §4.1), como a sessão publica. */
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

/** A mesma ordem da sessão (RN-SES-001): quanto maior, mais restritiva. */
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

/**
 * Motor §6.6: `FULL` cota completo; `SINGLE` só o nível 1 em `ref ± meio_spread`; `PLAN` calcula sem
 * enviar; `NONE` não cota. `AFTER_MARKET` não está na tabela e fica desativada (Pregão §4.1).
 */
export type QuoteMode = 'FULL' | 'SINGLE' | 'PLAN' | 'NONE';

export function quoteMode(phase: Phase): QuoteMode {
  switch (phase) {
    case 'CONTINUOUS':
      return 'FULL';
    case 'PRE_OPENING':
    case 'CLOSING_CALL':
    case 'VOLATILITY_AUCTION':
      return 'SINGLE';
    case 'PRE_TRADING':
      return 'PLAN';
    default:
      return 'NONE';
  }
}
