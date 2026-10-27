import { baseMigrations, dataKeyMigrations } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Templates v1 (pt-BR). Versão nova = migração nova com `valid_from` futuro (RN-NOT-G-001). */
const TEMPLATES_V1: [code: string, channel: string, title: string, body: string][] = [
  [
    'DEPOSIT_CREDITED',
    'ANY',
    'Depósito creditado',
    'Recebemos o seu depósito de {{amount|money}} em {{occurredAt|datetime}}. O valor já está disponível na sua conta.',
  ],
  [
    'DEPOSIT_REFUNDED',
    'ANY',
    'Depósito devolvido',
    'Devolvemos {{amount|money}} porque {{reason}}. O valor volta para a conta de origem.',
  ],
  [
    'WITHDRAWAL_COMPLETED',
    'ANY',
    'Saque concluído',
    'O seu saque de {{amount|money}} foi enviado por PIX em {{occurredAt|datetime}}.',
  ],
  [
    'WITHDRAWAL_FAILED',
    'ANY',
    'Saque não realizado',
    '{{detail}} O valor de {{amount|money}} continua no seu saldo.',
  ],
  [
    'NEGATIVE_BALANCE',
    'ANY',
    'Saldo negativo',
    'O seu saldo liquidado está em {{settledBalance|money}}. Faça um depósito para regularizar e evitar restrições na conta.',
  ],
  // RN-NOT-G-003: saldo não aparece na tela de bloqueio.
  [
    'NEGATIVE_BALANCE',
    'PUSH',
    'Saldo negativo',
    'O seu saldo ficou negativo. Abra o app para regularizar.',
  ],
  [
    'ACCOUNT_STATUS_CHANGED',
    'ANY',
    'Status da conta alterado',
    'A sua conta agora está {{status}}. Veja os detalhes no app.',
  ],
  [
    'SUITABILITY_EXPIRING',
    'ANY',
    'O seu perfil de investidor vai vencer',
    'O questionário de perfil de investidor vence em {{validUntil|date}}. Refaça-o para continuar comprando sem interrupção.',
  ],
  [
    'SUITABILITY_EXPIRED',
    'ANY',
    'O seu perfil de investidor venceu',
    'O questionário de perfil de investidor venceu em {{validUntil|date}}. Refaça-o para voltar a comprar.',
  ],
  [
    'ONBOARDING_SUBMITTED',
    'ANY',
    'Cadastro em análise',
    'Recebemos o seu cadastro. Avisaremos assim que a análise terminar.',
  ],
  [
    'ONBOARDING_APPROVED',
    'ANY',
    'Conta aprovada',
    'O seu cadastro foi aprovado e a sua conta está aberta. Boas-vindas!',
  ],
  [
    'ONBOARDING_REJECTED',
    'ANY',
    'Cadastro não aprovado',
    'Não foi possível aprovar o seu cadastro. Veja os detalhes no app.',
  ],
  [
    'SECURITY_NEW_DEVICE',
    'ANY',
    'Novo acesso à sua conta',
    'Detectamos um acesso de um novo dispositivo ({{device}}) em {{occurredAt|datetime}}. Se não foi você, troque a sua senha agora.',
  ],
  [
    'SECURITY_PASSWORD_CHANGED',
    'ANY',
    'Alteração de segurança',
    'Alteramos {{what}} em {{at|datetime}}. Se não foi você, fale com a central imediatamente.',
  ],
  [
    'SECURITY_PASSWORD_CHANGED',
    'SMS',
    'Alteração de segurança',
    'Broker: alteramos {{what}} em {{at|datetime}}. Não foi você? Fale com a central.',
  ],
  // Consumidores nas fases seguintes; os templates já servem ao agrupamento e à prioridade crítica.
  [
    'ORDER_PARTIALLY_FILLED',
    'ANY',
    'Ordem executada parcialmente',
    'Ordem executada parcialmente: {{filledQuantity|int}} de {{quantity|int}} {{symbol}}.',
  ],
  [
    'FORCED_LIQUIDATION',
    'ANY',
    'Zeragem compulsória',
    'Iniciamos a zeragem compulsória das suas posições para cobrir a garantia. Veja os detalhes no app.',
  ],
  [
    'FORCED_LIQUIDATION',
    'SMS',
    'Zeragem compulsória',
    'Broker: iniciamos a zeragem compulsória das suas posições. Veja o app.',
  ],
];

export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  ...dataKeyMigrations,
  '0001_notification': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE notification_template (
          code        text NOT NULL,
          channel     text NOT NULL CHECK (channel IN ('ANY', 'IN_APP', 'PUSH', 'EMAIL', 'SMS', 'DESKTOP')),
          version     integer NOT NULL CHECK (version > 0),
          locale      text NOT NULL,
          title_tpl   text NOT NULL,
          body_tpl    text NOT NULL,
          valid_from  timestamptz NOT NULL,
          PRIMARY KEY (code, channel, locale, version)
        )`.execute(db);
      for (const [code, channel, title, body] of TEMPLATES_V1)
        await sql`
          INSERT INTO notification_template (code, channel, version, locale, title_tpl, body_tpl, valid_from)
          VALUES (${code}, ${channel}, 1, 'pt-BR', ${title}, ${body}, '2026-01-01T00:00:00-03:00')`.execute(
          db,
        );

      // RN-NOT-G-001: a notificação com o texto renderizado e as variáveis (para o agrupamento).
      await sql`
        CREATE TABLE notification (
          id                 uuid PRIMARY KEY,
          user_id            uuid NOT NULL,
          account_id         uuid,
          code               text NOT NULL,
          title              text NOT NULL,
          body               text NOT NULL,
          data               jsonb NOT NULL,
          priority           text NOT NULL CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
          channels           text[] NOT NULL,
          vars               jsonb NOT NULL,
          template_version   integer NOT NULL,
          group_key          text,
          visible_at         timestamptz NOT NULL,
          created_published  boolean NOT NULL,
          created_at         timestamptz NOT NULL,
          read_at            timestamptz
        )`.execute(db);
      await sql`CREATE INDEX notification_center_idx ON notification (user_id, visible_at DESC, id DESC) WHERE 'IN_APP' = ANY (channels)`.execute(
        db,
      );
      await sql`CREATE INDEX notification_group_idx ON notification (user_id, code, group_key, visible_at) WHERE group_key IS NOT NULL`.execute(
        db,
      );
      await sql`CREATE INDEX notification_release_idx ON notification (visible_at) WHERE NOT created_published`.execute(
        db,
      );
      await sql`CREATE INDEX notification_retention_idx ON notification (created_at)`.execute(db);

      // RN-NOT-G-004: (evento, código) uma vez; com o canal, uma entrega por canal.
      await sql`
        CREATE TABLE notification_source (
          source_event_id  uuid NOT NULL,
          code             text NOT NULL,
          notification_id  uuid,
          created_at       timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (source_event_id, code)
        )`.execute(db);
      await sql`CREATE INDEX notification_source_retention_idx ON notification_source (created_at)`.execute(
        db,
      );

      await sql`
        CREATE TABLE notification_delivery (
          notification_id  uuid NOT NULL REFERENCES notification (id) ON DELETE CASCADE,
          channel          text NOT NULL CHECK (channel IN ('IN_APP', 'PUSH', 'EMAIL', 'SMS', 'DESKTOP')),
          status           text NOT NULL CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED')),
          title            text NOT NULL,
          body             text NOT NULL,
          attempts         integer NOT NULL DEFAULT 0,
          next_attempt_at  timestamptz,
          deadline_at      timestamptz,
          last_error       text,
          delivered_at     timestamptz,
          PRIMARY KEY (notification_id, channel)
        )`.execute(db);
      await sql`CREATE INDEX notification_delivery_due_idx ON notification_delivery (next_attempt_at) WHERE status = 'PENDING'`.execute(
        db,
      );

      await sql`
        CREATE TABLE notification_preference (
          user_id     uuid NOT NULL,
          code        text NOT NULL,
          channel     text NOT NULL,
          enabled     boolean NOT NULL,
          updated_at  timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, code, channel)
        )`.execute(db);
      // Horário de silêncio (RN-NOT-G-006) e "ocultar valores" (RN-NOT-G-003): por usuário.
      await sql`
        CREATE TABLE notification_settings (
          user_id      uuid PRIMARY KEY,
          quiet_start  text CHECK (quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
          quiet_end    text CHECK (quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
          hide_values  boolean NOT NULL DEFAULT false,
          updated_at   timestamptz NOT NULL DEFAULT now(),
          CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
        )`.execute(db);

      // Token cifrado (RN-DB-031); o HMAC acha o mesmo aparelho sem decifrar.
      await sql`
        CREATE TABLE push_device_token (
          id            uuid PRIMARY KEY,
          user_id       uuid NOT NULL,
          platform      text NOT NULL CHECK (platform IN ('IOS', 'ANDROID')),
          token_enc     text NOT NULL,
          token_hash    char(64) NOT NULL UNIQUE,
          status        text NOT NULL CHECK (status IN ('ACTIVE', 'UNREGISTERED')),
          last_seen_at  timestamptz NOT NULL,
          created_at    timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
      await sql`CREATE INDEX push_device_user_idx ON push_device_token (user_id) WHERE status = 'ACTIVE'`.execute(
        db,
      );
    },
  },
};
