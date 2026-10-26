import type { Instant, Money } from '@broker/domain-kernel';

/** RN-DEP §6.3: `PENDING` → `PAID` → `CREDITED` | `REFUNDED`; `PENDING` → `EXPIRED` | `CANCELED`. */
export type DepositStatus = 'PENDING' | 'PAID' | 'CREDITED' | 'REFUNDED' | 'EXPIRED' | 'CANCELED';

/** RN-DEP-001/002, parametrizáveis. */
export interface DepositRules {
  min: Money;
  max: Money;
  expiresInSeconds: number;
}

export const DEFAULT_DEPOSIT_EXPIRY_SECONDS = 30 * 60;

export function depositAmountAllowed(amount: Money, rules: DepositRules): boolean {
  return amount.compare(rules.min) >= 0 && amount.compare(rules.max) <= 0;
}

/** Motivo da devolução integral (RN-DEP-002..004, RN-DEP-007). */
export type RefundReason =
  | 'THIRD_PARTY_PAYER'
  | 'AMOUNT_MISMATCH'
  | 'INTENT_EXPIRED'
  | 'INTENT_NOT_PENDING'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'UNKNOWN_CHARGE';

export type PaymentDecision =
  | { action: 'CREDIT' }
  | { action: 'REFUND'; reason: RefundReason; /** a cobrança passa a `EXPIRED` */ expire: boolean };

/**
 * Decide o pagamento que chegou pelo webhook (Financeiro §6). A ordem importa: uma cobrança vencida
 * é devolvida como vencida, mesmo que o pagador também seja outro.
 *
 * "Depois da expiração" é o horário do pagamento no banco a partir do vencimento, ou uma cobrança
 * que já foi dada como vencida pela rotina de expiração (o cliente já foi avisado de que ela não
 * vale mais), como no webhook atrasado do simulador (RN-PIXS-003).
 */
export function decidePayment(input: {
  intent: { status: DepositStatus; amount: Money; expiresAt: Instant } | null;
  paidAmount: Money;
  paidAt: Instant;
  payerIsHolder: boolean;
  accountStatus: string | null;
}): PaymentDecision {
  const { intent } = input;
  if (!intent) return { action: 'REFUND', reason: 'UNKNOWN_CHARGE', expire: false };
  if (intent.status === 'EXPIRED' || !input.paidAt.isBefore(intent.expiresAt))
    return { action: 'REFUND', reason: 'INTENT_EXPIRED', expire: intent.status === 'PENDING' };
  if (intent.status !== 'PENDING')
    return { action: 'REFUND', reason: 'INTENT_NOT_PENDING', expire: false };
  if (input.accountStatus === 'BLOCKED' || input.accountStatus === 'CLOSED')
    return { action: 'REFUND', reason: 'ACCOUNT_NOT_ACTIVE', expire: false };
  if (!input.payerIsHolder) return { action: 'REFUND', reason: 'THIRD_PARTY_PAYER', expire: false };
  if (!input.paidAmount.equals(intent.amount))
    return { action: 'REFUND', reason: 'AMOUNT_MISMATCH', expire: false };
  return { action: 'CREDIT' };
}
