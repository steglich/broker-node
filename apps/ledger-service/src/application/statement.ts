import { Money, type BusinessDate } from '@broker/domain-kernel';
import type { EntryStatus, JournalType } from '../domain/journal.js';
import { rule, type Caller, type LedgerDeps } from './context.js';
import type { StatementLine } from './ports.js';

/** Tipos do filtro do extrato (RN-EXT-002) → tipos de journal. */
export const STATEMENT_CATEGORIES: Record<string, readonly JournalType[]> = {
  DEPOSIT: ['DEPOSIT'],
  WITHDRAWAL: ['WITHDRAWAL'],
  TRADE: ['TRADE'],
  FEES: ['FEES', 'CUSTODY_FEE', 'BTC_FEE'],
  CORPORATE_ACTION: ['CORPORATE_ACTION'],
  TAX: ['TAX'],
  INTEREST: ['INTEREST'],
  ADJUSTMENT: ['ADJUSTMENT', 'REVERSAL'],
};
export type StatementCategory = keyof typeof STATEMENT_CATEGORIES;

const categoryOf = (type: JournalType) =>
  Object.entries(STATEMENT_CATEGORIES).find(([, types]) => types.includes(type))![0];

const line = (l: StatementLine) => ({
  id: l.entryId,
  sequence: Number(l.sequence),
  bookingDate: l.bookingDate.toString(),
  valueDate: l.valueDate.toString(),
  description: l.description,
  category: categoryOf(l.type),
  reference: { type: l.referenceType, id: l.referenceId },
  amount: l.amount.toString(),
  status: l.status,
  balanceAfter: l.balanceAfter.toString(),
});

const encodeCursor = (sequence: bigint) => Buffer.from(sequence.toString()).toString('base64url');
function decodeCursor(cursor: string): bigint {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/.test(text)) throw rule('INVALID_CURSOR', 'Cursor inválido.');
  return BigInt(text);
}

/**
 * Extrato da `CUST_CASH` (RN-EXT-001/002/004): do mais recente para o mais antigo, com o saldo após
 * cada lançamento pela ordem de sequência. Os filtros não mudam o saldo após: ele é sempre o da
 * conta inteira naquele ponto.
 */
export class Statement {
  constructor(private readonly d: LedgerDeps) {}

  private accountOf(caller: Caller): string {
    if (!caller.accountId)
      throw rule('ACCOUNT_NOT_OPENED', 'O usuário ainda não tem conta aberta.');
    return caller.accountId;
  }

  async list(
    caller: Caller,
    q: {
      from?: BusinessDate;
      to?: BusinessDate;
      categories?: readonly StatementCategory[];
      statuses?: readonly EntryStatus[];
      limit: number;
      cursor?: string;
    },
  ) {
    const ownerId = this.accountOf(caller);
    return this.d.store.transaction(async (tx) => {
      const account = await tx.account({ code: 'CUST_CASH', ownerId });
      if (!account) return { items: [] };
      const rows = await tx.statement(account.id, {
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
        ...(q.categories ? { types: q.categories.flatMap((c) => STATEMENT_CATEGORIES[c]!) } : {}),
        ...(q.statuses ? { statuses: q.statuses } : {}),
        ...(q.cursor ? { beforeSequence: decodeCursor(q.cursor) } : {}),
        limit: q.limit + 1,
      });
      const items = rows.slice(0, q.limit);
      return {
        items: items.map(line),
        ...(rows.length > q.limit ? { nextCursor: encodeCursor(items.at(-1)!.sequence) } : {}),
      };
    });
  }

  /** Lançamentos futuros (`PENDING`) agrupados por data-valor (RN-EXT-004). */
  async future(caller: Caller) {
    const ownerId = this.accountOf(caller);
    return this.d.store.transaction(async (tx) => {
      const account = await tx.account({ code: 'CUST_CASH', ownerId });
      if (!account) return { groups: [] };
      const groups = new Map<string, StatementLine[]>();
      for (const l of await tx.pendingEntries(account.id)) {
        const key = l.valueDate.toString();
        groups.set(key, [...(groups.get(key) ?? []), l]);
      }
      return {
        groups: [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([valueDate, lines]) => ({
            valueDate,
            total: lines.reduce((acc, l) => acc.plus(l.amount), Money.zero('BRL')).toString(),
            items: lines.map(line),
          })),
      };
    });
  }
}
