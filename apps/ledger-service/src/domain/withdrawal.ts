import type { Instant, Money } from '@broker/domain-kernel';

/**
 * RN-SAQ-006: `REQUESTED` → (`PENDING_REVIEW`) → `PROCESSING` → `COMPLETED` | `FAILED`;
 * `REJECTED` (Risco recusou o hold ou o backoffice reprovou); `CANCELED` pelo cliente, só antes de
 * `PROCESSING`.
 */
export type WithdrawalStatus =
  'REQUESTED' | 'PENDING_REVIEW' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REJECTED' | 'CANCELED';

export const FINAL_WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = [
  'COMPLETED',
  'FAILED',
  'REJECTED',
  'CANCELED',
];
/** Saques que não consomem o limite diário: não saíram e não vão sair. */
export const RELEASED_WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = [
  'FAILED',
  'REJECTED',
  'CANCELED',
];

export const canCancel = (s: WithdrawalStatus) => s === 'REQUESTED' || s === 'PENDING_REVIEW';

/** RN-SAQ-001, RN-SAQ-004, RN-SAQ-005, RN-SAQ-007; todos parametrizáveis. */
export interface WithdrawalRules {
  min: Money;
  daily: Money;
  /** Limite por transação no período noturno. */
  nightly: Money;
  /** `HH:MM` de São Paulo; a noite vai de `nightStart` até `nightEnd` do dia seguinte. */
  nightStart: string;
  nightEnd: string;
  reviewAbove: Money;
  maxAttempts: number;
  retryWindowMs: number;
}

/** A noite de RN-SAQ-004 (20h–6h), no horário de São Paulo do instante. */
export function isNight(now: Instant, rules: Pick<WithdrawalRules, 'nightStart' | 'nightEnd'>) {
  const today = now.businessDate();
  return (
    now.isBefore(today.atLocalTime(rules.nightEnd)) ||
    !now.isBefore(today.atLocalTime(rules.nightStart))
  );
}

/** Início e fim (exclusivo) do dia de São Paulo do instante: a janela do limite diário. */
export function dayWindow(now: Instant): { from: Instant; to: Instant } {
  const today = now.businessDate();
  return { from: today.atLocalTime('00:00'), to: today.plusDays(1).atLocalTime('00:00') };
}

export type LimitBreach = { limit: 'NIGHTLY' | 'DAILY'; max: Money };

/** RN-SAQ-004: limite noturno por transação e limite diário somado. */
export function checkLimits(input: {
  amount: Money;
  now: Instant;
  usedToday: Money;
  rules: WithdrawalRules;
}): LimitBreach | null {
  const { amount, rules } = input;
  if (isNight(input.now, rules) && amount.compare(rules.nightly) > 0)
    return { limit: 'NIGHTLY', max: rules.nightly };
  if (input.usedToday.plus(amount).compare(rules.daily) > 0)
    return { limit: 'DAILY', max: rules.daily };
  return null;
}

export const needsReview = (amount: Money, rules: WithdrawalRules) =>
  amount.compare(rules.reviewAbove) > 0;

/**
 * RN-SAQ-007: backoff exponencial entre tentativas (1, 2, 4, 8 min): as cinco tentativas cabem em
 * 15 min, dentro da janela de 30 min.
 */
export const retryDelayMs = (attemptsDone: number) => 60_000 * 2 ** Math.max(0, attemptsDone - 1);

/** Depois de uma falha transitória: tenta de novo ou desiste (`FAILED`)? */
export function nextAttempt(input: {
  attemptsDone: number;
  firstAttemptAt: Instant;
  now: Instant;
  rules: Pick<WithdrawalRules, 'maxAttempts' | 'retryWindowMs'>;
}): Instant | null {
  if (input.attemptsDone >= input.rules.maxAttempts) return null;
  const at = input.now.plusMillis(retryDelayMs(input.attemptsDone));
  if (at.epochMillis - input.firstAttemptAt.epochMillis > input.rules.retryWindowMs) return null;
  return at;
}
