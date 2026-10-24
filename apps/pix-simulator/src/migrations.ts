import { webhookMigrations } from '@broker/webhooks';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Banco próprio do simulador (RN-SIM-001): nada aqui é compartilhado com o núcleo. */
export const migrations: Record<string, Migration> = {
  ...webhookMigrations,
  '0001_bank': {
    async up(db: Kysely<unknown>) {
      await sql`CREATE SEQUENCE account_number_seq START 100001`.execute(db);
      await sql`CREATE SEQUENCE end_to_end_seq`.execute(db);
      await sql`
        CREATE TABLE account (
          id           uuid PRIMARY KEY,
          branch       text NOT NULL,
          number       text NOT NULL UNIQUE,
          kind         text NOT NULL CHECK (kind IN ('CLIENTE', 'TERCEIRO', 'CORRETORA')),
          tax_id       text NOT NULL,
          holder_name  text NOT NULL,
          balance      numeric(18, 2) NOT NULL CHECK (balance >= 0),
          created_at   timestamptz NOT NULL,
          UNIQUE (kind, tax_id)
        )`.execute(db);
      await sql`
        CREATE TABLE pix_key (
          key         text PRIMARY KEY,
          key_type    text NOT NULL CHECK (key_type IN ('CPF', 'CNPJ', 'EVP')),
          account_id  uuid NOT NULL REFERENCES account (id),
          created_at  timestamptz NOT NULL
        )`.execute(db);
      await sql`
        CREATE TABLE charge (
          txid              text PRIMARY KEY,
          account_id        uuid NOT NULL REFERENCES account (id),
          amount            numeric(18, 2) NOT NULL CHECK (amount > 0),
          expires_in_s      integer NOT NULL,
          debtor_tax_id     text,
          debtor_name       text,
          payer_message     text,
          copy_paste        text NOT NULL,
          request_hash      text NOT NULL,
          paid_at           timestamptz,
          created_at        timestamptz NOT NULL
        )`.execute(db);
      await sql`
        CREATE TABLE pix_transaction (
          end_to_end_id     text PRIMARY KEY,
          kind              text NOT NULL CHECK (kind IN ('COBRANCA', 'ENVIO', 'DEVOLUCAO')),
          status            text NOT NULL CHECK (status IN ('CONCLUIDO', 'NAO_REALIZADO')),
          failure_code      text,
          txid              text REFERENCES charge (txid),
          send_id           text UNIQUE,
          refund_id         text,
          original_e2e      text REFERENCES pix_transaction (end_to_end_id),
          payer_account_id  uuid NOT NULL REFERENCES account (id),
          payee_account_id  uuid REFERENCES account (id),
          payee_key         text,
          amount            numeric(18, 2) NOT NULL CHECK (amount > 0),
          description       text,
          created_at        timestamptz NOT NULL
        )`.execute(db);
      // Devolução é total e única por PIX de origem (§2.2).
      await sql`CREATE UNIQUE INDEX pix_transaction_one_refund ON pix_transaction (original_e2e) WHERE kind = 'DEVOLUCAO'`.execute(
        db,
      );
      await sql`CREATE INDEX pix_transaction_txid_idx ON pix_transaction (txid)`.execute(db);
      await sql`CREATE INDEX pix_transaction_created_idx ON pix_transaction (created_at)`.execute(
        db,
      );
    },
  },
};
