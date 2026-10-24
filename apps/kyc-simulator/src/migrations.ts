import { webhookMigrations } from '@broker/webhooks';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Banco próprio do provedor (RN-SIM-001). Não há coluna para imagem: só o resultado da análise. */
export const migrations: Record<string, Migration> = {
  ...webhookMigrations,
  '0001_kyc_check': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE kyc_check (
          id              uuid PRIMARY KEY,
          reference_id    text NOT NULL,
          tax_id          text NOT NULL,
          full_name       text NOT NULL,
          birth_date      date NOT NULL,
          document_types  text[] NOT NULL,
          -- URLs assinadas, só até a análise: apagadas ao concluir (RN-KYCS-001).
          document_refs   jsonb,
          forced          text,
          status          text NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
          process_at      timestamptz NOT NULL,
          verifications   jsonb NOT NULL DEFAULT '[]',
          created_at      timestamptz NOT NULL,
          completed_at    timestamptz
        )`.execute(db);
      await sql`CREATE INDEX kyc_check_due_idx ON kyc_check (process_at) WHERE status = 'PROCESSING'`.execute(
        db,
      );
    },
  },
};
