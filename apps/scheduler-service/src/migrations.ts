import { baseMigrations } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { DEFAULT_ROUTINES } from './domain/catalog.js';

/** Migrações do agendador: as da plataforma (outbox, inbox, offsets) e as próprias. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  '0001_scheduler': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE routine_definition (
          name        text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]*$'),
          owner       text NOT NULL,
          schedule    jsonb NOT NULL,
          days        text NOT NULL CHECK (days IN ('TRADING', 'FIRST_BUSINESS_DAY_OF_MONTH')),
          depends_on  text[] NOT NULL DEFAULT '{}',
          enabled     boolean NOT NULL DEFAULT true
        )`.execute(db);
      // RN-ROT-001: a chave primária É a idempotência da rotina.
      await sql`
        CREATE TABLE routine_execution (
          routine_name    text NOT NULL REFERENCES routine_definition (name),
          business_date   date NOT NULL,
          status          text NOT NULL CHECK (status IN ('TRIGGERED', 'COMPLETED', 'FAILED')),
          execution_id    uuid NOT NULL UNIQUE,
          attempt         integer NOT NULL DEFAULT 1,
          scheduled_for   timestamptz NOT NULL,
          triggered_at    timestamptz NOT NULL,
          completed_at    timestamptz,
          failure_reason  text,
          catch_up        boolean NOT NULL DEFAULT false,
          PRIMARY KEY (routine_name, business_date)
        )`.execute(db);
      await sql`CREATE INDEX routine_execution_date_idx ON routine_execution (business_date)`.execute(
        db,
      );
      // Linha única: o cursor do catch-up. A trava dela (FOR UPDATE) serializa os passos de disparo.
      await sql`
        CREATE TABLE scheduler_state (
          id      smallint PRIMARY KEY CHECK (id = 1),
          cursor  date
        )`.execute(db);
      await sql`INSERT INTO scheduler_state (id, cursor) VALUES (1, NULL)`.execute(db);
      // Linha única: o tempo do ambiente nos modos virtuais (RN-CLK-002).
      await sql`
        CREATE TABLE clock_state (
          id            smallint PRIMARY KEY CHECK (id = 1),
          mode          text NOT NULL CHECK (mode IN ('ACCELERATED', 'VIRTUAL')),
          virtual_now   timestamptz NOT NULL,
          speed_factor  double precision NOT NULL CHECK (speed_factor > 0)
        )`.execute(db);
    },
  },
  '0002_seed_routines': {
    // Tabela de rotinas do Pregão §8. Mudanças futuras entram como novas migrações.
    async up(db: Kysely<unknown>) {
      for (const r of DEFAULT_ROUTINES) {
        await sql`
          INSERT INTO routine_definition (name, owner, schedule, days, depends_on, enabled)
          VALUES (${r.name}, ${r.owner}, ${JSON.stringify(r.schedule)}, ${r.days}, ${[...r.dependsOn]}, ${r.enabled})
          ON CONFLICT (name) DO NOTHING`.execute(db);
      }
    },
  },
  '0003_audit_chain_verify': {
    // Rotina da auditoria (grupo 12): verificação diária da cadeia e âncora (RN-AUD-001/002).
    async up(db: Kysely<unknown>) {
      const r = DEFAULT_ROUTINES.find((d) => d.name === 'audit_chain_verify')!;
      await sql`
        INSERT INTO routine_definition (name, owner, schedule, days, depends_on, enabled)
        VALUES (${r.name}, ${r.owner}, ${JSON.stringify(r.schedule)}, ${r.days}, ${[...r.dependsOn]}, ${r.enabled})
        ON CONFLICT (name) DO NOTHING`.execute(db);
    },
  },
  '0004_customer_daily': {
    // Rotina do customer-service (grupo 14): expirações diárias.
    async up(db: Kysely<unknown>) {
      const r = DEFAULT_ROUTINES.find((d) => d.name === 'customer_daily')!;
      await sql`
        INSERT INTO routine_definition (name, owner, schedule, days, depends_on, enabled)
        VALUES (${r.name}, ${r.owner}, ${JSON.stringify(r.schedule)}, ${r.days}, ${[...r.dependsOn]}, ${r.enabled})
        ON CONFLICT (name) DO NOTHING`.execute(db);
    },
  },
  '0005_pix_reconciliation': {
    // Rotina do ledger-service (grupo 15): reconciliação PIX diária.
    async up(db: Kysely<unknown>) {
      const r = DEFAULT_ROUTINES.find((d) => d.name === 'pix_reconciliation')!;
      await sql`
        INSERT INTO routine_definition (name, owner, schedule, days, depends_on, enabled)
        VALUES (${r.name}, ${r.owner}, ${JSON.stringify(r.schedule)}, ${r.days}, ${[...r.dependsOn]}, ${r.enabled})
        ON CONFLICT (name) DO NOTHING`.execute(db);
    },
  },
  '0006_reference_daily': {
    // Rotina do reference-data-service (grupo 16): calendário e defasagem de cotação.
    async up(db: Kysely<unknown>) {
      const r = DEFAULT_ROUTINES.find((d) => d.name === 'reference_daily')!;
      await sql`
        INSERT INTO routine_definition (name, owner, schedule, days, depends_on, enabled)
        VALUES (${r.name}, ${r.owner}, ${JSON.stringify(r.schedule)}, ${r.days}, ${[...r.dependsOn]}, ${r.enabled})
        ON CONFLICT (name) DO NOTHING`.execute(db);
    },
  },
};
