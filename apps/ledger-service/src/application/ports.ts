import type { BusinessDate, Instant, Money } from '@broker/domain-kernel';
import type { AccountCode, AccountRef, AccountSpec } from '../domain/chart.js';
import type { DepositStatus, RefundReason } from '../domain/deposit.js';
import type { EntryStatus, JournalType } from '../domain/journal.js';
import type { WithdrawalStatus } from '../domain/withdrawal.js';

// ------------------------------------------------------------------ registros

export interface LedgerAccountRow extends Omit<AccountSpec, 'description'> {
  id: string;
  ownerId: string | null;
  currency: string;
  lastSequence: bigint;
  status: 'ACTIVE' | 'CLOSED';
}

export interface JournalRow {
  id: string;
  idempotencyKey: string;
  type: JournalType;
  referenceType: string;
  referenceId: string;
  description: string;
  bookingDate: BusinessDate;
  reversesJournalId: string | null;
  createdBy: string;
  createdAt: Instant;
}

export interface EntryRow {
  id: string;
  journalId: string;
  accountId: string;
  account: AccountRef;
  sequence: bigint;
  amount: Money;
  valueDate: BusinessDate;
  status: EntryStatus;
  postedAt: Instant;
}

export interface CustomerAccountRow {
  accountId: string;
  customerId: string | null;
  accountNumber: string | null;
  status: string;
}

export interface DepositRow {
  id: string;
  accountId: string;
  amount: Money;
  txid: string;
  pixCopyPaste: string;
  status: DepositStatus;
  expiresAt: Instant;
  payerTaxIdHash: string | null;
  endToEndId: string | null;
  journalId: string | null;
  refundReason: RefundReason | null;
  paidAt: Instant | null;
  createdAt: Instant;
}

export interface RefundRow {
  id: string;
  endToEndId: string;
  depositId: string | null;
  amount: Money;
  reason: RefundReason;
  status: 'PENDING' | 'DONE';
  attempts: number;
}

export type PixRefKind = 'DEPOSIT' | 'REFUND' | 'WITHDRAWAL';

export interface PixRefRow {
  endToEndId: string;
  kind: PixRefKind;
  amount: Money;
  depositId: string | null;
  withdrawalId: string | null;
  journalId: string | null;
  occurredAt: Instant;
}

export interface WithdrawalRow {
  id: string;
  accountId: string;
  amount: Money;
  bankAccountId: string;
  status: WithdrawalStatus;
  holdId: string | null;
  /** O hold já foi consumido ou liberado (a saga termina só quando isto é verdade). */
  holdSettled: boolean;
  endToEndId: string | null;
  attempts: number;
  firstAttemptAt: Instant | null;
  nextAttemptAt: Instant | null;
  failureReason: string | null;
  reviewedBy: string | null;
  journalId: string | null;
  requestedAt: Instant;
  completedAt: Instant | null;
}

export interface StatementFilter {
  from?: BusinessDate;
  to?: BusinessDate;
  types?: readonly JournalType[];
  statuses?: readonly EntryStatus[];
  /** Continua depois desta sequência (ordem decrescente). */
  beforeSequence?: bigint;
  limit: number;
}

export interface StatementLine {
  entryId: string;
  sequence: bigint;
  journalId: string;
  type: JournalType;
  referenceType: string;
  referenceId: string;
  description: string;
  bookingDate: BusinessDate;
  valueDate: BusinessDate;
  amount: Money;
  status: EntryStatus;
  /** Soma de todas as entradas da conta até esta, pela ordem de sequência (RN-EXT-001). */
  balanceAfter: Money;
  postedAt: Instant;
}

export interface ReconciliationRow {
  id: string;
  businessDate: BusinessDate;
  periodFrom: Instant;
  periodTo: Instant;
  status: 'OK' | 'DIVERGENT';
  checked: number;
  divergences: Divergence[];
}

export interface Divergence {
  kind:
    | 'PIX_WITHOUT_LEDGER'
    | 'LEDGER_WITHOUT_PIX'
    | 'AMOUNT_MISMATCH'
    | 'CREDITED_AND_REFUNDED'
    | 'REFUND_PENDING';
  endToEndId: string;
  detail: string;
}

// ------------------------------------------------------------------ eventos

export type LedgerEvent =
  | {
      type: 'ledger.journal_posted';
      payload: {
        journalId: string;
        type: JournalType;
        referenceType: string;
        referenceId: string;
        bookingDate: string;
        entries: {
          accountCode: AccountCode;
          ownerId: string | null;
          amount: string;
          valueDate: string;
          status: EntryStatus;
          sequence: number;
        }[];
      };
    }
  | {
      type: 'ledger.balance_changed';
      payload: {
        accountId: string;
        settled: string;
        projected: { d0: string; d1: string; d2: string };
        projectedTotal: string;
        withdrawable: string;
        lastSequence: number;
        asOf: string;
      };
    }
  | {
      type: 'deposit.requested' | 'deposit.credited' | 'deposit.refunded' | 'deposit.expired';
      payload: { depositId: string; accountId: string; amount: string; reason?: string };
    }
  | {
      type:
        | 'withdrawal.requested'
        | 'withdrawal.completed'
        | 'withdrawal.failed'
        | 'withdrawal.rejected';
      payload: { withdrawalId: string; accountId: string; amount: string; reason?: string };
    }
  | {
      type: 'routine.completed';
      payload: {
        routineName: string;
        businessDate: string;
        executionId: string;
        stats: Record<string, unknown>;
      };
    };

// ------------------------------------------------------------------ persistência

export interface LedgerTx {
  // plano de contas
  insertAccount(
    a: Omit<LedgerAccountRow, 'lastSequence' | 'status'>,
    at: Instant,
  ): Promise<boolean>;
  account(ref: AccountRef): Promise<LedgerAccountRow | null>;
  /** Trava as contas (FOR UPDATE) sempre na mesma ordem (id), para não haver deadlock. */
  lockAccounts(ids: readonly string[]): Promise<LedgerAccountRow[]>;
  /** Soma `by` em `last_sequence` e devolve o novo valor. */
  advanceSequence(accountId: string, by: number): Promise<bigint>;

  // journal
  /** `false` se a `idempotency_key` já existe (RN-LED-003). */
  insertJournal(j: JournalRow): Promise<boolean>;
  journal(id: string): Promise<JournalRow | null>;
  journalByKey(key: string): Promise<JournalRow | null>;
  entriesOf(journalId: string): Promise<EntryRow[]>;
  insertEntries(entries: readonly EntryRow[]): Promise<void>;

  // saldos
  settledBalance(accountId: string): Promise<Money>;
  balanceInputs(accountId: string): Promise<{
    settled: Money;
    pending: { valueDate: BusinessDate; amount: Money }[];
    lastSequence: bigint;
    asOf: Instant | null;
  }>;

  // cópia local da conta
  upsertCustomerAccount(a: CustomerAccountRow & { openedAt?: Instant }, at: Instant): Promise<void>;
  customerAccount(
    accountId: string,
    opts?: { forUpdate?: boolean },
  ): Promise<CustomerAccountRow | null>;

  // depósitos
  insertDeposit(d: DepositRow): Promise<void>;
  deposit(id: string, opts?: { forUpdate?: boolean }): Promise<DepositRow | null>;
  depositByTxid(txid: string, opts?: { forUpdate?: boolean }): Promise<DepositRow | null>;
  saveDeposit(d: DepositRow, at: Instant): Promise<void>;
  depositsOf(accountId: string, limit: number): Promise<DepositRow[]>;
  expiredPendingDeposits(now: Instant, limit: number): Promise<DepositRow[]>;
  /** `false` se o `end_to_end_id` já foi visto (webhook repetido, RN-DEP-005). */
  insertPixRef(r: PixRefRow): Promise<boolean>;
  pixRef(endToEndId: string): Promise<PixRefRow | null>;
  /** Entradas de `HOUSE_PIX_RESERVE` lançadas na janela, com o PIX que as originou. */
  reserveEntriesBetween(
    from: Instant,
    to: Instant,
  ): Promise<{ journalId: string; amount: Money; endToEndId: string | null }[]>;
  insertRefund(r: RefundRow, at: Instant): Promise<boolean>;
  refund(id: string, opts?: { forUpdate?: boolean }): Promise<RefundRow | null>;
  pendingRefunds(limit: number): Promise<RefundRow[]>;
  saveRefund(r: RefundRow & { lastError?: string; returnId?: string }, at: Instant): Promise<void>;

  // saques
  insertWithdrawal(w: WithdrawalRow): Promise<void>;
  withdrawal(id: string, opts?: { forUpdate?: boolean }): Promise<WithdrawalRow | null>;
  saveWithdrawal(w: WithdrawalRow, at: Instant): Promise<void>;
  withdrawalsOf(
    accountId: string,
    filter: { statuses?: readonly WithdrawalStatus[]; limit: number },
  ): Promise<WithdrawalRow[]>;
  withdrawalsByStatus(status: WithdrawalStatus, limit: number): Promise<WithdrawalRow[]>;
  /** Soma dos saques da conta pedidos na janela, fora os que não saíram (limite diário). */
  withdrawnBetween(accountId: string, from: Instant, to: Instant): Promise<Money>;
  /** Pega o próximo saque com tentativa vencida e põe um lease nele (outra instância não pega). */
  claimDueWithdrawal(now: Instant, leaseMs: number): Promise<WithdrawalRow | null>;
  withdrawalsWithOpenHold(limit: number): Promise<WithdrawalRow[]>;

  // holds locais (adaptador provisório do Risco)
  insertHold(h: { id: string; accountId: string; amount: Money }, at: Instant): Promise<boolean>;
  hold(
    id: string,
  ): Promise<{ id: string; accountId: string; amount: Money; status: string } | null>;
  settleHold(id: string, status: 'CONSUMED' | 'RELEASED', at: Instant): Promise<void>;
  activeHolds(accountId: string): Promise<Money>;

  // extrato e encerramento
  statement(accountId: string, filter: StatementFilter): Promise<StatementLine[]>;
  pendingEntries(accountId: string): Promise<StatementLine[]>;
  openFundsActivity(accountId: string): Promise<{ deposits: number; withdrawals: number }>;

  // reconciliação
  lastReconciliation(): Promise<ReconciliationRow | null>;
  reconciliation(date: BusinessDate): Promise<ReconciliationRow | null>;
  insertReconciliation(r: ReconciliationRow, at: Instant): Promise<boolean>;

  publish(event: LedgerEvent, partitionKey: string): Promise<void>;
}

export interface LedgerStore {
  transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T>;
}

// ------------------------------------------------------------------ integrações

/** Erro de uma integração: transitório (tenta de novo) ou definitivo (com o código do terceiro). */
export class IntegrationError extends Error {
  override readonly name = 'IntegrationError';
  constructor(
    readonly kind: 'TRANSIENT' | 'DEFINITIVE',
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Transação do Banco Simulado vista pela reconciliação. */
export interface BankTransaction {
  endToEndId: string;
  kind: 'CHARGE_PAYMENT' | 'TRANSFER' | 'REFUND';
  completed: boolean;
  amount: Money;
  at: Instant;
  /** Para os pagamentos de cobrança: os `endToEndId` das devoluções. */
  refunds: string[];
}

/** ACL do Banco Simulado (Sistemas simulados §2): os nomes da API Pix não passam daqui. */
export interface PixGateway {
  createCharge(input: {
    txid: string;
    amount: Money;
    expiresInSeconds: number;
  }): Promise<{ copyPaste: string }>;
  /** Devolução integral; idempotente por `refundId`. */
  refund(input: {
    endToEndId: string;
    refundId: string;
    amount: Money;
  }): Promise<{ returnId: string }>;
  /** Envio (saque); idempotente por `sendId`. Recusa → `IntegrationError` DEFINITIVE. */
  send(input: {
    sendId: string;
    amount: Money;
    pixKey: string;
    holderTaxId: string | null;
  }): Promise<{ endToEndId: string }>;
  transactions(from: Instant, to: Instant): Promise<BankTransaction[]>;
  transaction(endToEndId: string): Promise<BankTransaction | null>;
}

/** Destino de saque cadastrado no customer-service (RN-ACC-020/021). */
export interface WithdrawalDestination {
  id: string;
  status: 'ACTIVE' | 'REMOVED';
  pixKey: string;
  availableFrom: Instant;
  holderTaxId: string | null;
}

/** Consultas ao customer-service, dono do cliente e das contas de saque (rotas internas). */
export interface CustomerDirectory {
  /** O CPF é o do titular da conta? (RN-DEP-003; o ledger não guarda CPF). */
  holderMatches(accountId: string, taxId: string): Promise<boolean>;
  eligibility(
    accountId: string,
    operation: 'DEPOSIT' | 'WITHDRAW',
  ): Promise<{ allowed: boolean; code?: string }>;
  withdrawalDestination(
    accountId: string,
    bankAccountId: string,
  ): Promise<WithdrawalDestination | null>;
}

/**
 * Porta dos holds do Risco (RN-LED-030/032, `risk.CreateHold/ReleaseHold`). Na Fase 1 o adaptador
 * é local e calcula o sacável no próprio ledger; na Fase 2 vira o RPC do risk-service. Idempotente
 * pelo `holdId`, escolhido por quem pede.
 */
export interface RiskHoldPort {
  createHold(input: {
    holdId: string;
    accountId: string;
    amount: Money;
  }): Promise<{ approved: true } | { approved: false; code: 'INSUFFICIENT_WITHDRAWABLE_BALANCE' }>;
  consumeHold(holdId: string): Promise<void>;
  releaseHold(holdId: string): Promise<void>;
  /** Holds ativos que afetam o saque (para o `withdrawable_balance`). */
  activeHolds(accountId: string): Promise<Money>;
}

/** HMAC do CPF do pagador (RN-DB-031): guardado sem o CPF em claro. */
export interface TaxIdHasher {
  hash(taxId: string): string;
}

/** Alerta crítico (reconciliação, câmara): log com severidade e aviso (testes, notification). */
export interface CriticalLedgerAlert {
  kind: 'PIX_RECONCILIATION_DIVERGENCE';
  businessDate: string;
  detail: string;
}
