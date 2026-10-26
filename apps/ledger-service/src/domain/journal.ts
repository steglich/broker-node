import { type BusinessDate, Money } from '@broker/domain-kernel';
import { accountKey, type AccountRef, type NormalSide } from './chart.js';

/**
 * Lançamento contábil (Financeiro §2). Este é o ÚNICO lugar com a convenção de sinal (§9):
 *
 * - o valor gravado em `ledger_entry.amount` é **positivo para crédito ao titular** e negativo
 *   para débito;
 * - por isso um débito em `CUST_CASH` diminui o saldo do cliente, e a soma das entradas de um
 *   journal é zero (RN-LED-001);
 * - o saldo de uma conta é a soma das suas entradas, na mesma convenção.
 */
export type Side = 'DEBIT' | 'CREDIT';

export type JournalType =
  | 'TRADE'
  | 'FEES'
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'CORPORATE_ACTION'
  | 'INTEREST'
  | 'CUSTODY_FEE'
  | 'BTC_FEE'
  | 'TAX'
  | 'ADJUSTMENT'
  | 'REVERSAL';

/** RN-LED-006: `PENDING` até a liquidação; `SETTLED` direto só no que liquida na hora (PIX). */
export type EntryStatus = 'PENDING' | 'SETTLED';

export class LedgerRuleError extends Error {
  override readonly name = 'LedgerRuleError';
  constructor(
    readonly code:
      | 'LEDGER_UNBALANCED_JOURNAL'
      | 'LEDGER_INVALID_LINE'
      | 'LEDGER_SIGN_VIOLATION'
      | 'LEDGER_ACCOUNT_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

export interface JournalLine {
  account: AccountRef;
  side: Side;
  /** Sempre positivo, na escala da moeda (2 casas para BRL, RN-LED-004). */
  amount: Money;
  valueDate: BusinessDate;
  status: EntryStatus;
}

export interface JournalDraft {
  /** RN-LED-003: ex. `trade:{trade_id}:buyer`, `deposit:{deposit_id}`. */
  idempotencyKey: string;
  type: JournalType;
  referenceType: string;
  referenceId: string;
  description: string;
  bookingDate: BusinessDate;
  reversesJournalId?: string;
  createdBy: string;
  lines: readonly JournalLine[];
}

/** Entrada já com sinal, pronta para gravar. */
export interface SignedEntry {
  account: AccountRef;
  amount: Money;
  valueDate: BusinessDate;
  status: EntryStatus;
}

/** Converte lado + valor positivo em valor com sinal (a convenção acima). */
export const signed = (side: Side, amount: Money): Money =>
  side === 'CREDIT' ? amount : amount.negated();

/** O inverso: o lado de um valor com sinal (zero não tem lado). */
export const sideOf = (amount: Money): Side => (amount.isNegative() ? 'DEBIT' : 'CREDIT');

/**
 * O saldo (soma com sinal) está no lado normal da conta? Zero está nos dois. Usado na regra de
 * sinal das contas (RN-LED-011).
 */
export const onNormalSide = (balance: Money, normalSide: NormalSide): boolean =>
  balance.isZero() || sideOf(balance) === normalSide;

/**
 * Valida o rascunho e devolve as entradas com sinal (RN-LED-001, RN-LED-004): pelo menos duas
 * linhas, valores positivos na escala da moeda e soma zero por moeda. Um journal desbalanceado
 * nunca chega ao banco (e, se chegasse, o gatilho diferido recusaria o commit).
 */
export function buildJournal(draft: JournalDraft): SignedEntry[] {
  if (draft.lines.length < 2)
    throw new LedgerRuleError('LEDGER_INVALID_LINE', 'Um journal tem pelo menos duas entradas.');
  if (!draft.idempotencyKey.trim())
    throw new LedgerRuleError('LEDGER_INVALID_LINE', 'idempotency_key obrigatória.');
  const sums = new Map<string, Money>();
  const entries = draft.lines.map((line) => {
    const { amount } = line;
    if (amount.isNegative() || amount.isZero())
      throw new LedgerRuleError(
        'LEDGER_INVALID_LINE',
        `Valor de linha precisa ser positivo: ${amount.toString()} em ${accountKey(line.account)}.`,
      );
    if (!amount.round('HALF_UP').equals(amount))
      throw new LedgerRuleError(
        'LEDGER_INVALID_LINE',
        `Valor com casas além da moeda: ${amount.toString()}; arredonde antes de lançar.`,
      );
    const value = signed(line.side, amount);
    sums.set(
      amount.currency,
      (sums.get(amount.currency) ?? Money.zero(amount.currency)).plus(value),
    );
    return { account: line.account, amount: value, valueDate: line.valueDate, status: line.status };
  });
  for (const [currency, sum] of sums) {
    if (!sum.isZero())
      throw new LedgerRuleError(
        'LEDGER_UNBALANCED_JOURNAL',
        `Journal ${draft.idempotencyKey} não fecha em zero: soma ${sum.toString()} ${currency}.`,
      );
  }
  return entries;
}

/**
 * Estorno (RN-LED-002): as mesmas linhas com o lado trocado, referenciando o original. O original
 * fica intacto; a correção é este estorno mais um lançamento novo. Idempotente pela chave
 * `reversal:{journal_id}`: um journal só é estornado uma vez.
 */
export function reversalOf(
  original: { id: string; idempotencyKey: string; entries: readonly SignedEntry[] },
  input: { bookingDate: BusinessDate; createdBy: string; reason: string },
): JournalDraft {
  return {
    idempotencyKey: `reversal:${original.id}`,
    type: 'REVERSAL',
    referenceType: 'JOURNAL',
    referenceId: original.id,
    description: `Estorno de ${original.idempotencyKey}: ${input.reason}`,
    bookingDate: input.bookingDate,
    reversesJournalId: original.id,
    createdBy: input.createdBy,
    lines: original.entries.map((e) => ({
      account: e.account,
      side: sideOf(e.amount) === 'CREDIT' ? 'DEBIT' : 'CREDIT',
      amount: e.amount.isNegative() ? e.amount.negated() : e.amount,
      valueDate: e.valueDate,
      status: e.status,
    })),
  };
}
