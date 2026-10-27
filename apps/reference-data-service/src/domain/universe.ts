import { ReferenceRuleError } from './errors.js';
import type { Instrument } from './instrument.js';

/** RN-INS-011: padrão do plano gratuito da brapi; configurável conforme o plano. */
export const DEFAULT_MAX_TRADABLE_INSTRUMENTS = 20;

/** RN-INS-011/012: incluir só abaixo do limite do universo e nunca um instrumento deslistado. */
export function assertCanInclude(i: Instrument, tradableCount: number, max: number): void {
  if (i.tradable)
    throw new ReferenceRuleError('ALREADY_TRADABLE', `${i.symbol} já está no universo negociável.`);
  if (i.status === 'DELISTED')
    throw new ReferenceRuleError('INSTRUMENT_DELISTED', `${i.symbol} está deslistado.`);
  if (tradableCount >= max)
    throw new ReferenceRuleError(
      'TRADABLE_UNIVERSE_FULL',
      `O universo negociável já tem ${tradableCount} de ${max} instrumentos: o limite vem do ` +
        'orçamento de requisições da brapi. Retire um instrumento ou aumente o plano.',
      { tradableCount, max },
    );
}

/** RN-INS-013: retirar só sem ordens abertas; as posições continuam em custódia. */
export function assertCanRemove(i: Instrument, openOrders: number): void {
  if (!i.tradable)
    throw new ReferenceRuleError('NOT_TRADABLE', `${i.symbol} não está no universo negociável.`);
  if (openOrders > 0)
    throw new ReferenceRuleError(
      'INSTRUMENT_HAS_OPEN_ORDERS',
      `${i.symbol} tem ${openOrders} ordem(ns) aberta(s); cancele-as antes de retirar.`,
      { openOrders },
    );
}
