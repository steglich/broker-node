import { Money } from '@broker/domain-kernel';
import { customerCash, houseAccount } from '../domain/chart.js';
import {
  canCancel,
  checkLimits,
  dayWindow,
  FINAL_WITHDRAWAL_STATUSES,
  needsReview,
  nextAttempt,
  type WithdrawalStatus,
} from '../domain/withdrawal.js';
import {
  notFound,
  rule,
  SYSTEM,
  unavailable,
  type Caller,
  type LedgerDeps,
  type Operator,
} from './context.js';
import { IntegrationError, type LedgerTx, type WithdrawalRow } from './ports.js';
import type { Ledger } from './posting.js';

export interface WithdrawalView {
  id: string;
  status: WithdrawalStatus;
  amount: string;
  bankAccountId: string;
  requestedAt: string;
  completedAt?: string;
  failureReason?: string;
  endToEndId?: string;
}

const view = (w: WithdrawalRow): WithdrawalView => ({
  id: w.id,
  status: w.status,
  amount: w.amount.toString(),
  bankAccountId: w.bankAccountId,
  requestedAt: w.requestedAt.toString(),
  ...(w.completedAt ? { completedAt: w.completedAt.toString() } : {}),
  ...(w.failureReason ? { failureReason: w.failureReason } : {}),
  ...(w.endToEndId ? { endToEndId: w.endToEndId } : {}),
});

const event = (w: WithdrawalRow, reason?: string) => ({
  withdrawalId: w.id,
  accountId: w.accountId,
  amount: w.amount.toString(),
  ...(reason ? { reason } : {}),
});

/** Lease de uma tentativa: outra instância só pega o saque depois disso. */
const ATTEMPT_LEASE_MS = 60_000;

/**
 * Saga de saque orquestrada pelo ledger (Financeiro §7, RN-LED-032, RN-SAQ-*):
 *
 * ```
 * pedido ─▶ REQUESTED ─▶ hold no Risco ─┬─ recusado ─▶ REJECTED (422)
 *                                       ├─ > R$ 50 mil ─▶ PENDING_REVIEW ─▶ backoffice
 *                                       └─▶ PROCESSING ─▶ PIX ─┬─ ok ─▶ journal SETTLED ─▶ COMPLETED ─▶ consome o hold
 *                                                              ├─ recusa ─▶ FAILED ─▶ libera o hold
 *                                                              └─ falha transitória ─▶ nova tentativa (5 em 30 min)
 * ```
 *
 * O estado mora em `withdrawal_request` (tentativas, próxima tentativa, lease, hold acertado ou
 * não): o processamento é retomado depois de um reinício. O envio é idempotente pelo id do saque.
 */
export class Withdrawals {
  constructor(
    private readonly d: LedgerDeps,
    private readonly ledger: Ledger,
  ) {}

  private accountOf(caller: Caller): string {
    if (!caller.accountId)
      throw rule('ACCOUNT_NOT_OPENED', 'O usuário ainda não tem conta aberta.');
    return caller.accountId;
  }

  /** `POST /v1/me/withdrawals` (com assinatura eletrônica, RN-SAQ-003, conferida na rota). */
  async request(
    caller: Caller,
    input: { amount: string; bankAccountId: string },
  ): Promise<WithdrawalView> {
    const accountId = this.accountOf(caller);
    const rules = this.d.withdrawalRules;
    const amount = Money.of(input.amount, 'BRL');
    if (amount.compare(rules.min) < 0)
      throw rule('WITHDRAWAL_AMOUNT_TOO_LOW', `O saque mínimo é R$ ${rules.min.toString()}.`, {
        min: rules.min.toString(),
      });

    let destinationOk: boolean;
    try {
      const eligibility = await this.d.customers.eligibility(accountId, 'WITHDRAW');
      if (!eligibility.allowed)
        throw rule(eligibility.code ?? 'ACCOUNT_NOT_ACTIVE', 'A conta não permite saque agora.');
      const dest = await this.d.customers.withdrawalDestination(accountId, input.bankAccountId);
      // RN-SAQ-002: cadastrada, ativa, de mesma titularidade (conferida no cadastro) e fora da carência.
      destinationOk =
        !!dest && dest.status === 'ACTIVE' && !this.d.clock.now().isBefore(dest.availableFrom);
    } catch (err) {
      if (err instanceof IntegrationError)
        throw unavailable('CUSTOMER_UNAVAILABLE', `Cadastro indisponível: ${err.message}`);
      throw err;
    }
    if (!destinationOk)
      throw rule(
        'BANK_ACCOUNT_NOT_ALLOWED',
        'A conta de destino não está cadastrada, é de outro titular ou ainda está em carência.',
      );

    const id = this.d.newId();
    const created = await this.d.store.transaction(async (tx) => {
      // A linha da conta serializa os pedidos dela: o limite diário não é furado por concorrência.
      const account = await tx.customerAccount(accountId, { forUpdate: true });
      if (!account) throw rule('ACCOUNT_NOT_OPENED', 'A conta ainda não chegou ao ledger.');
      const now = this.d.clock.now();
      const window = dayWindow(now);
      const breach = checkLimits({
        amount,
        now,
        usedToday: await tx.withdrawnBetween(accountId, window.from, window.to),
        rules,
      });
      if (breach)
        throw rule(
          'WITHDRAWAL_LIMIT_EXCEEDED',
          breach.limit === 'NIGHTLY'
            ? `Entre ${rules.nightStart} e ${rules.nightEnd} o limite por saque é R$ ${breach.max.toString()}.`
            : `O limite diário de saque é R$ ${breach.max.toString()}.`,
          { limit: breach.limit, max: breach.max.toString() },
        );
      const w: WithdrawalRow = {
        id,
        accountId,
        amount,
        bankAccountId: input.bankAccountId,
        status: 'REQUESTED',
        holdId: id,
        // Aberto desde já: se o pedido do hold falhar no meio, a liberação (idempotente) o desfaz.
        holdSettled: false,
        endToEndId: null,
        attempts: 0,
        firstAttemptAt: null,
        nextAttemptAt: null,
        failureReason: null,
        reviewedBy: null,
        journalId: null,
        requestedAt: now,
        completedAt: null,
      };
      await tx.insertWithdrawal(w);
      await tx.publish({ type: 'withdrawal.requested', payload: event(w) }, accountId);
      return w;
    });

    // Passo 1: hold WITHDRAWAL no Risco, síncrono (RN-LED-030). Recusado → nada vai ao PIX.
    let approved: boolean;
    try {
      approved = (await this.d.holds.createHold({ holdId: id, accountId, amount })).approved;
    } catch (err) {
      await this.finish(id, 'FAILED', 'RISK_UNAVAILABLE');
      throw unavailable('RISK_UNAVAILABLE', `Risco indisponível: ${(err as Error).message}`);
    }
    if (!approved) {
      await this.finish(id, 'REJECTED', 'INSUFFICIENT_WITHDRAWABLE_BALANCE');
      throw rule(
        'INSUFFICIENT_WITHDRAWABLE_BALANCE',
        'Saldo sacável insuficiente para este saque.',
      );
    }

    return this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      const w: WithdrawalRow = {
        ...created,
        // RN-SAQ-005: acima do limite de revisão, espera o backoffice com o hold já criado.
        ...(needsReview(amount, rules)
          ? { status: 'PENDING_REVIEW' as const }
          : { status: 'PROCESSING' as const, nextAttemptAt: now }),
      };
      await tx.saveWithdrawal(w, now);
      return view(w);
    });
  }

  async get(caller: Caller, id: string): Promise<WithdrawalView> {
    const w = await this.d.store.transaction((tx) => tx.withdrawal(id));
    if (!w || w.accountId !== caller.accountId) throw notFound('Saque inexistente.');
    return view(w);
  }

  async list(caller: Caller): Promise<WithdrawalView[]> {
    const accountId = this.accountOf(caller);
    return (await this.d.store.transaction((tx) => tx.withdrawalsOf(accountId, { limit: 50 }))).map(
      view,
    );
  }

  /** RN-SAQ-006: só antes de `PROCESSING`. O hold é liberado. */
  async cancel(caller: Caller, id: string): Promise<WithdrawalView> {
    const w = await this.d.store.transaction(async (tx) => {
      const current = await tx.withdrawal(id, { forUpdate: true });
      if (!current || current.accountId !== caller.accountId) throw notFound('Saque inexistente.');
      if (!canCancel(current.status))
        throw rule('WITHDRAWAL_NOT_CANCELABLE', `Saque ${current.status} não pode ser cancelado.`);
      const canceled = { ...current, status: 'CANCELED' as const, completedAt: this.d.clock.now() };
      await tx.saveWithdrawal(canceled, this.d.clock.now());
      return canceled;
    });
    await this.settleHolds();
    return view(w);
  }

  // ---------------------------------------------------------------- backoffice

  reviewQueue(): Promise<WithdrawalView[]> {
    return this.d.store.transaction(async (tx) =>
      (await tx.withdrawalsByStatus('PENDING_REVIEW', 200)).map(view),
    );
  }

  /** Aprovação no backoffice (RN-SAQ-005): segue para o envio. */
  async approve(op: Operator, id: string): Promise<WithdrawalView> {
    return this.d.store.transaction(async (tx) => {
      const w = await tx.withdrawal(id, { forUpdate: true });
      if (!w) throw notFound('Saque inexistente.');
      if (w.status !== 'PENDING_REVIEW')
        throw rule('WITHDRAWAL_NOT_IN_REVIEW', `Saque ${w.status} não está em revisão.`);
      const now = this.d.clock.now();
      const next = { ...w, status: 'PROCESSING' as const, reviewedBy: op.id, nextAttemptAt: now };
      await tx.saveWithdrawal(next, now);
      return view(next);
    });
  }

  async reject(op: Operator, id: string, reason: string): Promise<WithdrawalView> {
    const w = await this.d.store.transaction(async (tx) => {
      const current = await tx.withdrawal(id, { forUpdate: true });
      if (!current) throw notFound('Saque inexistente.');
      if (current.status !== 'PENDING_REVIEW')
        throw rule('WITHDRAWAL_NOT_IN_REVIEW', `Saque ${current.status} não está em revisão.`);
      const now = this.d.clock.now();
      const rejected = {
        ...current,
        status: 'REJECTED' as const,
        reviewedBy: op.id,
        failureReason: reason,
        completedAt: now,
      };
      await tx.saveWithdrawal(rejected, now);
      await tx.publish(
        { type: 'withdrawal.rejected', payload: event(rejected, reason) },
        rejected.accountId,
      );
      return rejected;
    });
    await this.settleHolds();
    return view(w);
  }

  // ---------------------------------------------------------------- processamento

  /**
   * Processa os saques com tentativa vencida, um por vez, e acerta os holds pendentes. Chamado
   * pelo laço do serviço (e pelos testes, com o relógio virtual).
   */
  async processDue(max = 20): Promise<number> {
    let processed = 0;
    for (; processed < max; processed++) {
      const w = await this.d.store.transaction((tx) =>
        tx.claimDueWithdrawal(this.d.clock.now(), ATTEMPT_LEASE_MS),
      );
      if (!w) break;
      await this.attempt(w);
    }
    await this.settleHolds();
    return processed;
  }

  private async attempt(w: WithdrawalRow): Promise<void> {
    const now = this.d.clock.now();
    const attempts = w.attempts + 1;
    const firstAttemptAt = w.firstAttemptAt ?? now;
    try {
      const dest = await this.d.customers.withdrawalDestination(w.accountId, w.bankAccountId);
      if (!dest || dest.status !== 'ACTIVE')
        throw new IntegrationError('DEFINITIVE', 'BANK_ACCOUNT_NOT_ALLOWED', 'destino removido');
      const sent = await this.d.pix.send({
        sendId: w.id.replaceAll('-', ''),
        amount: w.amount,
        pixKey: dest.pixKey,
        holderTaxId: dest.holderTaxId,
      });
      await this.complete(w.id, sent.endToEndId, attempts, firstAttemptAt);
    } catch (err) {
      const definitive = err instanceof IntegrationError && err.kind === 'DEFINITIVE';
      const code = err instanceof IntegrationError ? err.code : 'PIX_UNAVAILABLE';
      const retryAt = definitive
        ? null
        : nextAttempt({
            attemptsDone: attempts,
            firstAttemptAt,
            now,
            rules: this.d.withdrawalRules,
          });
      this.d.logger.warn(
        { event: 'withdrawal.attempt_failed', withdrawalId: w.id, attempts, code, definitive },
        'tentativa de saque falhou',
      );
      if (retryAt) {
        await this.d.store.transaction(async (tx) => {
          const current = (await tx.withdrawal(w.id, { forUpdate: true }))!;
          await tx.saveWithdrawal(
            { ...current, attempts, firstAttemptAt, nextAttemptAt: retryAt },
            now,
          );
        });
      } else {
        // RN-SAQ-007: falha definitiva ou tentativas esgotadas → FAILED e o hold é liberado.
        await this.finish(w.id, 'FAILED', definitive ? code : 'PIX_UNAVAILABLE', {
          attempts,
          firstAttemptAt,
        });
      }
    }
  }

  /** PIX confirmado: D CUST_CASH / C HOUSE_PIX_RESERVE, liquidado (Financeiro §7.1). */
  private async complete(
    id: string,
    endToEndId: string,
    attempts: number,
    firstAttemptAt: WithdrawalRow['firstAttemptAt'],
  ): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const w = (await tx.withdrawal(id, { forUpdate: true }))!;
      if (w.status !== 'PROCESSING') return;
      const now = this.d.clock.now();
      const today = now.businessDate();
      const posted = await this.ledger.post(tx, {
        idempotencyKey: `withdrawal:${w.id}`,
        type: 'WITHDRAWAL',
        referenceType: 'WITHDRAWAL',
        referenceId: w.id,
        description: 'Saque via PIX',
        bookingDate: today,
        createdBy: SYSTEM,
        lines: [
          {
            account: customerCash(w.accountId),
            side: 'DEBIT',
            amount: w.amount,
            valueDate: today,
            status: 'SETTLED',
          },
          {
            account: houseAccount('HOUSE_PIX_RESERVE'),
            side: 'CREDIT',
            amount: w.amount,
            valueDate: today,
            status: 'SETTLED',
          },
        ],
      });
      await tx.insertPixRef({
        endToEndId,
        kind: 'WITHDRAWAL',
        amount: w.amount,
        depositId: null,
        withdrawalId: w.id,
        journalId: posted.journal.id,
        occurredAt: now,
      });
      const done: WithdrawalRow = {
        ...w,
        status: 'COMPLETED',
        endToEndId,
        attempts,
        firstAttemptAt,
        nextAttemptAt: null,
        journalId: posted.journal.id,
        completedAt: now,
      };
      await tx.saveWithdrawal(done, now);
      await tx.publish({ type: 'withdrawal.completed', payload: event(done) }, w.accountId);
    });
  }

  private async finish(
    id: string,
    status: 'FAILED' | 'REJECTED',
    reason: string,
    extra: Partial<Pick<WithdrawalRow, 'attempts' | 'firstAttemptAt'>> = {},
  ): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const w = (await tx.withdrawal(id, { forUpdate: true }))!;
      if (FINAL_WITHDRAWAL_STATUSES.includes(w.status)) return;
      const now = this.d.clock.now();
      const done: WithdrawalRow = {
        ...w,
        ...extra,
        status,
        failureReason: reason,
        nextAttemptAt: null,
        completedAt: now,
      };
      await tx.saveWithdrawal(done, now);
      await tx.publish(
        {
          type: status === 'FAILED' ? 'withdrawal.failed' : 'withdrawal.rejected',
          payload: event(done, reason),
        },
        w.accountId,
      );
    });
    await this.settleHolds();
  }

  /**
   * Acerta os holds dos saques terminados: consome (concluído) ou libera (demais). Fica fora da
   * transação do saque porque o hold é de outro contexto; se falhar, a próxima rodada repete
   * (consumir e liberar são idempotentes).
   */
  async settleHolds(limit = 50): Promise<number> {
    const open = await this.d.store.transaction((tx) => tx.withdrawalsWithOpenHold(limit));
    let settled = 0;
    for (const w of open) {
      try {
        if (w.status === 'COMPLETED') await this.d.holds.consumeHold(w.holdId!);
        else await this.d.holds.releaseHold(w.holdId!);
        await this.d.store.transaction(async (tx: LedgerTx) => {
          const current = (await tx.withdrawal(w.id, { forUpdate: true }))!;
          await tx.saveWithdrawal({ ...current, holdSettled: true }, this.d.clock.now());
        });
        settled++;
      } catch (err) {
        this.d.logger.warn(
          { event: 'withdrawal.hold_settle_failed', withdrawalId: w.id, err },
          'falha ao acertar o hold do saque',
        );
      }
    }
    return settled;
  }
}
