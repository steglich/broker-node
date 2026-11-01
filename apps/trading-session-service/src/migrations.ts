import { baseMigrations, calendarReplicaMigrations, makeAppendOnly } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

const PHASES = sql.raw(
  `('CLOSED','PRE_TRADING','PRE_OPENING','CONTINUOUS','CLOSING_CALL','POST_CLOSE','AFTER_MARKET','VOLATILITY_AUCTION','HALTED')`,
);

/** Migrações da sessão: as da plataforma (outbox, inbox, offsets, calendário) e as próprias. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  ...calendarReplicaMigrations,
  '0001_session': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE trading_day (
          business_date  date PRIMARY KEY,
          status         text NOT NULL CHECK (status IN ('SCHEDULED', 'OPEN', 'CLOSED')),
          opened_at      timestamptz,
          closed_at      timestamptz
        )`.execute(db);
      // Linha única. `scheduled_phase` é a da grade: `phase` difere dela em suspensão e reabertura.
      await sql`
        CREATE TABLE market_phase_state (
          id               smallint PRIMARY KEY CHECK (id = 1),
          phase            text NOT NULL CHECK (phase IN ${PHASES}),
          scheduled_phase  text NOT NULL CHECK (scheduled_phase IN ${PHASES}),
          since            timestamptz NOT NULL,
          expected_end_at  timestamptz,
          reason           text NOT NULL,
          business_date    date
        )`.execute(db);
      await sql`
        INSERT INTO market_phase_state (id, phase, scheduled_phase, since, reason)
        VALUES (1, 'CLOSED', 'CLOSED', 'epoch', 'INITIAL')`.execute(db);
      // A fase própria (`phase`, null = segue o mercado), a cópia do reference-data e os preços da
      // sessão. `engine_phase` é a última fase mandada ao Motor.
      await sql`
        CREATE TABLE instrument_phase_state (
          instrument_id          uuid PRIMARY KEY,
          symbol                 text NOT NULL,
          tradable               boolean NOT NULL,
          status                 text NOT NULL,
          phase                  text CHECK (phase IN ${PHASES}),
          since                  timestamptz,
          expected_end_at        timestamptz,
          reason                 text,
          engine_phase           text CHECK (engine_phase IN ${PHASES}),
          previous_close         numeric(20, 8),
          band_reference_price   numeric(20, 8),
          last_trade_price       numeric(20, 8),
          last_trade_date        date,
          last_trade_seq         bigint,
          external_price         numeric(20, 8),
          external_quote_time    timestamptz
        )`.execute(db);
      await sql`CREATE INDEX instrument_phase_tradable_idx ON instrument_phase_state (symbol) WHERE tradable`.execute(
        db,
      );
      await sql`
        CREATE TABLE phase_transition (
          id            uuid PRIMARY KEY,
          scope         text NOT NULL,
          from_phase    text NOT NULL,
          to_phase      text NOT NULL,
          reason        text NOT NULL,
          effective_at  timestamptz NOT NULL,
          actor         text NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX phase_transition_scope_idx ON phase_transition (scope, effective_at)`.execute(
        db,
      );
      await makeAppendOnly(db, 'phase_transition');
      await sql`
        CREATE TABLE halt (
          id                   uuid PRIMARY KEY,
          scope                text NOT NULL,
          reason_code          text NOT NULL,
          description          text,
          started_at           timestamptz NOT NULL,
          ended_at             timestamptz,
          resume_at            timestamptz,
          resume_auction_s     integer NOT NULL CHECK (resume_auction_s > 0),
          cancel_all_on_halt   boolean NOT NULL DEFAULT false,
          actor_id             text NOT NULL,
          approval_request_id  uuid
        )`.execute(db);
      // Uma suspensão ativa por escopo e motivo: a repetição do mesmo motivo é a mesma suspensão.
      await sql`CREATE UNIQUE INDEX halt_active_uq ON halt (scope, reason_code) WHERE ended_at IS NULL`.execute(
        db,
      );
      await sql`
        CREATE TABLE circuit_breaker_event (
          id                    uuid PRIMARY KEY,
          business_date         date NOT NULL,
          level                 integer NOT NULL CHECK (level BETWEEN 1 AND 3),
          index_change_percent  numeric(12, 8),
          origin                text NOT NULL CHECK (origin IN ('INDEX', 'BACKOFFICE', 'SANDBOX')),
          triggered_at          timestamptz NOT NULL,
          resumes_at            timestamptz NOT NULL,
          UNIQUE (business_date, level)
        )`.execute(db);
      // `market_scoped`: termina junto com a fase do mercado; os demais, no próprio fim previsto.
      await sql`
        CREATE TABLE auction (
          id                    uuid PRIMARY KEY,
          instrument_id         uuid NOT NULL REFERENCES instrument_phase_state (instrument_id),
          type                  text NOT NULL CHECK (type IN ('OPENING', 'CLOSING', 'VOLATILITY', 'REOPENING')),
          status                text NOT NULL CHECK (status IN ('OPEN', 'HELD', 'CONCLUDING', 'COMPLETED', 'CANCELED')),
          market_scoped         boolean NOT NULL,
          business_date         date NOT NULL,
          started_at            timestamptz NOT NULL,
          expected_end_at       timestamptz NOT NULL,
          effective_end_at      timestamptz,
          extensions            integer NOT NULL DEFAULT 0 CHECK (extensions >= 0),
          theoretical_price     numeric(20, 8),
          theoretical_quantity  bigint,
          price                 numeric(20, 8),
          quantity              bigint
        )`.execute(db);
      await sql`CREATE INDEX auction_open_idx ON auction (expected_end_at) WHERE status IN ('OPEN', 'HELD')`.execute(
        db,
      );
      await sql`CREATE INDEX auction_instrument_idx ON auction (instrument_id, business_date)`.execute(
        db,
      );
      await sql`
        CREATE TABLE closing_price (
          instrument_id     uuid NOT NULL REFERENCES instrument_phase_state (instrument_id),
          business_date     date NOT NULL,
          price             numeric(20, 8) NOT NULL,
          source            text NOT NULL CHECK (source IN ('CLOSING_CALL', 'LAST_TRADE', 'PREVIOUS_CLOSE')),
          external_close    numeric(20, 8),
          divergence_alert  boolean NOT NULL DEFAULT false,
          PRIMARY KEY (instrument_id, business_date)
        )`.execute(db);
      // Vigências de `instrument_trading_rules` recebidas; `instrument_id` nulo é o padrão global.
      await sql`
        CREATE TABLE trading_rule_version (
          rule_id        uuid PRIMARY KEY,
          instrument_id  uuid,
          rules          jsonb NOT NULL,
          valid_from     timestamptz NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX trading_rule_lookup_idx ON trading_rule_version (instrument_id, valid_from)`.execute(
        db,
      );
      // RN-ROT-001: a execução de cada rotina; `PENDING` espera o fim das calls prorrogadas.
      await sql`
        CREATE TABLE session_routine (
          routine_name   text NOT NULL,
          business_date  date NOT NULL,
          execution_id   uuid NOT NULL,
          status         text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED')),
          stats          jsonb NOT NULL DEFAULT '{}',
          PRIMARY KEY (routine_name, business_date)
        )`.execute(db);
      // Linha única: última leitura do Ibovespa externo e vigilância do Market Data (Pregão §5–§6).
      await sql`
        CREATE TABLE market_watch (
          id                    smallint PRIMARY KEY CHECK (id = 1),
          index_last            numeric(20, 8),
          index_previous_close  numeric(20, 8),
          index_quote_time      timestamptz,
          last_market_data_at   timestamptz,
          budget_level          text NOT NULL DEFAULT 'NORMAL'
        )`.execute(db);
      await sql`INSERT INTO market_watch (id) VALUES (1)`.execute(db);
      await sql`
        CREATE TABLE session_alert (
          id          uuid PRIMARY KEY,
          kind        text NOT NULL,
          dedupe_key  text NOT NULL UNIQUE,
          message     text NOT NULL,
          data        jsonb NOT NULL,
          created_at  timestamptz NOT NULL
        )`.execute(db);
      // Dupla aprovação local (Backoffice §3–§4): na Fase 3 vira o approval-service.
      await sql`
        CREATE TABLE session_change_request (
          id               uuid PRIMARY KEY,
          type             text NOT NULL CHECK (type IN ('MARKET_HALT', 'MARKET_RESUME', 'CIRCUIT_BREAKER')),
          payload          jsonb NOT NULL,
          current_state    jsonb NOT NULL,
          justification    text NOT NULL,
          maker_id         text NOT NULL,
          status           text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELED', 'STALE')),
          created_at       timestamptz NOT NULL,
          expires_at       timestamptz NOT NULL,
          decided_by       text,
          decided_at       timestamptz,
          decision_reason  text
        )`.execute(db);
      await sql`CREATE INDEX session_change_request_pending_idx ON session_change_request (expires_at) WHERE status = 'PENDING'`.execute(
        db,
      );
    },
  },
};
