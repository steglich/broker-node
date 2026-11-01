import { Decimal } from '@broker/domain-kernel';
import { buyHoldAmount } from './costs.js';
import type { Hold } from './holds.js';
import {
  availableQuantity,
  buyingPower,
  withdrawable,
  type AccountProjection,
  type Side,
} from './projection.js';

/** `max_open_orders` (Risco §10). */
export const MAX_OPEN_ORDERS = 200;

export type Classification = 'COVERED_BUY' | 'COVERED_SELL' | 'SHORT_SALE';
export type RejectCode =
  | 'ACCOUNT_NOT_ACTIVE'
  | 'OPEN_ORDERS_LIMIT_EXCEEDED'
  | 'INSUFFICIENT_BUYING_POWER'
  | 'DAY_TRADE_LIMIT_EXCEEDED'
  | 'INSUFFICIENT_POSITION'
  | 'INSUFFICIENT_WITHDRAWABLE_BALANCE';

export interface Figures {
  required: string;
  available: string;
  buyingPower?: string;
}

export interface OrderRequest {
  orderId: string;
  instrumentId: string;
  side: Side;
  quantity: number;
  referencePrice: Decimal;
  tradeIntent: 'NORMAL' | 'DAY_TRADE';
}

export type PreTradeDecision =
  | {
      decision: 'REJECTED';
      classification?: Classification;
      rejectCode: RejectCode;
      figures?: Figures;
    }
  | {
      decision: 'APPROVED';
      classification: Classification;
      figures: Figures;
      /** O que o hold da ordem passa a reservar. */
      amount: Decimal;
    };

const money = (d: Decimal) => d.toFixed(2);

/**
 * Sequência do pré-trade à vista (Risco §11). Puro: recebe a projeção e o hold ativo da ordem (numa
 * alteração, RN-ALT-004) e decide. A diferença é o que importa: o hold antigo já está em `H`/`Q_disp`.
 *
 * Margem, short e day trade alavancado são da Fase 5: até lá ninguém tem `margin_enabled`, então a
 * venda acima de `Q_disp` é `INSUFFICIENT_POSITION` (RN-QD-002) e o day trade usa só o `BP_cash`
 * (RN-DT-001).
 */
export function decidePreTrade(
  p: AccountProjection,
  order: OrderRequest,
  current: Hold | null,
): PreTradeDecision {
  // 2. classificar
  const buying = order.side === 'BUY';
  // 3. habilitações: `RESTRICTED` só reduz (Contas §7.2), e venda coberta sempre reduz.
  if (p.status !== 'ACTIVE' && (buying || p.status !== 'RESTRICTED'))
    return { decision: 'REJECTED', rejectCode: 'ACCOUNT_NOT_ACTIVE' };
  // 6. limites: a alteração não abre ordem nova.
  if (!p.openOrders.has(order.orderId) && p.openOrders.size >= MAX_OPEN_ORDERS)
    return {
      decision: 'REJECTED',
      rejectCode: 'OPEN_ORDERS_LIMIT_EXCEEDED',
      figures: { required: String(p.openOrders.size + 1), available: String(MAX_OPEN_ORDERS) },
    };

  if (buying) {
    // 5. hold e 6. poder de compra
    const amount = buyHoldAmount(order.quantity, order.referencePrice);
    const power = buyingPower(p);
    const required = amount.minus(current?.remainingAmount ?? 0);
    const figures = {
      required: money(required),
      available: money(power),
      buyingPower: money(power),
    };
    if (required.greaterThan(power))
      return {
        decision: 'REJECTED',
        classification: 'COVERED_BUY',
        rejectCode:
          order.tradeIntent === 'DAY_TRADE'
            ? 'DAY_TRADE_LIMIT_EXCEEDED'
            : 'INSUFFICIENT_BUYING_POWER',
        figures,
      };
    return { decision: 'APPROVED', classification: 'COVERED_BUY', figures, amount };
  }

  const available = availableQuantity(p, order.instrumentId);
  const required = order.quantity - (current?.remainingQuantity ?? 0);
  const figures = { required: String(required), available: String(available) };
  if (required > available)
    return {
      decision: 'REJECTED',
      classification: 'SHORT_SALE',
      rejectCode: 'INSUFFICIENT_POSITION',
      figures,
    };
  return {
    decision: 'APPROVED',
    classification: 'COVERED_SELL',
    figures,
    amount: new Decimal(0),
  };
}

export type WithdrawalDecision =
  { decision: 'APPROVED' } | { decision: 'REJECTED'; rejectCode: RejectCode; figures: Figures };

/** `CreateHold` de saque (Contratos §10.2, RN-LED-030), sobre o sacável da projeção. */
export function decideWithdrawal(p: AccountProjection, amount: Decimal): WithdrawalDecision {
  const available = withdrawable(p);
  if (amount.greaterThan(available))
    return {
      decision: 'REJECTED',
      rejectCode: 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
      figures: { required: money(amount), available: money(available) },
    };
  return { decision: 'APPROVED' };
}
