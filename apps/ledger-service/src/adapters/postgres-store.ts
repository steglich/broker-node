import { DepositCreditedV1 } from '@broker/contracts/events/deposit.credited/v1';
import { DepositExpiredV1 } from '@broker/contracts/events/deposit.expired/v1';
import { DepositRefundedV1 } from '@broker/contracts/events/deposit.refunded/v1';
import { DepositRequestedV1 } from '@broker/contracts/events/deposit.requested/v1';
import { LedgerBalanceChangedV1 } from '@broker/contracts/events/ledger.balance_changed/v1';
import { LedgerJournalPostedV1 } from '@broker/contracts/events/ledger.journal_posted/v1';
import { RoutineCompletedV1 } from '@broker/contracts/events/routine.completed/v1';
import { WithdrawalCompletedV1 } from '@broker/contracts/events/withdrawal.completed/v1';
import { WithdrawalFailedV1 } from '@broker/contracts/events/withdrawal.failed/v1';
import { WithdrawalRejectedV1 } from '@broker/contracts/events/withdrawal.rejected/v1';
import { WithdrawalRequestedV1 } from '@broker/contracts/events/withdrawal.requested/v1';
import { BusinessDate, Decimal, Instant, Money } from '@broker/domain-kernel';
import type { EventDefinition, EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type {
  CustomerAccountRow,
  DepositRow,
  EntryRow,
  JournalRow,
  LedgerAccountRow,
  LedgerEvent,
  LedgerStore,
  LedgerTx,
  PixRefRow,
  ReconciliationRow,
  RefundRow,
  StatementLine,
  WithdrawalRow,
} from '../application/ports.js';
import type { AccountCode } from '../domain/chart.js';
import { RELEASED_WITHDRAWAL_STATUSES } from '../domain/withdrawal.js';

type Row = Record<string, unknown>;

const EVENTS: Record<LedgerEvent['type'], EventDefinition> = {
  'ledger.journal_posted': LedgerJournalPostedV1,
  'ledger.balance_changed': LedgerBalanceChangedV1,
  'deposit.requested': DepositRequestedV1,
  'deposit.credited': DepositCreditedV1,
  'deposit.refunded': DepositRefundedV1,
  'deposit.expired': DepositExpiredV1,
  'withdrawal.requested': WithdrawalRequestedV1,
  'withdrawal.completed': WithdrawalCompletedV1,
  'withdrawal.failed': WithdrawalFailedV1,
  'withdrawal.rejected': WithdrawalRejectedV1,
  'routine.completed': RoutineCompletedV1,
};
const ACTOR = { type: 'SYSTEM' as const, id: 'ledger-service' };

const inst = (v: unknown): Instant => Instant.ofEpochMillis((v as Date).getTime());
const instOrNull = (v: unknown): Instant | null => (v ? inst(v) : null);
const ts = (i: Instant | null | undefined) => (i ? i.toString() : null);
const str = (v: unknown) => (v as string | null) ?? null;
const brl = (v: unknown) => Money.of(v as Decimal, 'BRL');
const date = (v: unknown) => BusinessDate.parse(v as string);
const lock = (opts?: { forUpdate?: boolean }) => (opts?.forUpdate ? sql` FOR UPDATE` : sql``);

const toAccount = (r: Row): LedgerAccountRow => ({
  id: r['id'] as string,
  code: r['code'] as AccountCode,
  ownerType: r['owner_type'] as LedgerAccountRow['ownerType'],
  ownerId: str(r['owner_id']),
  currency: (r['currency'] as string).trim(),
  normalSide: r['normal_side'] as LedgerAccountRow['normalSide'],
  anySign: r['any_sign'] as boolean,
  lastSequence: r['last_sequence'] as bigint,
  status: r['status'] as LedgerAccountRow['status'],
});

const JOURNAL_COLS = sql`*, booking_date::text AS booking_date_text`;
const toJournal = (r: Row): JournalRow => ({
  id: r['id'] as string,
  idempotencyKey: r['idempotency_key'] as string,
  type: r['type'] as JournalRow['type'],
  referenceType: r['reference_type'] as string,
  referenceId: r['reference_id'] as string,
  description: r['description'] as string,
  bookingDate: date(r['booking_date_text']),
  reversesJournalId: str(r['reverses_journal_id']),
  createdBy: r['created_by'] as string,
  createdAt: inst(r['created_at']),
});

const toEntry = (r: Row): EntryRow => ({
  id: r['id'] as string,
  journalId: r['journal_id'] as string,
  accountId: r['account_id'] as string,
  account: { code: r['code'] as AccountCode, ownerId: str(r['owner_id']) },
  sequence: r['sequence'] as bigint,
  amount: brl(r['amount']),
  valueDate: date(r['value_date_text']),
  status: r['status'] as EntryRow['status'],
  postedAt: inst(r['posted_at']),
});

const DEPOSIT_COLS = sql`*`;
const toDeposit = (r: Row): DepositRow => ({
  id: r['id'] as string,
  accountId: r['account_id'] as string,
  amount: brl(r['amount']),
  txid: r['txid'] as string,
  pixCopyPaste: r['pix_copy_paste'] as string,
  status: r['status'] as DepositRow['status'],
  expiresAt: inst(r['expires_at']),
  payerTaxIdHash: str(r['payer_tax_id_hash']),
  endToEndId: str(r['end_to_end_id']),
  journalId: str(r['journal_id']),
  refundReason: str(r['refund_reason']) as DepositRow['refundReason'],
  paidAt: instOrNull(r['paid_at']),
  createdAt: inst(r['created_at']),
});

const toRefund = (r: Row): RefundRow => ({
  id: r['id'] as string,
  endToEndId: r['end_to_end_id'] as string,
  depositId: str(r['deposit_id']),
  amount: brl(r['amount']),
  reason: r['reason'] as RefundRow['reason'],
  status: r['status'] as RefundRow['status'],
  attempts: Number(r['attempts']),
});

const toPixRef = (r: Row): PixRefRow => ({
  endToEndId: r['end_to_end_id'] as string,
  kind: r['kind'] as PixRefRow['kind'],
  amount: brl(r['amount']),
  depositId: str(r['deposit_id']),
  withdrawalId: str(r['withdrawal_id']),
  journalId: str(r['journal_id']),
  occurredAt: inst(r['occurred_at']),
});

const toWithdrawal = (r: Row): WithdrawalRow => ({
  id: r['id'] as string,
  accountId: r['account_id'] as string,
  amount: brl(r['amount']),
  bankAccountId: r['bank_account_id'] as string,
  status: r['status'] as WithdrawalRow['status'],
  holdId: str(r['hold_id']),
  holdSettled: r['hold_settled'] as boolean,
  endToEndId: str(r['end_to_end_id']),
  attempts: Number(r['attempts']),
  firstAttemptAt: instOrNull(r['first_attempt_at']),
  nextAttemptAt: instOrNull(r['next_attempt_at']),
  failureReason: str(r['failure_reason']),
  reviewedBy: str(r['reviewed_by']),
  journalId: str(r['journal_id']),
  requestedAt: inst(r['requested_at']),
  completedAt: instOrNull(r['completed_at']),
});

const toLine = (r: Row): StatementLine => ({
  entryId: r['id'] as string,
  sequence: r['sequence'] as bigint,
  journalId: r['journal_id'] as string,
  type: r['type'] as StatementLine['type'],
  referenceType: r['reference_type'] as string,
  referenceId: r['reference_id'] as string,
  description: r['description'] as string,
  bookingDate: date(r['booking_date_text']),
  valueDate: date(r['value_date_text']),
  amount: brl(r['amount']),
  status: r['status'] as StatementLine['status'],
  balanceAfter: brl(r['balance_after']),
  postedAt: inst(r['posted_at']),
});

const RECON_COLS = sql`*, business_date::text AS business_date_text`;
const toReconciliation = (r: Row): ReconciliationRow => ({
  id: r['id'] as string,
  businessDate: date(r['business_date_text']),
  periodFrom: inst(r['period_from']),
  periodTo: inst(r['period_to']),
  status: r['status'] as ReconciliationRow['status'],
  checked: Number(r['checked']),
  divergences: r['divergences'] as ReconciliationRow['divergences'],
});

const ENTRY_COLS = sql`e.*, e.value_date::text AS value_date_text, a.code, a.owner_id`;
/** Linha do extrato: o saldo após é a soma acumulada da conta inteira, pela sequência. */
const STATEMENT_BASE = (accountId: string) => sql`
  SELECT e.id, e.sequence, e.journal_id, e.amount, e.status, e.posted_at,
         e.value_date::text AS value_date_text, j.type, j.reference_type, j.reference_id,
         j.description, j.booking_date, j.booking_date::text AS booking_date_text,
         sum(e.amount) OVER (ORDER BY e.sequence) AS balance_after
  FROM ledger_entry e JOIN journal j ON j.id = e.journal_id
  WHERE e.account_id = ${accountId}`;

export class PostgresLedgerStore implements LedgerStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  tx(trx: Kysely<unknown>): LedgerTx {
    const publisher = this.publisher;
    const one = async (q: ReturnType<typeof sql<Row>>) => (await q.execute(trx)).rows[0];
    const all = async (q: ReturnType<typeof sql<Row>>) => (await q.execute(trx)).rows;
    const affected = async (q: ReturnType<typeof sql<Row>>) =>
      Number((await q.execute(trx)).numAffectedRows ?? 0n) > 0;

    return {
      // ------------------------------------------------------------ plano de contas
      async insertAccount(a, at) {
        return affected(sql`
          INSERT INTO ledger_account (id, code, owner_type, owner_id, currency, normal_side, any_sign, created_at)
          VALUES (${a.id}, ${a.code}, ${a.ownerType}, ${a.ownerId}, ${a.currency}, ${a.normalSide},
                  ${a.anySign}, ${at.toString()})
          ON CONFLICT (code, owner_id) DO NOTHING`);
      },
      async account(ref) {
        const r = await one(
          sql`SELECT * FROM ledger_account WHERE code = ${ref.code} AND owner_id IS NOT DISTINCT FROM ${ref.ownerId}::uuid`,
        );
        return r ? toAccount(r) : null;
      },
      async lockAccounts(ids) {
        if (ids.length === 0) return [];
        return (
          await all(sql`
            SELECT * FROM ledger_account WHERE id = ANY(${[...ids]}::uuid[]) ORDER BY id FOR UPDATE`)
        ).map(toAccount);
      },
      async advanceSequence(accountId, by) {
        const r = await one(sql`
          UPDATE ledger_account SET last_sequence = last_sequence + ${by}
          WHERE id = ${accountId} RETURNING last_sequence`);
        return r!['last_sequence'] as bigint;
      },

      // ------------------------------------------------------------ journal
      async insertJournal(j) {
        return affected(sql`
          INSERT INTO journal (id, idempotency_key, type, reference_type, reference_id, description,
                               booking_date, reverses_journal_id, created_by, created_at)
          VALUES (${j.id}, ${j.idempotencyKey}, ${j.type}, ${j.referenceType}, ${j.referenceId},
                  ${j.description}, ${j.bookingDate.toString()}, ${j.reversesJournalId}, ${j.createdBy},
                  ${j.createdAt.toString()})
          ON CONFLICT (idempotency_key) DO NOTHING`);
      },
      async journal(id) {
        const r = await one(sql`SELECT ${JOURNAL_COLS} FROM journal WHERE id = ${id}`);
        return r ? toJournal(r) : null;
      },
      async journalByKey(key) {
        const r = await one(
          sql`SELECT ${JOURNAL_COLS} FROM journal WHERE idempotency_key = ${key}`,
        );
        return r ? toJournal(r) : null;
      },
      async entriesOf(journalId) {
        return (
          await all(sql`
            SELECT ${ENTRY_COLS} FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id
            WHERE e.journal_id = ${journalId} ORDER BY e.posted_at, e.id`)
        ).map(toEntry);
      },
      async insertEntries(entries) {
        for (const e of entries) {
          await sql`
            INSERT INTO ledger_entry (id, journal_id, account_id, sequence, amount, currency, value_date,
                                      status, settled_at, posted_at)
            VALUES (${e.id}, ${e.journalId}, ${e.accountId}, ${e.sequence}, ${e.amount.amount},
                    ${e.amount.currency}, ${e.valueDate.toString()}, ${e.status},
                    ${e.status === 'SETTLED' ? e.postedAt.toString() : null}, ${e.postedAt.toString()})`.execute(
            trx,
          );
        }
      },

      // ------------------------------------------------------------ saldos
      async settledBalance(accountId) {
        const r = await one(sql`
          SELECT coalesce(sum(amount), 0) AS s FROM ledger_entry
          WHERE account_id = ${accountId} AND status = 'SETTLED'`);
        return brl(r!['s']);
      },
      async balanceInputs(accountId) {
        const rows = await all(sql`
          SELECT status, value_date::text AS value_date_text, sum(amount) AS amount,
                 max(posted_at) AS as_of
          FROM ledger_entry WHERE account_id = ${accountId}
          GROUP BY status, value_date ORDER BY value_date`);
        const account = await one(
          sql`SELECT last_sequence FROM ledger_account WHERE id = ${accountId}`,
        );
        let settled = Money.zero('BRL');
        let asOf: Instant | null = null;
        const pending: { valueDate: BusinessDate; amount: Money }[] = [];
        for (const r of rows) {
          const amount = brl(r['amount']);
          if (r['status'] === 'SETTLED') settled = settled.plus(amount);
          else pending.push({ valueDate: date(r['value_date_text']), amount });
          const at = inst(r['as_of']);
          if (!asOf || at.isAfter(asOf)) asOf = at;
        }
        return {
          settled,
          pending,
          lastSequence: (account?.['last_sequence'] as bigint | undefined) ?? 0n,
          asOf,
        };
      },

      // ------------------------------------------------------------ cópia local da conta
      async upsertCustomerAccount(a, at) {
        await sql`
          INSERT INTO customer_account (account_id, customer_id, account_number, status, opened_at, updated_at)
          VALUES (${a.accountId}, ${a.customerId}, ${a.accountNumber}, ${a.status}, ${ts(a.openedAt)},
                  ${at.toString()})
          ON CONFLICT (account_id) DO UPDATE SET
            customer_id = coalesce(EXCLUDED.customer_id, customer_account.customer_id),
            account_number = coalesce(EXCLUDED.account_number, customer_account.account_number),
            opened_at = coalesce(customer_account.opened_at, EXCLUDED.opened_at),
            -- account.opened repetido (ou atrasado) não desfaz um status mais novo.
            status = CASE WHEN EXCLUDED.opened_at IS NOT NULL AND customer_account.opened_at IS NOT NULL
                          THEN customer_account.status ELSE EXCLUDED.status END,
            updated_at = EXCLUDED.updated_at`.execute(trx);
      },
      async customerAccount(accountId, opts) {
        const r = await one(
          sql`SELECT * FROM customer_account WHERE account_id = ${accountId}${lock(opts)}`,
        );
        return r
          ? ({
              accountId: r['account_id'] as string,
              customerId: str(r['customer_id']),
              accountNumber: str(r['account_number']),
              status: r['status'] as string,
            } satisfies CustomerAccountRow)
          : null;
      },

      // ------------------------------------------------------------ depósitos
      async insertDeposit(d) {
        await sql`
          INSERT INTO deposit_intent (id, account_id, amount, txid, pix_copy_paste, status, expires_at,
                                      created_at, updated_at)
          VALUES (${d.id}, ${d.accountId}, ${d.amount.amount}, ${d.txid}, ${d.pixCopyPaste}, ${d.status},
                  ${d.expiresAt.toString()}, ${d.createdAt.toString()}, ${d.createdAt.toString()})`.execute(
          trx,
        );
      },
      async deposit(id, opts) {
        const r = await one(
          sql`SELECT ${DEPOSIT_COLS} FROM deposit_intent WHERE id = ${id}${lock(opts)}`,
        );
        return r ? toDeposit(r) : null;
      },
      async depositByTxid(txid, opts) {
        const r = await one(
          sql`SELECT ${DEPOSIT_COLS} FROM deposit_intent WHERE txid = ${txid}${lock(opts)}`,
        );
        return r ? toDeposit(r) : null;
      },
      async saveDeposit(d, at) {
        await sql`
          UPDATE deposit_intent SET status = ${d.status}, payer_tax_id_hash = ${d.payerTaxIdHash},
            end_to_end_id = ${d.endToEndId}, journal_id = ${d.journalId}, refund_reason = ${d.refundReason},
            paid_at = ${ts(d.paidAt)}, updated_at = ${at.toString()}
          WHERE id = ${d.id}`.execute(trx);
      },
      async depositsOf(accountId, limit) {
        return (
          await all(sql`
            SELECT ${DEPOSIT_COLS} FROM deposit_intent WHERE account_id = ${accountId}
            ORDER BY created_at DESC, id DESC LIMIT ${limit}`)
        ).map(toDeposit);
      },
      async expiredPendingDeposits(now, limit) {
        return (
          await all(sql`
            SELECT ${DEPOSIT_COLS} FROM deposit_intent
            WHERE status = 'PENDING' AND expires_at <= ${now.toString()}
            ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`)
        ).map(toDeposit);
      },
      async insertPixRef(r) {
        return affected(sql`
          INSERT INTO pix_transaction_ref (end_to_end_id, kind, amount, deposit_id, withdrawal_id, journal_id, occurred_at)
          VALUES (${r.endToEndId}, ${r.kind}, ${r.amount.amount}, ${r.depositId}, ${r.withdrawalId},
                  ${r.journalId}, ${r.occurredAt.toString()})
          ON CONFLICT (end_to_end_id) DO NOTHING`);
      },
      async pixRef(endToEndId) {
        const r = await one(
          sql`SELECT * FROM pix_transaction_ref WHERE end_to_end_id = ${endToEndId}`,
        );
        return r ? toPixRef(r) : null;
      },
      async reserveEntriesBetween(from, to) {
        return (
          await all(sql`
            SELECT e.journal_id, e.amount, p.end_to_end_id
            FROM ledger_entry e
            JOIN ledger_account a ON a.id = e.account_id AND a.code = 'HOUSE_PIX_RESERVE'
            LEFT JOIN pix_transaction_ref p ON p.journal_id = e.journal_id
            WHERE e.posted_at >= ${from.toString()} AND e.posted_at < ${to.toString()}
            ORDER BY e.sequence`)
        ).map((r) => ({
          journalId: r['journal_id'] as string,
          amount: brl(r['amount']),
          endToEndId: str(r['end_to_end_id']),
        }));
      },
      async insertRefund(r, at) {
        return affected(sql`
          INSERT INTO pix_refund (id, end_to_end_id, deposit_id, amount, reason, status, attempts, created_at)
          VALUES (${r.id}, ${r.endToEndId}, ${r.depositId}, ${r.amount.amount}, ${r.reason}, ${r.status},
                  ${r.attempts}, ${at.toString()})
          ON CONFLICT (end_to_end_id) DO NOTHING`);
      },
      async refund(id, opts) {
        const r = await one(sql`SELECT * FROM pix_refund WHERE id = ${id}${lock(opts)}`);
        return r ? toRefund(r) : null;
      },
      async pendingRefunds(limit) {
        return (
          await all(sql`
            SELECT * FROM pix_refund WHERE status = 'PENDING' ORDER BY created_at LIMIT ${limit}`)
        ).map(toRefund);
      },
      async saveRefund(r, at) {
        await sql`
          UPDATE pix_refund SET status = ${r.status}, attempts = ${r.attempts},
            last_error = coalesce(${r.lastError ?? null}, last_error),
            return_id = coalesce(${r.returnId ?? null}, return_id),
            done_at = CASE WHEN ${r.status} = 'DONE' THEN ${at.toString()}::timestamptz ELSE done_at END
          WHERE id = ${r.id}`.execute(trx);
      },

      // ------------------------------------------------------------ saques
      async insertWithdrawal(w) {
        await sql`
          INSERT INTO withdrawal_request (id, account_id, amount, bank_account_id, status, hold_id,
                                          hold_settled, attempts, requested_at, updated_at)
          VALUES (${w.id}, ${w.accountId}, ${w.amount.amount}, ${w.bankAccountId}, ${w.status}, ${w.holdId},
                  ${w.holdSettled}, ${w.attempts}, ${w.requestedAt.toString()}, ${w.requestedAt.toString()})`.execute(
          trx,
        );
      },
      async withdrawal(id, opts) {
        const r = await one(sql`SELECT * FROM withdrawal_request WHERE id = ${id}${lock(opts)}`);
        return r ? toWithdrawal(r) : null;
      },
      async saveWithdrawal(w, at) {
        await sql`
          UPDATE withdrawal_request SET status = ${w.status}, hold_id = ${w.holdId},
            hold_settled = ${w.holdSettled}, end_to_end_id = ${w.endToEndId}, attempts = ${w.attempts},
            first_attempt_at = ${ts(w.firstAttemptAt)}, next_attempt_at = ${ts(w.nextAttemptAt)},
            lease_until = NULL, failure_reason = ${w.failureReason}, reviewed_by = ${w.reviewedBy},
            journal_id = ${w.journalId}, completed_at = ${ts(w.completedAt)}, updated_at = ${at.toString()}
          WHERE id = ${w.id}`.execute(trx);
      },
      async withdrawalsOf(accountId, filter) {
        return (
          await all(sql`
            SELECT * FROM withdrawal_request WHERE account_id = ${accountId}
              AND (${filter.statuses ? [...filter.statuses] : null}::text[] IS NULL OR status = ANY(${filter.statuses ? [...filter.statuses] : null}::text[]))
            ORDER BY requested_at DESC, id DESC LIMIT ${filter.limit}`)
        ).map(toWithdrawal);
      },
      async withdrawalsByStatus(status, limit) {
        return (
          await all(sql`
            SELECT * FROM withdrawal_request WHERE status = ${status}
            ORDER BY requested_at LIMIT ${limit}`)
        ).map(toWithdrawal);
      },
      async withdrawnBetween(accountId, from, to) {
        const r = await one(sql`
          SELECT coalesce(sum(amount), 0) AS s FROM withdrawal_request
          WHERE account_id = ${accountId} AND requested_at >= ${from.toString()} AND requested_at < ${to.toString()}
            AND status <> ALL(${[...RELEASED_WITHDRAWAL_STATUSES]}::text[])`);
        return brl(r!['s']);
      },
      async claimDueWithdrawal(now, leaseMs) {
        const r = await one(sql`
          UPDATE withdrawal_request SET lease_until = ${now.plusMillis(leaseMs).toString()}
          WHERE id = (
            SELECT id FROM withdrawal_request
            WHERE status = 'PROCESSING' AND next_attempt_at <= ${now.toString()}
              AND (lease_until IS NULL OR lease_until < ${now.toString()})
            ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`);
        return r ? toWithdrawal(r) : null;
      },
      async withdrawalsWithOpenHold(limit) {
        return (
          await all(sql`
            SELECT * FROM withdrawal_request
            WHERE NOT hold_settled AND status IN ('COMPLETED', 'FAILED', 'REJECTED', 'CANCELED')
            ORDER BY updated_at LIMIT ${limit}`)
        ).map(toWithdrawal);
      },

      // ------------------------------------------------------------ holds locais
      async insertHold(h, at) {
        return affected(sql`
          INSERT INTO withdrawal_hold (id, account_id, amount, status, created_at, updated_at)
          VALUES (${h.id}, ${h.accountId}, ${h.amount.amount}, 'ACTIVE', ${at.toString()}, ${at.toString()})
          ON CONFLICT (id) DO NOTHING`);
      },
      async hold(id) {
        const r = await one(sql`SELECT * FROM withdrawal_hold WHERE id = ${id}`);
        return r
          ? {
              id: r['id'] as string,
              accountId: r['account_id'] as string,
              amount: brl(r['amount']),
              status: r['status'] as string,
            }
          : null;
      },
      async settleHold(id, status, at) {
        await sql`
          UPDATE withdrawal_hold SET status = ${status}, updated_at = ${at.toString()}
          WHERE id = ${id} AND status = 'ACTIVE'`.execute(trx);
      },
      async activeHolds(accountId) {
        const r = await one(sql`
          SELECT coalesce(sum(amount), 0) AS s FROM withdrawal_hold
          WHERE account_id = ${accountId} AND status = 'ACTIVE'`);
        return brl(r!['s']);
      },

      // ------------------------------------------------------------ extrato e encerramento
      async statement(accountId, f) {
        return (
          await all(sql`
            SELECT * FROM (${STATEMENT_BASE(accountId)}) s
            WHERE (${f.from?.toString() ?? null}::date IS NULL OR s.booking_date >= ${f.from?.toString() ?? null}::date)
              AND (${f.to?.toString() ?? null}::date IS NULL OR s.booking_date <= ${f.to?.toString() ?? null}::date)
              AND (${f.types ? [...f.types] : null}::text[] IS NULL OR s.type = ANY(${f.types ? [...f.types] : null}::text[]))
              AND (${f.statuses ? [...f.statuses] : null}::text[] IS NULL OR s.status = ANY(${f.statuses ? [...f.statuses] : null}::text[]))
              AND (${f.beforeSequence ?? null}::bigint IS NULL OR s.sequence < ${f.beforeSequence ?? null}::bigint)
            ORDER BY s.sequence DESC LIMIT ${f.limit}`)
        ).map(toLine);
      },
      async pendingEntries(accountId) {
        return (
          await all(sql`
            SELECT * FROM (${STATEMENT_BASE(accountId)}) s WHERE s.status = 'PENDING'
            ORDER BY s.value_date_text, s.sequence`)
        ).map(toLine);
      },
      async openFundsActivity(accountId) {
        const r = await one(sql`
          SELECT
            (SELECT count(*) FROM deposit_intent WHERE account_id = ${accountId} AND status IN ('PENDING', 'PAID')) AS deposits,
            (SELECT count(*) FROM withdrawal_request WHERE account_id = ${accountId}
               AND status IN ('REQUESTED', 'PENDING_REVIEW', 'PROCESSING')) AS withdrawals`);
        return { deposits: Number(r!['deposits']), withdrawals: Number(r!['withdrawals']) };
      },

      // ------------------------------------------------------------ reconciliação
      async lastReconciliation() {
        const r = await one(
          sql`SELECT ${RECON_COLS} FROM pix_reconciliation ORDER BY period_to DESC LIMIT 1`,
        );
        return r ? toReconciliation(r) : null;
      },
      async reconciliation(d) {
        const r = await one(
          sql`SELECT ${RECON_COLS} FROM pix_reconciliation WHERE business_date = ${d.toString()}`,
        );
        return r ? toReconciliation(r) : null;
      },
      async insertReconciliation(r, at) {
        return affected(sql`
          INSERT INTO pix_reconciliation (id, business_date, period_from, period_to, status, checked,
                                          divergences, created_at)
          VALUES (${r.id}, ${r.businessDate.toString()}, ${r.periodFrom.toString()}, ${r.periodTo.toString()},
                  ${r.status}, ${r.checked}, ${JSON.stringify(r.divergences)}::jsonb, ${at.toString()})
          ON CONFLICT (business_date) DO NOTHING`);
      },

      async publish(event, partitionKey) {
        const definition = EVENTS[event.type];
        await publisher.publish(trx, definition, event.payload as never, {
          partitionKey,
          aggregateType: event.type.split('.')[0]!,
          aggregateId: partitionKey,
          actor: ACTOR,
        });
      },
    };
  }
}
