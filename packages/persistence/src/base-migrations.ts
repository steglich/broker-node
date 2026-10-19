import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Migrações-base reutilizadas por todos os serviços (RN-DB §4, D6, D7). Um serviço monta a lista
 * dele assim: `{ ...baseMigrations, '0001_minha_tabela': {...} }`.
 *
 * Datas técnicas (`created_at`, `processed_at`...) usam o relógio do banco: são carimbos de
 * infraestrutura, não regras de negócio. Instantes de negócio (`occurred_at`) vêm da aplicação,
 * pelo relógio do ambiente (RN-CLK-004).
 */
export const baseMigrations: Record<string, Migration> = {
  '0000_platform_base': {
    async up(db: Kysely<unknown>) {
      // Segunda barreira das tabelas append-only (ver makeAppendOnly).
      await sql`
        CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'tabela % é append-only: % não é permitido', TG_TABLE_NAME, TG_OP
            USING ERRCODE = 'insufficient_privilege';
        END $$`.execute(db);

      // Outbox transacional (ADR-0008, D7). `seq` dá a ordem de inserção para o relay.
      await sql`
        CREATE TABLE outbox_event (
          id              uuid PRIMARY KEY,
          seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
          aggregate_type  text NOT NULL,
          aggregate_id    text NOT NULL,
          event_type      text NOT NULL,
          event_version   integer NOT NULL CHECK (event_version >= 1),
          partition_key   text NOT NULL,
          payload         jsonb NOT NULL,
          headers         jsonb NOT NULL DEFAULT '{}',
          occurred_at     timestamptz NOT NULL,
          created_at      timestamptz NOT NULL DEFAULT now(),
          published_at    timestamptz
        )`.execute(db);
      // Índice parcial só com os pendentes (RN-DB-011): o relay lê daqui em ordem de `seq`.
      await sql`CREATE INDEX outbox_event_pending_idx ON outbox_event (seq) WHERE published_at IS NULL`.execute(
        db,
      );
      await sql`CREATE INDEX outbox_event_published_idx ON outbox_event (published_at) WHERE published_at IS NOT NULL`.execute(
        db,
      );

      // Inbox: idempotência do consumidor (RN-MSG-B-030).
      await sql`
        CREATE TABLE processed_event (
          event_id      uuid NOT NULL,
          consumer      text NOT NULL,
          processed_at  timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (event_id, consumer)
        )`.execute(db);

      // Offset do stream gravado na mesma transação do efeito (D6).
      await sql`
        CREATE TABLE consumer_offset (
          consumer    text NOT NULL,
          stream      text NOT NULL,
          partition   integer NOT NULL,
          "offset"    bigint NOT NULL,
          updated_at  timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (consumer, stream, partition)
        )`.execute(db);

      // Idempotência de API (RN-API-*): a chave é única por ator.
      await sql`
        CREATE TABLE idempotency_record (
          key              text NOT NULL,
          actor_id         text NOT NULL,
          request_hash     text NOT NULL,
          response_status  integer,
          response_body    jsonb,
          created_at       timestamptz NOT NULL DEFAULT now(),
          expires_at       timestamptz NOT NULL,
          PRIMARY KEY (actor_id, key)
        )`.execute(db);
      await sql`CREATE INDEX idempotency_record_expires_idx ON idempotency_record (expires_at)`.execute(
        db,
      );

      // Sagas orquestradas.
      await sql`
        CREATE TABLE saga_instance (
          id           uuid PRIMARY KEY,
          saga_type    text NOT NULL,
          state        text NOT NULL,
          step         text NOT NULL,
          data         jsonb NOT NULL DEFAULT '{}',
          attempts     integer NOT NULL DEFAULT 0,
          deadline_at  timestamptz,
          version      integer NOT NULL DEFAULT 0,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
      await sql`CREATE INDEX saga_instance_deadline_idx ON saga_instance (deadline_at) WHERE deadline_at IS NOT NULL`.execute(
        db,
      );

      // DLQ espelhada no banco (RN-MSG-B-033/036): base da ferramenta de DLQ.
      await sql`
        CREATE TABLE dead_letter (
          id               uuid PRIMARY KEY,
          consumer         text NOT NULL,
          stream           text NOT NULL,
          partition        integer,
          "offset"         bigint,
          event_id         uuid,
          event_type       text,
          partition_key    text,
          payload          jsonb NOT NULL,
          headers          jsonb NOT NULL DEFAULT '{}',
          error            text NOT NULL,
          attempts         integer NOT NULL,
          status           text NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'REPROCESSED', 'DISCARDED')),
          created_at       timestamptz NOT NULL DEFAULT now(),
          resolved_at      timestamptz,
          resolved_by      text,
          resolution_note  text
        )`.execute(db);
      await sql`CREATE INDEX dead_letter_pending_idx ON dead_letter (consumer, created_at) WHERE status = 'PENDING'`.execute(
        db,
      );

      // Bloqueio por chave nos fluxos ordenados (RN-MSG-B-035).
      await sql`
        CREATE TABLE blocked_key (
          consumer        text NOT NULL,
          partition_key   text NOT NULL,
          dead_letter_id  uuid NOT NULL REFERENCES dead_letter (id),
          blocked_at      timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (consumer, partition_key)
        )`.execute(db);

      // Mensagens da chave bloqueada, estacionadas em ordem até a liberação (D6).
      await sql`
        CREATE TABLE parked_message (
          id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          consumer       text NOT NULL,
          partition_key  text NOT NULL,
          stream         text NOT NULL,
          partition      integer NOT NULL,
          "offset"       bigint NOT NULL,
          event_id       uuid,
          payload        jsonb NOT NULL,
          headers        jsonb NOT NULL DEFAULT '{}',
          parked_at      timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
      await sql`CREATE INDEX parked_message_key_idx ON parked_message (consumer, partition_key, id)`.execute(
        db,
      );
    },

    async down(db: Kysely<unknown>) {
      for (const table of [
        'parked_message',
        'blocked_key',
        'dead_letter',
        'saga_instance',
        'idempotency_record',
        'consumer_offset',
        'processed_event',
        'outbox_event',
      ]) {
        await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
      }
      await sql`DROP FUNCTION IF EXISTS forbid_mutation()`.execute(db);
    },
  },
};
