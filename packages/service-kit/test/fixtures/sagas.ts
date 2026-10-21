import { sql, type Kysely } from 'kysely';
import type { SagaDefinition } from '../../src/index.js';

export interface WithdrawalData {
  withdrawalId: string;
  amount: string;
  holdId?: string;
  transferId?: string;
}

/** Registra cada execução de passo, para o teste contar quantas vezes rodou. */
const record = (db: Kysely<unknown>, sagaId: string, step: string) =>
  sql`INSERT INTO saga_effect (saga_id, step) VALUES (${sagaId}, ${step})`.execute(db);

/**
 * Saga de saque: reserva o saldo (hold), transfere via PIX e notifica. A transferência é
 * idempotente (usa o withdrawalId como chave no PIX), então pode ser repetida após uma queda.
 */
export function withdrawalSaga(
  db: Kysely<unknown>,
  hooks: { inTransfer?: (attempt: number) => Promise<void> } = {},
): SagaDefinition<WithdrawalData> {
  return {
    type: 'withdrawal',
    steps: [
      {
        name: 'reserve_funds',
        timeoutMs: 1000,
        idempotent: true,
        run: async (data, { sagaId }) => {
          await record(db, sagaId, 'reserve_funds');
          return { ...data, holdId: `hold-${data.withdrawalId}` };
        },
        compensate: async (data, { sagaId }) => {
          await record(db, sagaId, 'reserve_funds:release');
          const { holdId: _released, ...rest } = data;
          return rest;
        },
      },
      {
        name: 'transfer_pix',
        timeoutMs: 1000,
        idempotent: true,
        run: async (data, { sagaId, attempt }) => {
          await record(db, sagaId, 'transfer_pix');
          await hooks.inTransfer?.(attempt);
          return { ...data, transferId: `e2e-${data.withdrawalId}` };
        },
      },
      {
        name: 'notify',
        timeoutMs: 1000,
        idempotent: true,
        run: async (data, { sagaId }) => {
          await record(db, sagaId, 'notify');
          return data;
        },
      },
    ],
  };
}

export const sagaEffectMigration = {
  '0001_saga_effect': {
    async up(db: Kysely<unknown>) {
      await sql`CREATE TABLE saga_effect (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, saga_id uuid NOT NULL, step text NOT NULL)`.execute(
        db,
      );
    },
  },
};
