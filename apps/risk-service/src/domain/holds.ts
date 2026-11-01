import { Decimal, type Instant } from '@broker/domain-kernel';
import { cents } from './costs.js';

export type HoldType = 'ORDER_CASH' | 'ORDER_POSITION' | 'WITHDRAWAL';
export type HoldStatus = 'ACTIVE' | 'CONSUMED' | 'RELEASED';
export type ReferenceType = 'ORDER' | 'WITHDRAWAL';

/** Reserva sobre saldo ou ativo (RN-HLD-001). `resource` é `CASH` ou o `instrument_id`. */
export interface Hold {
  id: string;
  accountId: string;
  type: HoldType;
  resource: string;
  originalAmount: Decimal;
  remainingAmount: Decimal;
  /** Quantidade da ordem; `null` no saque. É a base da redução proporcional. */
  originalQuantity: number | null;
  remainingQuantity: number | null;
  referenceType: ReferenceType;
  referenceId: string;
  status: HoldStatus;
  createdAt: Instant;
  updatedAt: Instant;
}

export const isCashHold = (h: Hold): boolean => h.resource === 'CASH';

/**
 * Tira `quantity` do que resta do hold: execução (`CONSUMED`) ou cancelamento (`RELEASED`) quando zera.
 *
 * O valor restante sai sempre do original, pela proporção (RN-HLD-004): sem acumular arredondamento,
 * e a diferença entre o preço reservado e o executado volta ao poder de compra. As duas causas são
 * comutativas, porque execução e cancelamento chegam por tópicos diferentes, sem ordem entre si.
 */
export function reduceHold(
  hold: Hold,
  quantity: number,
  cause: 'FILL' | 'CANCEL',
  at: Instant,
): Hold {
  if (hold.status !== 'ACTIVE' || hold.remainingQuantity === null || hold.originalQuantity === null)
    return hold;
  const remainingQuantity = Math.max(0, hold.remainingQuantity - quantity);
  const done = remainingQuantity === 0;
  return {
    ...hold,
    remainingQuantity,
    remainingAmount: done
      ? new Decimal(0)
      : cents(hold.originalAmount.times(remainingQuantity).dividedBy(hold.originalQuantity)),
    status: done ? (cause === 'FILL' ? 'CONSUMED' : 'RELEASED') : 'ACTIVE',
    updatedAt: at,
  };
}

/** Acerta o hold inteiro: saque concluído, saque desfeito, ordem recusada ou órfão. */
export const settleHold = (hold: Hold, status: 'CONSUMED' | 'RELEASED', at: Instant): Hold => ({
  ...hold,
  status,
  remainingAmount: new Decimal(0),
  remainingQuantity: hold.remainingQuantity === null ? null : 0,
  updatedAt: at,
});
