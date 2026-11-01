import type { Decimal } from '@broker/domain-kernel';

export type CloseSource = 'CLOSING_CALL' | 'LAST_TRADE' | 'PREVIOUS_CLOSE';

/** RN-FCH-001: call de fechamento, senão último negócio do contínuo, senão `previous_close`. */
export function closingPrice(input: {
  closingCall: Decimal | null;
  lastContinuousTrade: Decimal | null;
  previousClose: Decimal | null;
}): { price: Decimal; source: CloseSource } | null {
  if (input.closingCall) return { price: input.closingCall, source: 'CLOSING_CALL' };
  if (input.lastContinuousTrade) return { price: input.lastContinuousTrade, source: 'LAST_TRADE' };
  if (input.previousClose) return { price: input.previousClose, source: 'PREVIOUS_CLOSE' };
  return null;
}

/** RN-FCH-003: o fechamento interno diverge do externo em mais de `limit` (0,05 = 5%)? */
export function closeDiverges(internal: Decimal, external: Decimal, limit: Decimal): boolean {
  return internal.minus(external).abs().greaterThan(external.times(limit));
}
