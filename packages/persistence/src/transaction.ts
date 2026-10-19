import type { Kysely, Transaction } from 'kysely';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  /** Padrão `read committed`. Use `serializable` onde *lost update* não é aceitável (RN-DB §2). */
  isolation?: IsolationLevel;
  /** Novas tentativas em falha de serialização (40001) ou deadlock (40P01). Padrão 0. */
  retries?: number;
}

/** Códigos SQLSTATE que indicam conflito transitório: repetir a transação inteira é seguro. */
const RETRYABLE = new Set(['40001', '40P01']);

const sqlState = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;

/**
 * Executa `work` numa transação: commit se terminar, rollback se lançar erro.
 * Tudo o que precisa ser atômico (efeito + outbox + inbox, D7) vai dentro do mesmo `work`.
 */
export async function inTransaction<DB, T>(
  db: Kysely<DB>,
  work: (trx: Transaction<DB>) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const attempts = 1 + (options.retries ?? 0);
  for (let attempt = 1; ; attempt++) {
    try {
      return await db
        .transaction()
        .setIsolationLevel(options.isolation ?? 'read committed')
        .execute(work);
    } catch (err) {
      const state = sqlState(err);
      if (attempt >= attempts || state === undefined || !RETRYABLE.has(state)) throw err;
    }
  }
}
