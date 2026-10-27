import { baseMigrations, calendarReplicaMigrations, makeAppendOnly } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Migrações do market-data: as da plataforma (outbox, inbox, offsets, calendário) e as próprias. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  ...calendarReplicaMigrations,
  '0001_instruments_catalog': {
    async up(db: Kysely<unknown>) {
      // Cópia local dos instrumentos (instrument.* do reference-data-service).
      await sql`
        CREATE TABLE instrument_ref (
          instrument_id  uuid PRIMARY KEY,
          symbol         text NOT NULL,
          tick_size      numeric(20, 8) NOT NULL,
          tradable       boolean NOT NULL,
          status         text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'DELISTED')),
          updated_at     timestamptz NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX instrument_ref_symbol_idx ON instrument_ref (symbol)`.execute(db);
      // Catálogo da fonte (E1): base para os tickers novos e os que saíram.
      await sql`
        CREATE TABLE catalog_entry (
          symbol         text PRIMARY KEY,
          short_name     text,
          long_name      text,
          asset_type     text NOT NULL CHECK (asset_type IN ('STOCK', 'UNIT', 'REIT', 'ETF', 'BDR')),
          sector         text,
          logo_url       text,
          active         boolean NOT NULL,
          first_seen_at  timestamptz NOT NULL,
          last_seen_at   timestamptz NOT NULL
        )`.execute(db);
      // Renomeações já publicadas (market_data.symbol_rename_detected uma vez por troca).
      await sql`
        CREATE TABLE symbol_rename_seen (
          old_symbol  text NOT NULL,
          new_symbol  text NOT NULL,
          seen_at     timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (old_symbol, new_symbol)
        )`.execute(db);
    },
  },
  '0002_external_quotes': {
    async up(db: Kysely<unknown>) {
      // Última leitura aceita por símbolo (Brapi §7). O ticker é o pedido (o nosso).
      await sql`
        CREATE TABLE external_quote (
          symbol         text PRIMARY KEY,
          instrument_id  uuid,
          kind           text NOT NULL CHECK (kind IN ('INSTRUMENT', 'INDEX')),
          last_price     numeric(20, 8) NOT NULL CHECK (last_price > 0),
          quote_time     timestamptz NOT NULL,
          data           jsonb NOT NULL,
          fetched_at     timestamptz NOT NULL,
          provider       text NOT NULL,
          raw_sha256     text NOT NULL,
          stale          boolean NOT NULL DEFAULT false,
          stale_since    timestamptz
        )`.execute(db);
      // RN-BRP-060: toda leitura bem-sucedida, com o destino (aceita, quarentena, descartada).
      await sql`
        CREATE TABLE external_quote_history (
          id             uuid PRIMARY KEY,
          symbol         text NOT NULL,
          instrument_id  uuid,
          provider       text NOT NULL,
          fetched_at     timestamptz NOT NULL,
          quote_time     timestamptz NOT NULL,
          data           jsonb NOT NULL,
          raw_sha256     text NOT NULL,
          disposition    text NOT NULL CHECK (disposition IN ('ACCEPTED', 'UNCHANGED', 'QUARANTINED', 'DISCARDED_OUT_OF_ORDER')),
          warnings       jsonb NOT NULL DEFAULT '[]'
        )`.execute(db);
      await sql`CREATE INDEX external_quote_history_symbol_idx ON external_quote_history (symbol, quote_time DESC)`.execute(
        db,
      );
      await makeAppendOnly(db, 'external_quote_history');
      // RN-BRP-071: leitura com salto, à espera da confirmação pela seguinte.
      await sql`
        CREATE TABLE quote_quarantine (
          symbol      text PRIMARY KEY,
          price       numeric(20, 8) NOT NULL,
          quote_time  timestamptz NOT NULL,
          since       timestamptz NOT NULL,
          jump_pct    numeric(12, 6) NOT NULL
        )`.execute(db);
      // RN-BRP-050: próxima leitura de cada símbolo.
      await sql`
        CREATE TABLE quote_schedule (
          symbol             text PRIMARY KEY,
          next_read_at       timestamptz NOT NULL,
          unchanged_retries  integer NOT NULL DEFAULT 0,
          last_quote_time    timestamptz
        )`.execute(db);
      // Candles diários externos: carga do E3 e snapshot pós-fechamento (Brapi §7, RN-BRP-062).
      await sql`
        CREATE TABLE external_daily_candle (
          symbol          text NOT NULL,
          date            date NOT NULL,
          open            numeric(20, 8) NOT NULL,
          high            numeric(20, 8) NOT NULL,
          low             numeric(20, 8) NOT NULL,
          close           numeric(20, 8) NOT NULL,
          adjusted_close  numeric(20, 8),
          volume          numeric(24, 0) NOT NULL,
          source          text NOT NULL CHECK (source IN ('HISTORY', 'CLOSE_SNAPSHOT')),
          PRIMARY KEY (symbol, date)
        )`.execute(db);
      await sql`
        CREATE TABLE history_fetch (
          symbol      text PRIMARY KEY,
          fetched_at  timestamptz NOT NULL
        )`.execute(db);
    },
  },
  '0003_provider_state': {
    async up(db: Kysely<unknown>) {
      // Orçamento (RN-BRP-030..035): leitura do E9, contador local e nível. Linha única.
      await sql`
        CREATE TABLE provider_usage (
          id                  smallint PRIMARY KEY CHECK (id = 1),
          usage               jsonb,
          usage_read_at       timestamptz,
          sent_since_usage    integer NOT NULL DEFAULT 0,
          quota_exhausted     boolean NOT NULL DEFAULT false,
          level               text NOT NULL DEFAULT 'NORMAL' CHECK (level IN ('NORMAL', 'SAVING', 'CRITICAL', 'EXHAUSTED')),
          auth_blocked_token  text,
          updated_at          timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
      await sql`INSERT INTO provider_usage (id) VALUES (1)`.execute(db);
      // 403: capacidade fora do plano por 24 h (Brapi §10).
      await sql`
        CREATE TABLE provider_capability (
          capability          text PRIMARY KEY,
          unavailable_until   timestamptz NOT NULL,
          reason              text NOT NULL
        )`.execute(db);
      // Alertas do painel de integrações do backoffice (Brapi §11).
      await sql`
        CREATE TABLE provider_alert (
          id          uuid PRIMARY KEY,
          kind        text NOT NULL,
          severity    text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
          message     text NOT NULL,
          data        jsonb NOT NULL,
          created_at  timestamptz NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX provider_alert_created_idx ON provider_alert (created_at DESC)`.execute(
        db,
      );
      // Rotinas do agendador executadas pelo líder (routine.triggered → routine.completed).
      await sql`
        CREATE TABLE provider_job (
          id             uuid PRIMARY KEY,
          routine_name   text NOT NULL,
          business_date  date NOT NULL,
          execution_id   uuid NOT NULL,
          status         text NOT NULL CHECK (status IN ('PENDING', 'DONE', 'FAILED')),
          created_at     timestamptz NOT NULL DEFAULT now(),
          finished_at    timestamptz,
          UNIQUE (routine_name, business_date)
        )`.execute(db);
      await sql`CREATE INDEX provider_job_pending_idx ON provider_job (created_at) WHERE status = 'PENDING'`.execute(
        db,
      );
      // Jobs periódicos do próprio serviço: catálogo do dia (06:30) e verificação semanal do
      // esquema (RN-BRP-100), uma vez por período mesmo com várias instâncias.
      await sql`
        CREATE TABLE provider_job_run (
          job         text NOT NULL,
          period_key  text NOT NULL,
          ran_at      timestamptz NOT NULL,
          PRIMARY KEY (job, period_key)
        )`.execute(db);
    },
  },
  '0004_reference_price': {
    async up(db: Kysely<unknown>) {
      // Estado do preço de referência do dia (Brapi §8): gerador semeado, ruído, glide e seq.
      await sql`
        CREATE TABLE reference_price_state (
          instrument_id  uuid PRIMARY KEY,
          trading_date   date NOT NULL,
          state          jsonb NOT NULL,
          updated_at     timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
      // RN-SYN-006: referência fixada por um período.
      await sql`
        CREATE TABLE reference_override (
          id             uuid PRIMARY KEY,
          instrument_id  uuid NOT NULL,
          price          numeric(20, 4) NOT NULL CHECK (price > 0),
          valid_from     timestamptz NOT NULL,
          valid_until    timestamptz NOT NULL,
          created_by     text NOT NULL,
          reason         text NOT NULL,
          created_at     timestamptz NOT NULL,
          CHECK (valid_until > valid_from)
        )`.execute(db);
      await sql`CREATE INDEX reference_override_instrument_idx ON reference_override (instrument_id, valid_from)`.execute(
        db,
      );
      // RN-SYN-004: ruído desligável por instrumento (o global é configuração).
      await sql`
        CREATE TABLE reference_noise (
          instrument_id  uuid PRIMARY KEY,
          enabled        boolean NOT NULL,
          updated_by     text NOT NULL,
          updated_at     timestamptz NOT NULL
        )`.execute(db);
    },
  },
};
