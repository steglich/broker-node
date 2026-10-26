import { Instant } from '@broker/domain-kernel';
import { CUSTOMER_ACCOUNTS } from '../domain/chart.js';
import { notFound, type LedgerDeps } from './context.js';
import type { LedgerTx } from './ports.js';

export interface LedgerPendency {
  source: 'LEDGER';
  code: string;
  message: string;
}

/**
 * Contas do ledger de cada cliente (RN-LED-010): criadas ao consumir `account.opened`, nunca por
 * requisição. A cópia do status (de `account.status_changed`) decide a devolução do depósito em
 * conta bloqueada ou encerrada (RN-DEP-007).
 */
export class LedgerAccounts {
  constructor(private readonly d: LedgerDeps) {}

  /** Idempotente: o evento repetido não cria uma segunda conta (UNIQUE (code, owner_id)). */
  async onAccountOpened(
    tx: LedgerTx,
    p: { accountId: string; customerId: string; accountNumber: string; openedAt: string },
  ): Promise<{ created: number }> {
    const now = this.d.clock.now();
    await tx.upsertCustomerAccount(
      {
        accountId: p.accountId,
        customerId: p.customerId,
        accountNumber: p.accountNumber,
        status: 'ACTIVE',
        openedAt: Instant.parse(p.openedAt),
      },
      now,
    );
    let created = 0;
    for (const spec of CUSTOMER_ACCOUNTS) {
      const inserted = await tx.insertAccount(
        {
          id: this.d.newId(),
          code: spec.code,
          ownerType: spec.ownerType,
          ownerId: p.accountId,
          currency: 'BRL',
          normalSide: spec.normalSide,
          anySign: spec.anySign,
        },
        now,
      );
      if (inserted) created++;
    }
    return { created };
  }

  async onStatusChanged(tx: LedgerTx, p: { accountId: string; to: string }): Promise<void> {
    const current = await tx.customerAccount(p.accountId, { forUpdate: true });
    await tx.upsertCustomerAccount(
      {
        accountId: p.accountId,
        customerId: current?.customerId ?? null,
        accountNumber: current?.accountNumber ?? null,
        status: p.to,
      },
      this.d.clock.now(),
    );
  }

  /**
   * Pendências do ledger para o encerramento da conta (RN-ACC-012), consultadas pelo
   * customer-service: dinheiro na conta, lançamentos a liquidar e depósito ou saque em andamento.
   */
  async closurePendencies(tx: LedgerTx, accountId: string): Promise<LedgerPendency[]> {
    const cash = await tx.account({ code: 'CUST_CASH', ownerId: accountId });
    if (!cash) throw notFound('Conta inexistente no ledger.');
    const collateral = await tx.account({ code: 'CUST_CASH_COLLATERAL', ownerId: accountId });
    const out: LedgerPendency[] = [];
    const add = (code: string, message: string) => out.push({ source: 'LEDGER', code, message });
    const inputs = await tx.balanceInputs(cash.id);
    if (inputs.pending.length > 0) add('PENDING_ENTRIES', 'Há lançamentos a liquidar na conta.');
    if (!inputs.settled.isZero())
      add('BALANCE_NOT_ZERO', `Saldo liquidado de R$ ${inputs.settled.toString()}.`);
    if (collateral && !(await tx.settledBalance(collateral.id)).isZero())
      add('COLLATERAL_NOT_ZERO', 'Há garantias em dinheiro na conta.');
    const open = await tx.openFundsActivity(accountId);
    if (open.deposits > 0) add('DEPOSIT_IN_PROGRESS', 'Há depósito em andamento.');
    if (open.withdrawals > 0) add('WITHDRAWAL_IN_PROGRESS', 'Há saque em andamento.');
    return out;
  }
}
