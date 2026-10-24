import { baseMigrations, makeAppendOnly } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Migrações da auditoria: as da plataforma (outbox, inbox, offsets) e as próprias. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  '0001_audit': {
    async up(db: Kysely<unknown>) {
      // RN-AUD-001, RN-AUD-BO-001: seq contínuo (atribuído na cabeça travada, sem sequence do
      // banco, que deixaria buraco a cada rollback) e hash encadeado.
      await sql`
        CREATE TABLE audit_record (
          seq                  bigint PRIMARY KEY CHECK (seq >= 1),
          event_id             uuid NOT NULL UNIQUE,
          actor_type           text NOT NULL,
          actor_id             text NOT NULL,
          actor_roles          text[] NOT NULL DEFAULT '{}',
          action               text NOT NULL,
          resource_type        text NOT NULL,
          resource_id          text,
          before               jsonb,
          after                jsonb,
          changed_fields       text[] NOT NULL DEFAULT '{}',
          justification        text,
          approval_request_id  text,
          ip                   text,
          user_agent           text,
          source               text NOT NULL,
          occurred_at          timestamptz NOT NULL,
          recorded_at          timestamptz NOT NULL,
          correlation_id       text NOT NULL,
          prev_hash            char(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
          hash                 char(64) NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
        )`.execute(db);
      // Filtros da consulta (RN-AUD-005): ator, ação e recurso, sempre com período.
      await sql`CREATE INDEX audit_record_actor_idx ON audit_record (actor_id, occurred_at)`.execute(
        db,
      );
      await sql`CREATE INDEX audit_record_action_idx ON audit_record (action, occurred_at)`.execute(
        db,
      );
      await sql`
        CREATE INDEX audit_record_resource_idx
        ON audit_record (resource_type, resource_id, occurred_at)`.execute(db);
      await sql`CREATE INDEX audit_record_occurred_idx ON audit_record (occurred_at)`.execute(db);
      // RN-AUD-004: nem o usuário da aplicação altera ou apaga (sem UPDATE/DELETE e gatilho de recusa).
      await makeAppendOnly(db, 'audit_record');

      // Resultado de cada verificação da cadeia (histórico, também append-only).
      await sql`
        CREATE TABLE audit_verification (
          id                    uuid PRIMARY KEY,
          business_date         date,
          status                text NOT NULL CHECK (status IN ('OK', 'BROKEN')),
          verified_through_seq  bigint NOT NULL,
          broken                jsonb,
          reason                text,
          started_at            timestamptz NOT NULL,
          finished_at           timestamptz NOT NULL
        )`.execute(db);
      await makeAppendOnly(db, 'audit_verification');

      // RN-AUD-002: cópia local das âncoras gravadas no bucket imutável (a fonte é o bucket).
      await sql`
        CREATE TABLE audit_anchor (
          business_date  date PRIMARY KEY,
          seq            bigint NOT NULL CHECK (seq >= 0),
          hash           char(64) NOT NULL,
          object_key     text NOT NULL,
          version_id     text,
          anchored_at    timestamptz NOT NULL
        )`.execute(db);
      await makeAppendOnly(db, 'audit_anchor');
    },
  },
};
