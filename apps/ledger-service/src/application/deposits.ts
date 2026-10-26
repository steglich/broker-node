import { Instant, Money } from '@broker/domain-kernel';
import { customerCash, houseAccount } from '../domain/chart.js';
import { decidePayment, depositAmountAllowed, type RefundReason } from '../domain/deposit.js';
import { IntegrationError, type DepositRow, type LedgerTx, type RefundRow } from './ports.js';
import { notFound, rule, SYSTEM, unavailable, type Caller, type LedgerDeps } from './context.js';
import type { Ledger } from './posting.js';

/** Um pagamento recebido pelo webhook `pix.recebido` do Banco Simulado (já traduzido pela ACL). */
export interface ReceivedPix {
  endToEndId: string;
  txid: string;
  amount: Money;
  paidAt: Instant;
  payerTaxId: string | null;
}

export interface DepositView {
  id: string;
  status: DepositRow['status'];
  amount: string;
  pixCopyPaste: string;
  expiresAt: string;
  createdAt: string;
  refundReason?: string;
}

const view = (d: DepositRow): DepositView => ({
  id: d.id,
  status: d.status,
  amount: d.amount.toString(),
  pixCopyPaste: d.pixCopyPaste,
  expiresAt: d.expiresAt.toString(),
  createdAt: d.createdAt.toString(),
  ...(d.refundReason ? { refundReason: d.refundReason } : {}),
});

const event = (d: DepositRow, reason?: string) => ({
  depositId: d.id,
  accountId: d.accountId,
  amount: d.amount.toString(),
  ...(reason ? { reason } : {}),
});

/**
 * Depósito por PIX simulado (Financeiro §6): a intenção cria a cobrança no Banco Simulado; o
 * crédito vem pelo webhook assinado, depois das validações de titularidade, valor, prazo e conta.
 * O que não pode ser creditado é devolvido integralmente (RN-DEP-002..004, RN-DEP-007).
 */
export class Deposits {
  constructor(
    private readonly d: LedgerDeps,
    private readonly ledger: Ledger,
  ) {}

  private accountOf(caller: Caller): string {
    if (!caller.accountId)
      throw rule('ACCOUNT_NOT_OPENED', 'O usuário ainda não tem conta aberta.');
    return caller.accountId;
  }

  /** `POST /v1/me/deposits` (RN-DEP-001/002). */
  async create(caller: Caller, amountText: string): Promise<DepositView> {
    const accountId = this.accountOf(caller);
    const amount = Money.of(amountText, 'BRL');
    const rules = this.d.depositRules;
    if (!depositAmountAllowed(amount, rules))
      throw rule(
        'DEPOSIT_AMOUNT_OUT_OF_RANGE',
        `O depósito precisa ser entre R$ ${rules.min.toString()} e R$ ${rules.max.toString()}.`,
        { min: rules.min.toString(), max: rules.max.toString() },
      );
    const account = await this.d.store.transaction((tx) => tx.customerAccount(accountId));
    if (!account) throw rule('ACCOUNT_NOT_OPENED', 'A conta ainda não chegou ao ledger.');
    if (['BLOCKED', 'CLOSING', 'CLOSED'].includes(account.status))
      throw rule('ACCOUNT_NOT_ACTIVE', `A conta ${account.status} não recebe depósitos.`);

    const id = this.d.newId();
    // txid: 32 caracteres alfanuméricos derivados do id (a cobrança é idempotente por ele).
    const txid = id.replaceAll('-', '');
    let copyPaste: string;
    try {
      ({ copyPaste } = await this.d.pix.createCharge({
        txid,
        amount,
        expiresInSeconds: rules.expiresInSeconds,
      }));
    } catch (err) {
      throw unavailable(
        'PIX_UNAVAILABLE',
        `Banco Simulado indisponível: ${(err as Error).message}`,
      );
    }
    const now = this.d.clock.now();
    const deposit: DepositRow = {
      id,
      accountId,
      amount,
      txid,
      pixCopyPaste: copyPaste,
      status: 'PENDING',
      expiresAt: now.plusMillis(rules.expiresInSeconds * 1000),
      payerTaxIdHash: null,
      endToEndId: null,
      journalId: null,
      refundReason: null,
      paidAt: null,
      createdAt: now,
    };
    await this.d.store.transaction(async (tx) => {
      await tx.insertDeposit(deposit);
      await tx.publish({ type: 'deposit.requested', payload: event(deposit) }, accountId);
    });
    return view(deposit);
  }

  async get(caller: Caller, id: string): Promise<DepositView> {
    const d = await this.d.store.transaction((tx) => tx.deposit(id));
    // RN-AUTHZ-002: depósito de outra conta responde como inexistente.
    if (!d || d.accountId !== caller.accountId) throw notFound('Depósito inexistente.');
    return view(d);
  }

  async list(caller: Caller): Promise<DepositView[]> {
    const accountId = this.accountOf(caller);
    return (await this.d.store.transaction((tx) => tx.depositsOf(accountId, 50))).map(view);
  }

  /** RN-DEP §6.3: `PENDING` → `CANCELED` pelo cliente. Um pagamento depois disso é devolvido. */
  async cancel(caller: Caller, id: string): Promise<DepositView> {
    return this.d.store.transaction(async (tx) => {
      const d = await tx.deposit(id, { forUpdate: true });
      if (!d || d.accountId !== caller.accountId) throw notFound('Depósito inexistente.');
      if (d.status !== 'PENDING')
        throw rule('DEPOSIT_NOT_CANCELABLE', `Depósito ${d.status} não pode ser cancelado.`);
      const canceled = { ...d, status: 'CANCELED' as const };
      await tx.saveDeposit(canceled, this.d.clock.now());
      return view(canceled);
    });
  }

  /** Rotina de expiração (RN-DEP-002): `PENDING` vencida → `EXPIRED` + `deposit.expired`. */
  async expireDue(limit = 200): Promise<number> {
    return this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      const due = await tx.expiredPendingDeposits(now, limit);
      for (const d of due) {
        await tx.saveDeposit({ ...d, status: 'EXPIRED' }, now);
        await tx.publish({ type: 'deposit.expired', payload: event(d) }, d.accountId);
      }
      return due.length;
    });
  }

  /**
   * Webhook `pix.recebido` (RN-DEP-003..007). Idempotente pelo `end_to_end_id`: o mesmo pagamento
   * entregue duas vezes não credita duas vezes (RN-DEP-005). A titularidade é perguntada ao
   * customer-service antes da transação; se ele estiver fora, o webhook responde 503 e o
   * simulador reenvia (RN-SIM-004).
   */
  async onPixReceived(pix: ReceivedPix): Promise<'CREDITED' | 'REFUNDING' | 'DUPLICATE'> {
    const seen = await this.d.store.transaction(async (tx) => ({
      ref: await tx.pixRef(pix.endToEndId),
      intent: await tx.depositByTxid(pix.txid),
    }));
    if (seen.ref) return 'DUPLICATE';
    let payerIsHolder = false;
    if (seen.intent && pix.payerTaxId) {
      try {
        payerIsHolder = await this.d.customers.holderMatches(seen.intent.accountId, pix.payerTaxId);
      } catch (err) {
        throw unavailable(
          'CUSTOMER_UNAVAILABLE',
          `Titularidade indisponível: ${(err as Error).message}`,
        );
      }
    }

    const outcome = await this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      const intent = await tx.depositByTxid(pix.txid, { forUpdate: true });
      // Com a cobrança travada, duas entregas do mesmo pagamento se enfileiram aqui.
      if (await tx.pixRef(pix.endToEndId)) return 'DUPLICATE';
      const account = intent ? await tx.customerAccount(intent.accountId) : null;
      const decision = decidePayment({
        intent,
        paidAmount: pix.amount,
        paidAt: pix.paidAt,
        payerIsHolder,
        accountStatus: account?.status ?? null,
      });
      const ref = {
        endToEndId: pix.endToEndId,
        kind: 'DEPOSIT' as const,
        amount: pix.amount,
        depositId: intent?.id ?? null,
        withdrawalId: null,
        occurredAt: pix.paidAt,
      };
      const payerTaxIdHash = pix.payerTaxId ? this.d.taxIds.hash(pix.payerTaxId) : null;

      if (decision.action === 'CREDIT') {
        const deposit = intent!;
        // RN-DEP-006: crédito imediato e liquidado, 24/7 (data-valor = hoje, mesmo em feriado).
        const today = now.businessDate();
        const posted = await this.ledger.post(tx, {
          idempotencyKey: `deposit:${deposit.id}`,
          type: 'DEPOSIT',
          referenceType: 'DEPOSIT',
          referenceId: deposit.id,
          description: 'Depósito via PIX',
          bookingDate: today,
          createdBy: SYSTEM,
          lines: [
            {
              account: houseAccount('HOUSE_PIX_RESERVE'),
              side: 'DEBIT',
              amount: deposit.amount,
              valueDate: today,
              status: 'SETTLED',
            },
            {
              account: customerCash(deposit.accountId),
              side: 'CREDIT',
              amount: deposit.amount,
              valueDate: today,
              status: 'SETTLED',
            },
          ],
        });
        if (!(await tx.insertPixRef({ ...ref, journalId: posted.journal.id })))
          throw new Error(`pagamento ${pix.endToEndId} registrado em paralelo`);
        const credited: DepositRow = {
          ...deposit,
          status: 'CREDITED',
          endToEndId: pix.endToEndId,
          journalId: posted.journal.id,
          paidAt: pix.paidAt,
          payerTaxIdHash,
        };
        await tx.saveDeposit(credited, now);
        await tx.publish({ type: 'deposit.credited', payload: event(credited) }, deposit.accountId);
        return 'CREDITED';
      }

      if (!(await tx.insertPixRef({ ...ref, journalId: null }))) return 'DUPLICATE';
      await this.scheduleRefund(tx, pix, intent, decision.reason);
      if (intent && decision.expire) {
        await tx.saveDeposit(
          {
            ...intent,
            status: 'EXPIRED',
            endToEndId: pix.endToEndId,
            paidAt: pix.paidAt,
            payerTaxIdHash,
            refundReason: decision.reason,
          },
          now,
        );
        await tx.publish({ type: 'deposit.expired', payload: event(intent) }, intent.accountId);
      } else if (intent?.status === 'PENDING') {
        // Pago, mas não creditável: fica `PAID` até a devolução terminar (→ `REFUNDED`).
        await tx.saveDeposit(
          {
            ...intent,
            status: 'PAID',
            endToEndId: pix.endToEndId,
            paidAt: pix.paidAt,
            payerTaxIdHash,
            refundReason: decision.reason,
          },
          now,
        );
      }
      return 'REFUNDING';
    });
    if (outcome === 'REFUNDING') await this.processRefunds().catch(() => undefined);
    return outcome;
  }

  private async scheduleRefund(
    tx: LedgerTx,
    pix: ReceivedPix,
    intent: DepositRow | null,
    reason: RefundReason,
  ): Promise<void> {
    await tx.insertRefund(
      {
        id: this.d.newId().replaceAll('-', ''),
        endToEndId: pix.endToEndId,
        depositId: intent?.id ?? null,
        amount: pix.amount,
        reason,
        status: 'PENDING',
        attempts: 0,
      },
      this.d.clock.now(),
    );
  }

  /**
   * Executa as devoluções pendentes no Banco Simulado (idempotentes pelo id). Roda logo depois do
   * webhook e periodicamente: uma devolução que falhou fica para a próxima rodada.
   */
  async processRefunds(limit = 50): Promise<number> {
    const pending = await this.d.store.transaction((tx) => tx.pendingRefunds(limit));
    let done = 0;
    for (const r of pending) {
      try {
        const { returnId } = await this.d.pix.refund({
          endToEndId: r.endToEndId,
          refundId: r.id,
          amount: r.amount,
        });
        await this.d.store.transaction((tx) => this.completeRefund(tx, r, returnId));
        done++;
      } catch (err) {
        const message = err instanceof IntegrationError ? err.code : (err as Error).message;
        this.d.logger.warn(
          { event: 'deposit.refund_failed', refundId: r.id, err: message },
          'devolução PIX falhou; nova tentativa na próxima rodada',
        );
        await this.d.store.transaction((tx) =>
          tx.saveRefund({ ...r, attempts: r.attempts + 1, lastError: message }, this.d.clock.now()),
        );
      }
    }
    return done;
  }

  private async completeRefund(tx: LedgerTx, r: RefundRow, returnId: string): Promise<void> {
    const now = this.d.clock.now();
    const current = await tx.refund(r.id, { forUpdate: true });
    if (!current || current.status === 'DONE') return;
    await tx.saveRefund({ ...current, status: 'DONE', returnId }, now);
    await tx.insertPixRef({
      endToEndId: returnId,
      kind: 'REFUND',
      amount: r.amount,
      depositId: r.depositId,
      withdrawalId: null,
      journalId: null,
      occurredAt: now,
    });
    if (!r.depositId) return;
    const intent = (await tx.deposit(r.depositId, { forUpdate: true }))!;
    if (intent.status === 'PAID') await tx.saveDeposit({ ...intent, status: 'REFUNDED' }, now);
    await tx.publish(
      { type: 'deposit.refunded', payload: event(intent, r.reason) },
      intent.accountId,
    );
  }
}
