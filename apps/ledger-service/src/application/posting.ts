import { Money } from '@broker/domain-kernel';
import { accountKey, isCustomerAccount, type AccountRef } from '../domain/chart.js';
import { computeBalances, settlementDays, type Balances } from '../domain/balances.js';
import {
  buildJournal,
  LedgerRuleError,
  onNormalSide,
  reversalOf,
  type JournalDraft,
} from '../domain/journal.js';
import { notFound, type LedgerDeps } from './context.js';
import type { EntryRow, JournalRow, LedgerTx } from './ports.js';

export interface Posted {
  journal: JournalRow;
  entries: EntryRow[];
  /** `false` quando a `idempotency_key` já existia: devolve o lançamento original (RN-LED-003). */
  created: boolean;
}

export interface PostOptions {
  /**
   * RN-DEV-001: só débitos do sistema (liquidação, taxas, juros, ajustes) podem deixar a
   * `CUST_CASH` negativa. Comandos do cliente (saque) nunca.
   */
  systemDebit?: boolean;
}

export interface AccountBalances extends Balances {
  accountId: string;
  currency: string;
  lastSequence: bigint;
  asOf: string;
}

/**
 * O núcleo do ledger: grava journals (RN-LED-001..007) e calcula saldos (§4). Todo movimento de
 * dinheiro do serviço passa por `post`, dentro da transação do caso de uso, junto com a outbox.
 */
export class Ledger {
  constructor(private readonly d: LedgerDeps) {}

  async post(tx: LedgerTx, draft: JournalDraft, opts: PostOptions = {}): Promise<Posted> {
    const signedEntries = buildJournal(draft);
    const now = this.d.clock.now();
    const journal: JournalRow = {
      id: this.d.newId(),
      idempotencyKey: draft.idempotencyKey,
      type: draft.type,
      referenceType: draft.referenceType,
      referenceId: draft.referenceId,
      description: draft.description,
      bookingDate: draft.bookingDate,
      reversesJournalId: draft.reversesJournalId ?? null,
      createdBy: draft.createdBy,
      createdAt: now,
    };
    // A chave única decide a corrida: o segundo espera o primeiro commitar e cai no existente.
    if (!(await tx.insertJournal(journal))) {
      const existing = (await tx.journalByKey(draft.idempotencyKey))!;
      return { journal: existing, entries: await tx.entriesOf(existing.id), created: false };
    }

    const refs = new Map<string, AccountRef>();
    for (const e of signedEntries) refs.set(accountKey(e.account), e.account);
    const ids = new Map<string, string>();
    for (const [key, ref] of refs) {
      const account = await tx.account(ref);
      if (!account)
        throw new LedgerRuleError('LEDGER_ACCOUNT_NOT_FOUND', `Conta inexistente: ${key}.`);
      ids.set(key, account.id);
    }
    const locked = new Map((await tx.lockAccounts([...ids.values()])).map((a) => [a.id, a]));

    // RN-LED-007: as entradas de cada conta recebem sequências consecutivas, na ordem das linhas.
    const next = new Map<string, bigint>();
    for (const accountId of new Set(ids.values())) {
      const count = signedEntries.filter(
        (e) => ids.get(accountKey(e.account)) === accountId,
      ).length;
      const last = await tx.advanceSequence(accountId, count);
      next.set(accountId, last - BigInt(count) + 1n);
    }
    const entries: EntryRow[] = signedEntries.map((e) => {
      const accountId = ids.get(accountKey(e.account))!;
      const sequence = next.get(accountId)!;
      next.set(accountId, sequence + 1n);
      return {
        id: this.d.newId(),
        journalId: journal.id,
        accountId,
        account: e.account,
        sequence,
        amount: e.amount,
        valueDate: e.valueDate,
        status: e.status,
        postedAt: now,
      };
    });
    await tx.insertEntries(entries);

    // RN-LED-011: só as contas autorizadas mudam de lado; a CUST_CASH só por débito do sistema.
    for (const account of locked.values()) {
      if (account.anySign) continue;
      if (account.code === 'CUST_CASH' && opts.systemDebit) continue;
      const settled = await tx.settledBalance(account.id);
      if (!onNormalSide(settled, account.normalSide))
        throw new LedgerRuleError(
          'LEDGER_SIGN_VIOLATION',
          `${account.code} ficaria com saldo ${settled.toString()} do lado contrário (${account.normalSide}).`,
        );
    }

    await this.publishPosted(tx, journal, entries);
    return { journal, entries, created: true };
  }

  /** Estorno de um journal (RN-LED-002): idempotente; o original não muda. */
  async reverse(
    tx: LedgerTx,
    journalId: string,
    input: { createdBy: string; reason: string },
  ): Promise<Posted> {
    const original = await tx.journal(journalId);
    if (!original) throw notFound('Journal inexistente.');
    const entries = await tx.entriesOf(journalId);
    return this.post(
      tx,
      reversalOf(
        { id: original.id, idempotencyKey: original.idempotencyKey, entries },
        { ...input, bookingDate: this.d.clock.now().businessDate() },
      ),
      { systemDebit: true },
    );
  }

  /** Saldos da `CUST_CASH` da conta (Financeiro §4), com `as_of` (RN-LED-021). */
  async balances(tx: LedgerTx, accountId: string): Promise<AccountBalances | null> {
    const account = await tx.account({ code: 'CUST_CASH', ownerId: accountId });
    if (!account) return null;
    const inputs = await tx.balanceInputs(account.id);
    const days = settlementDays(this.d.calendar, this.d.clock.now().businessDate());
    const holds = await this.d.holds.activeHolds(accountId);
    return {
      accountId,
      currency: account.currency,
      ...computeBalances(inputs, days, holds),
      lastSequence: inputs.lastSequence,
      asOf: (inputs.asOf ?? this.d.clock.now()).toString(),
    };
  }

  private async publishPosted(tx: LedgerTx, journal: JournalRow, entries: EntryRow[]) {
    const owners = [
      ...new Set(
        entries.filter((e) => isCustomerAccount(e.account.code)).map((e) => e.account.ownerId!),
      ),
    ];
    // RN-LED-031: particionado por account_id, para o Risco ver o journal antes do saldo novo.
    const key = owners[0] ?? 'house';
    await tx.publish(
      {
        type: 'ledger.journal_posted',
        payload: {
          journalId: journal.id,
          type: journal.type,
          referenceType: journal.referenceType,
          referenceId: journal.referenceId,
          bookingDate: journal.bookingDate.toString(),
          entries: entries.map((e) => ({
            accountCode: e.account.code,
            ownerId: e.account.ownerId,
            amount: e.amount.toString(),
            valueDate: e.valueDate.toString(),
            status: e.status,
            sequence: Number(e.sequence),
          })),
        },
      },
      key,
    );
    for (const owner of owners) {
      if (!entries.some((e) => e.account.code === 'CUST_CASH' && e.account.ownerId === owner))
        continue;
      const b = (await this.balances(tx, owner))!;
      await tx.publish(
        {
          type: 'ledger.balance_changed',
          payload: {
            accountId: owner,
            settled: b.settled.toString(),
            projected: {
              d0: b.projected.d0.toString(),
              d1: b.projected.d1.toString(),
              d2: b.projected.d2.toString(),
            },
            projectedTotal: b.projectedTotal.toString(),
            withdrawable: b.withdrawable.toString(),
            lastSequence: Number(b.lastSequence),
            asOf: b.asOf,
          },
        },
        owner,
      );
    }
  }
}

export const money = (v: string) => Money.of(v, 'BRL');
