import { baseMigrations, dataKeyMigrations, makeAppendOnly } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { BACKOFFICE_ROLES } from './domain/policies.js';

/** Permissões por papel do backoffice (Backoffice §2); o enforcement fino fica em cada serviço. */
const PERMISSIONS: Record<string, string[]> = {
  BO_ONBOARDING: ['onboarding:review', 'customer:read'],
  BO_FINANCE: ['funds:review', 'ledger:adjust', 'account:block'],
  BO_MARKET: ['instrument:manage', 'session:manage', 'corporate_action:manage'],
  BO_RISK: ['risk:limits', 'margin:manage', 'account:block', 'account:unblock', 'orders:cancel'],
  BO_SUPPORT: ['customer:read', 'orders:cancel'],
  BO_ADMIN: ['backoffice_user:manage', 'parameters:manage', 'approval:check', 'account:block'],
  BO_AUDITOR: ['audit:read'],
};

/**
 * Clientes OAuth públicos (sem segredo, só com PKCE): os BFFs e os apps (RN-AUTH-010/011). Os
 * clientes de serviço (confidenciais) são cadastrados pela API de administração.
 */
const PUBLIC_CLIENTS = [
  {
    id: 'bff-web',
    realm: 'customers',
    channel: 'WEB',
    redirect: 'https://app.broker.localhost/auth/callback',
  },
  {
    id: 'desktop-app',
    realm: 'customers',
    channel: 'DESKTOP',
    redirect: 'http://127.0.0.1/callback',
  },
  { id: 'mobile-app', realm: 'customers', channel: 'MOBILE', redirect: 'br.broker.app:/callback' },
  {
    id: 'bff-backoffice',
    realm: 'backoffice',
    channel: 'BACKOFFICE',
    redirect: 'https://backoffice.broker.localhost/auth/callback',
  },
];

/** Migrações do identity: plataforma (outbox, inbox, chaves de dados) e o modelo de identidade. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  ...dataKeyMigrations,
  '0001_identity': {
    async up(db: Kysely<unknown>) {
      // Dois realms com usuários separados (Autenticação §1): o mesmo e-mail pode existir nos dois.
      // E-mail, nome, CPF e telefone ficam cifrados; a busca é pelo HMAC (RN-DB-031).
      await sql`
        CREATE TABLE "user" (
          id             uuid PRIMARY KEY,
          realm          text NOT NULL CHECK (realm IN ('customers', 'backoffice')),
          email_hash     char(64) NOT NULL,
          email_enc      text NOT NULL,
          name_enc       text,
          tax_id_enc     text,
          status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING', 'ACTIVE', 'DISABLED')),
          customer_id    uuid,
          account_id     uuid,
          desktop_idle_ms integer,
          created_at     timestamptz NOT NULL,
          UNIQUE (realm, email_hash)
        )`.execute(db);
      await sql`CREATE INDEX user_customer_idx ON "user" (customer_id)`.execute(db);
      await sql`CREATE INDEX user_account_idx ON "user" (account_id)`.execute(db);
      // Contas abertas antes de o identity saber do cliente (eventos fora de ordem entre tópicos).
      await sql`
        CREATE TABLE customer_account (
          customer_id  uuid NOT NULL,
          account_id   uuid PRIMARY KEY
        )`.execute(db);

      await sql`
        CREATE TABLE credential (
          user_id        uuid PRIMARY KEY REFERENCES "user" (id),
          password_hash  text NOT NULL,
          changed_at     timestamptz NOT NULL
        )`.execute(db);

      // Bloqueio por e-mail (hash), exista o usuário ou não (RN-AUTH-002).
      await sql`
        CREATE TABLE login_throttle (
          realm            text NOT NULL,
          email_hash       char(64) NOT NULL,
          failures         integer NOT NULL DEFAULT 0,
          last_failure_at  timestamptz,
          locked_until     timestamptz,
          PRIMARY KEY (realm, email_hash)
        )`.execute(db);
      // Histórico das tentativas (append-only).
      await sql`
        CREATE TABLE login_attempt (
          id          uuid PRIMARY KEY,
          realm       text NOT NULL,
          email_hash  char(64) NOT NULL,
          user_id     uuid,
          success     boolean NOT NULL,
          reason      text,
          ip_hash     text,
          at          timestamptz NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX login_attempt_email_idx ON login_attempt (realm, email_hash, at)`.execute(
        db,
      );
      await makeAppendOnly(db, 'login_attempt');

      await sql`
        CREATE TABLE mfa_factor (
          id              uuid PRIMARY KEY,
          user_id         uuid NOT NULL REFERENCES "user" (id),
          type            text NOT NULL CHECK (type IN ('TOTP', 'WEBAUTHN', 'SMS')),
          status          text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REMOVED')),
          secret_enc      text,
          phone_enc       text,
          credential_id   text UNIQUE,
          public_key      text,
          sign_count      bigint,
          transports      text[],
          last_used_step  bigint,
          created_at      timestamptz NOT NULL,
          activated_at    timestamptz
        )`.execute(db);
      await sql`CREATE INDEX mfa_factor_user_idx ON mfa_factor (user_id)`.execute(db);

      await sql`
        CREATE TABLE trading_signature (
          user_id         uuid PRIMARY KEY REFERENCES "user" (id),
          secret_hash     text NOT NULL,
          failures        integer NOT NULL DEFAULT 0,
          locked_until    timestamptz,
          reset_required  boolean NOT NULL DEFAULT false,
          blocked_until   timestamptz,
          changed_at      timestamptz NOT NULL
        )`.execute(db);

      await sql`
        CREATE TABLE device (
          id             uuid PRIMARY KEY,
          user_id        uuid NOT NULL REFERENCES "user" (id),
          client_device  text NOT NULL,
          channel        text NOT NULL,
          user_agent     text,
          first_seen_at  timestamptz NOT NULL,
          last_seen_at   timestamptz NOT NULL,
          UNIQUE (user_id, client_device)
        )`.execute(db);

      await sql`
        CREATE TABLE session (
          id                uuid PRIMARY KEY,
          user_id           uuid NOT NULL REFERENCES "user" (id),
          realm             text NOT NULL,
          client_id         text NOT NULL,
          device_id         uuid NOT NULL REFERENCES device (id),
          channel           text NOT NULL CHECK (channel IN ('WEB', 'DESKTOP', 'MOBILE', 'BACKOFFICE')),
          scope             text NOT NULL,
          amr               text[] NOT NULL,
          mfa_at            timestamptz,
          biometric         boolean NOT NULL DEFAULT false,
          created_at        timestamptz NOT NULL,
          last_activity_at  timestamptz NOT NULL,
          expires_at        timestamptz NOT NULL,
          revoked_at        timestamptz,
          revoke_reason     text,
          stepup_challenge  text
        )`.execute(db);
      await sql`CREATE INDEX session_user_idx ON session (user_id) WHERE revoked_at IS NULL`.execute(
        db,
      );

      // Refresh opaco guardado como hash; a família é a sessão (reuso → revoga a sessão inteira).
      await sql`
        CREATE TABLE refresh_token (
          id          uuid PRIMARY KEY,
          session_id  uuid NOT NULL REFERENCES session (id),
          token_hash  char(64) NOT NULL UNIQUE,
          issued_at   timestamptz NOT NULL,
          expires_at  timestamptz NOT NULL,
          rotated_at  timestamptz
        )`.execute(db);
      await sql`CREATE INDEX refresh_token_session_idx ON refresh_token (session_id)`.execute(db);

      await sql`
        CREATE TABLE oauth_client (
          client_id       text PRIMARY KEY,
          realm           text NOT NULL CHECK (realm IN ('customers', 'backoffice', 'services')),
          type            text NOT NULL CHECK (type IN ('PUBLIC', 'CONFIDENTIAL')),
          channel         text,
          secret_hash     text,
          redirect_uris   text[] NOT NULL DEFAULT '{}',
          allowed_scopes  text[] NOT NULL DEFAULT '{}',
          created_at      timestamptz NOT NULL DEFAULT now(),
          CHECK ((type = 'CONFIDENTIAL') = (secret_hash IS NOT NULL))
        )`.execute(db);

      // Etapas curtas do login: o desafio de MFA e o código de autorização (uso único).
      await sql`
        CREATE TABLE login_transaction (
          id_hash         char(64) PRIMARY KEY,
          user_id         uuid NOT NULL REFERENCES "user" (id),
          client_id       text NOT NULL,
          redirect_uri    text NOT NULL,
          code_challenge  text NOT NULL,
          scope           text NOT NULL,
          client_device   text NOT NULL,
          biometric       boolean NOT NULL,
          webauthn_challenge text,
          expires_at      timestamptz NOT NULL,
          consumed_at     timestamptz
        )`.execute(db);
      await sql`
        CREATE TABLE authorization_code (
          code_hash       char(64) PRIMARY KEY,
          session_id      uuid NOT NULL REFERENCES session (id),
          client_id       text NOT NULL,
          redirect_uri    text NOT NULL,
          code_challenge  text NOT NULL,
          expires_at      timestamptz NOT NULL,
          used_at         timestamptz
        )`.execute(db);

      // Chaves de assinatura dos tokens (ES256), rotacionáveis: a privada fica cifrada.
      await sql`
        CREATE TABLE signing_key (
          kid           text PRIMARY KEY,
          private_enc   text NOT NULL,
          public_jwk    jsonb NOT NULL,
          status        text NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
          created_at    timestamptz NOT NULL,
          retired_at    timestamptz
        )`.execute(db);
      await sql`CREATE UNIQUE INDEX signing_key_single_active ON signing_key (status) WHERE status = 'ACTIVE'`.execute(
        db,
      );

      await sql`
        CREATE TABLE signature_token (
          jti         uuid PRIMARY KEY,
          user_id     uuid NOT NULL REFERENCES "user" (id),
          session_id  uuid NOT NULL REFERENCES session (id),
          scope       text NOT NULL,
          expires_at  timestamptz NOT NULL,
          revoked_at  timestamptz
        )`.execute(db);
      await sql`CREATE INDEX signature_token_user_idx ON signature_token (user_id) WHERE revoked_at IS NULL`.execute(
        db,
      );

      // Links de uso único (recuperação de acesso e convite do backoffice) e OTP de SMS.
      await sql`
        CREATE TABLE one_time_token (
          token_hash   char(64) PRIMARY KEY,
          purpose      text NOT NULL CHECK (purpose IN ('RECOVERY', 'INVITATION')),
          user_id      uuid NOT NULL REFERENCES "user" (id),
          otp_hash     text,
          otp_attempts integer NOT NULL DEFAULT 0,
          expires_at   timestamptz NOT NULL,
          used_at      timestamptz
        )`.execute(db);

      await sql`
        CREATE TABLE role (
          code         text PRIMARY KEY,
          realm        text NOT NULL,
          description  text NOT NULL
        )`.execute(db);
      await sql`CREATE TABLE permission (code text PRIMARY KEY)`.execute(db);
      await sql`
        CREATE TABLE role_permission (
          role        text NOT NULL REFERENCES role (code),
          permission  text NOT NULL REFERENCES permission (code),
          PRIMARY KEY (role, permission)
        )`.execute(db);
      await sql`
        CREATE TABLE user_role (
          user_id  uuid NOT NULL REFERENCES "user" (id),
          role     text NOT NULL REFERENCES role (code),
          PRIMARY KEY (user_id, role)
        )`.execute(db);
    },
  },
  '0002_seed': {
    async up(db: Kysely<unknown>) {
      for (const role of BACKOFFICE_ROLES) {
        await sql`INSERT INTO role (code, realm, description) VALUES (${role}, 'backoffice', ${role}) ON CONFLICT DO NOTHING`.execute(
          db,
        );
        for (const p of PERMISSIONS[role] ?? []) {
          await sql`INSERT INTO permission (code) VALUES (${p}) ON CONFLICT DO NOTHING`.execute(db);
          await sql`INSERT INTO role_permission (role, permission) VALUES (${role}, ${p}) ON CONFLICT DO NOTHING`.execute(
            db,
          );
        }
      }
      for (const c of PUBLIC_CLIENTS) {
        await sql`
          INSERT INTO oauth_client (client_id, realm, type, channel, redirect_uris, allowed_scopes)
          VALUES (${c.id}, ${c.realm}, 'PUBLIC', ${c.channel}, ${[c.redirect]}, '{}')
          ON CONFLICT DO NOTHING`.execute(db);
      }
    },
  },
};
