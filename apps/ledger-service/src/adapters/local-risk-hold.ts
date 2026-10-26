import type { TradingCalendar } from '@broker/calendar';
import type { Clock } from '@broker/clock';
import type { Money } from '@broker/domain-kernel';
import type { LedgerStore, RiskHoldPort } from '../application/ports.js';
import { computeBalances, settlementDays } from '../domain/balances.js';

/**
 * Adaptador PROVISÓRIO da porta de holds (Fase 1): o risk-service só chega na Fase 2, então o
 * sacável é calculado no próprio ledger e os holds de saque ficam em `withdrawal_hold`.
 *
 * A serialização por cliente (RN-LED-030) é a linha da `CUST_CASH` travada com FOR UPDATE: a mesma
 * trava que os lançamentos usam. Dois saques simultâneos nunca gastam o mesmo saldo.
 */
export class LocalRiskHoldPort implements RiskHoldPort {
  constructor(
    private readonly o: { store: LedgerStore; clock: Clock; calendar: TradingCalendar },
  ) {}

  createHold(input: { holdId: string; accountId: string; amount: Money }) {
    return this.o.store.transaction(async (tx) => {
      const existing = await tx.hold(input.holdId);
      if (existing) return { approved: true as const };
      const cash = await tx.account({ code: 'CUST_CASH', ownerId: input.accountId });
      if (!cash)
        return { approved: false as const, code: 'INSUFFICIENT_WITHDRAWABLE_BALANCE' as const };
      await tx.lockAccounts([cash.id]);
      const now = this.o.clock.now();
      const balances = computeBalances(
        await tx.balanceInputs(cash.id),
        settlementDays(this.o.calendar, now.businessDate()),
        await tx.activeHolds(input.accountId),
      );
      if (input.amount.compare(balances.withdrawable) > 0)
        return { approved: false as const, code: 'INSUFFICIENT_WITHDRAWABLE_BALANCE' as const };
      await tx.insertHold(
        { id: input.holdId, accountId: input.accountId, amount: input.amount },
        now,
      );
      return { approved: true as const };
    });
  }

  consumeHold(holdId: string) {
    return this.settle(holdId, 'CONSUMED');
  }

  releaseHold(holdId: string) {
    return this.settle(holdId, 'RELEASED');
  }

  activeHolds(accountId: string) {
    return this.o.store.transaction((tx) => tx.activeHolds(accountId));
  }

  /** Idempotente: hold inexistente (recusado) ou já acertado não muda. */
  private settle(holdId: string, status: 'CONSUMED' | 'RELEASED') {
    return this.o.store.transaction((tx) => tx.settleHold(holdId, status, this.o.clock.now()));
  }
}
