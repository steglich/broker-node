import { baseMigrations, dataKeyMigrations, makeAppendOnly } from '@broker/persistence';
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { DEFAULT_QUESTIONNAIRE } from './domain/questionnaire.js';
import { DEFAULT_TERMS } from './domain/terms.js';

/** Migrações do customer-service: plataforma (outbox, inbox, sagas, chaves de dados) e as próprias. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  ...dataKeyMigrations,
  '0001_customer': {
    async up(db: Kysely<unknown>) {
      // Uma solicitação por usuário; as etapas ficam em `draft` (rascunho retomável, RN-ONB-001),
      // com os dados pessoais cifrados campo a campo pela aplicação.
      await sql`
        CREATE TABLE onboarding_application (
          id                uuid PRIMARY KEY,
          user_id           uuid NOT NULL UNIQUE,
          status            text NOT NULL,
          draft             jsonb NOT NULL DEFAULT '{}',
          tax_id_hash       char(64),
          email_hash        char(64),
          contact_otp       jsonb,
          kyc_check_id      text UNIQUE,
          customer_id       uuid,
          created_at        timestamptz NOT NULL,
          last_activity_at  timestamptz NOT NULL,
          submitted_at      timestamptz,
          decided_at        timestamptz,
          decided_by        text,
          decision_reason   text,
          version           integer NOT NULL DEFAULT 1
        )`.execute(db);
      // RN-ONB-004: um CPF não tem duas solicitações ativas.
      await sql`
        CREATE UNIQUE INDEX onboarding_active_tax_id ON onboarding_application (tax_id_hash)
        WHERE status NOT IN ('APPROVED', 'REJECTED', 'EXPIRED')`.execute(db);
      await sql`CREATE INDEX onboarding_status_idx ON onboarding_application (status, last_activity_at)`.execute(
        db,
      );

      await sql`
        CREATE TABLE customer_document (
          id                     uuid PRIMARY KEY,
          application_id         uuid NOT NULL REFERENCES onboarding_application (id),
          type                   text NOT NULL CHECK (type IN ('ID_FRONT', 'ID_BACK', 'PROOF_OF_ADDRESS', 'SELFIE')),
          storage_key            text NOT NULL UNIQUE,
          declared_content_type  text NOT NULL,
          declared_size          bigint NOT NULL,
          format                 text,
          size_bytes             bigint,
          sha256                 char(64),
          width                  integer,
          height                 integer,
          status                 text NOT NULL CHECK (status IN ('PENDING_UPLOAD', 'ACCEPTED', 'REJECTED', 'PURGED')),
          reject_reason          text,
          created_at             timestamptz NOT NULL,
          purge_at               timestamptz
        )`.execute(db);

      // RN-ONB-022: cada verificação com o payload bruto; o (check_id, tipo) é a idempotência.
      await sql`
        CREATE TABLE kyc_check (
          id                 uuid PRIMARY KEY,
          application_id     uuid NOT NULL REFERENCES onboarding_application (id),
          provider_check_id  text NOT NULL,
          check_type         text NOT NULL,
          result             text NOT NULL CHECK (result IN ('PASS', 'REVIEW', 'FAIL')),
          score              integer,
          raw_payload        jsonb NOT NULL,
          received_at        timestamptz NOT NULL,
          UNIQUE (provider_check_id, check_type)
        )`.execute(db);

      await sql`
        CREATE TABLE customer (
          id                        uuid PRIMARY KEY,
          user_id                   uuid NOT NULL UNIQUE,
          application_id            uuid NOT NULL UNIQUE REFERENCES onboarding_application (id),
          full_name_enc             text NOT NULL,
          social_name_enc           text,
          tax_id_enc                text NOT NULL,
          tax_id_hash               char(64) NOT NULL,
          birth_date_enc            text NOT NULL,
          nationality               text NOT NULL,
          marital_status            text NOT NULL,
          mother_name_enc           text NOT NULL,
          gender                    text,
          email_enc                 text NOT NULL,
          email_hash                char(64) NOT NULL,
          phone_enc                 text NOT NULL,
          address_enc               text NOT NULL,
          id_document_enc           text NOT NULL,
          pep                       boolean NOT NULL,
          foreign_tax_residency     boolean NOT NULL,
          occupation                text NOT NULL,
          monthly_income            numeric(18, 2) NOT NULL,
          declared_net_worth        numeric(18, 2) NOT NULL,
          status                    text NOT NULL CHECK (status IN ('ACTIVE', 'CLOSED')),
          registration_valid_until  date NOT NULL,
          created_at                timestamptz NOT NULL
        )`.execute(db);
      await sql`CREATE UNIQUE INDEX customer_tax_id_open ON customer (tax_id_hash) WHERE status <> 'CLOSED'`.execute(
        db,
      );
      await sql`CREATE UNIQUE INDEX customer_email_open ON customer (email_hash) WHERE status <> 'CLOSED'`.execute(
        db,
      );

      // RN-ACC-001: sequencial nunca reutilizado (um número queimado num rollback não volta).
      await sql`CREATE SEQUENCE account_number_seq START 1000001 MAXVALUE 9999999`.execute(db);
      await sql`
        CREATE TABLE investment_account (
          id              uuid PRIMARY KEY,
          customer_id     uuid NOT NULL REFERENCES customer (id),
          account_number  char(9) NOT NULL UNIQUE,
          status          text NOT NULL CHECK (status IN ('ACTIVE', 'RESTRICTED', 'BLOCKED', 'CLOSING', 'CLOSED')),
          restrictions    text[] NOT NULL DEFAULT '{}',
          margin_enabled  boolean NOT NULL DEFAULT false,
          bank_account_id text,
          opened_at       timestamptz NOT NULL,
          closed_at       timestamptz,
          version         integer NOT NULL DEFAULT 1
        )`.execute(db);
      await sql`CREATE UNIQUE INDEX account_customer_open ON investment_account (customer_id) WHERE status <> 'CLOSED'`.execute(
        db,
      );

      await sql`
        CREATE TABLE suitability_questionnaire (
          id          uuid PRIMARY KEY,
          version     integer NOT NULL UNIQUE,
          questions   jsonb NOT NULL,
          scoring     jsonb NOT NULL,
          valid_from  timestamptz NOT NULL,
          valid_to    timestamptz
        )`.execute(db);
      // Durante o onboarding ainda não há cliente: a avaliação é do usuário.
      await sql`
        CREATE TABLE suitability_assessment (
          id                uuid PRIMARY KEY,
          user_id           uuid NOT NULL,
          questionnaire_id  uuid NOT NULL REFERENCES suitability_questionnaire (id),
          answers           jsonb NOT NULL,
          score             integer NOT NULL,
          profile           text NOT NULL CHECK (profile IN ('CONSERVATIVE', 'MODERATE', 'AGGRESSIVE')),
          assessed_at       timestamptz NOT NULL,
          valid_until       date NOT NULL,
          expiring_notified boolean NOT NULL DEFAULT false,
          expired_notified  boolean NOT NULL DEFAULT false
        )`.execute(db);
      await sql`CREATE INDEX assessment_user_idx ON suitability_assessment (user_id, assessed_at DESC)`.execute(
        db,
      );

      await sql`
        CREATE TABLE terms_document (
          id            uuid PRIMARY KEY,
          code          text NOT NULL,
          version       integer NOT NULL,
          title         text NOT NULL,
          content       text NOT NULL,
          content_hash  char(64) NOT NULL,
          mandatory     boolean NOT NULL,
          moment        text NOT NULL CHECK (moment IN ('ONBOARDING', 'DAY_TRADE', 'SECURITIES_LENDING', 'OPTIONAL')),
          valid_from    timestamptz NOT NULL,
          UNIQUE (code, version)
        )`.execute(db);
      await sql`
        CREATE TABLE terms_acceptance (
          id            uuid PRIMARY KEY,
          user_id       uuid NOT NULL,
          terms_id      uuid NOT NULL REFERENCES terms_document (id),
          accepted_at   timestamptz NOT NULL,
          ip            text,
          user_agent    text,
          channel       text NOT NULL,
          content_hash  char(64) NOT NULL,
          UNIQUE (user_id, terms_id)
        )`.execute(db);
      await makeAppendOnly(db, 'terms_acceptance');

      await sql`
        CREATE TABLE withdrawal_bank_account (
          id                  uuid PRIMARY KEY,
          account_id          uuid NOT NULL REFERENCES investment_account (id),
          pix_key_enc         text NOT NULL,
          pix_key_hash        char(64) NOT NULL,
          pix_key_type        text NOT NULL,
          holder_name_masked  text NOT NULL,
          status              text NOT NULL CHECK (status IN ('ACTIVE', 'REMOVED')),
          available_from      timestamptz NOT NULL,
          created_at          timestamptz NOT NULL
        )`.execute(db);
      await sql`
        CREATE UNIQUE INDEX withdrawal_account_key ON withdrawal_bank_account (account_id, pix_key_hash)
        WHERE status = 'ACTIVE'`.execute(db);

      // Pedido de alteração cadastral: OTP no canal antigo e no novo, ou revisão manual (RN-CAD-001/002).
      await sql`
        CREATE TABLE profile_change (
          id           uuid PRIMARY KEY,
          customer_id  uuid NOT NULL REFERENCES customer (id),
          kind         text NOT NULL CHECK (kind IN ('EMAIL', 'PHONE', 'ADDRESS', 'NAME', 'ID_DOCUMENT')),
          new_value_enc text NOT NULL,
          document_key text,
          otp_old_hash char(64),
          otp_new_hash char(64),
          attempts     integer NOT NULL DEFAULT 0,
          status       text NOT NULL CHECK (status IN ('PENDING_OTP', 'PENDING_REVIEW', 'APPLIED', 'REJECTED', 'EXPIRED')),
          created_at   timestamptz NOT NULL,
          expires_at   timestamptz,
          decided_by   text
        )`.execute(db);
      // RN-CAD-004: versão anterior, nova, ator e data (append-only).
      await sql`
        CREATE TABLE customer_change_history (
          id            uuid PRIMARY KEY,
          customer_id   uuid NOT NULL REFERENCES customer (id),
          field         text NOT NULL,
          old_value_enc text,
          new_value_enc text,
          actor_id      text NOT NULL,
          at            timestamptz NOT NULL
        )`.execute(db);
      await makeAppendOnly(db, 'customer_change_history');
    },
  },
  '0002_seed': {
    async up(db: Kysely<unknown>) {
      const q = DEFAULT_QUESTIONNAIRE;
      await sql`
        INSERT INTO suitability_questionnaire (id, version, questions, scoring, valid_from)
        VALUES (gen_random_uuid(), ${q.version}, ${JSON.stringify(q.questions)}::jsonb,
          ${JSON.stringify({ bands: q.bands })}::jsonb, '2000-01-01T00:00:00Z')
        ON CONFLICT (version) DO NOTHING`.execute(db);
      for (const t of DEFAULT_TERMS) {
        const hash = createHash('sha256').update(t.content).digest('hex');
        await sql`
          INSERT INTO terms_document (id, code, version, title, content, content_hash, mandatory, moment, valid_from)
          VALUES (gen_random_uuid(), ${t.code}, 1, ${t.title}, ${t.content}, ${hash}, ${t.mandatory}, ${t.moment},
            '2000-01-01T00:00:00Z')
          ON CONFLICT (code, version) DO NOTHING`.execute(db);
      }
    },
  },
};
