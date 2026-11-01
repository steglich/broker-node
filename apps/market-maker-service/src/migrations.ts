import { baseMigrations } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

const PHASES = sql.raw(
  `('CLOSED','PRE_TRADING','PRE_OPENING','CONTINUOUS','CLOSING_CALL','POST_CLOSE','AFTER_MARKET','VOLATILITY_AUCTION','HALTED')`,
);

/** Migrações do FMS: as da plataforma (outbox, inbox, offsets) e as próprias. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  '0001_market_maker': {
    async up(db: Kysely<unknown>) {
      // Linha única: fase do mercado e kill switch global (RN-SMM-030).
      await sql`
        CREATE TABLE smm_control (
          id              smallint PRIMARY KEY CHECK (id = 1),
          market_phase    text NOT NULL CHECK (market_phase IN ${PHASES}),
          global_enabled  boolean NOT NULL DEFAULT true
        )`.execute(db);
      await sql`INSERT INTO smm_control (id, market_phase) VALUES (1, 'CLOSED')`.execute(db);
      // Modelo de dados §`smm_state`. Nasce com o primeiro evento que citar o instrumento, em qualquer
      // tópico: a ordem entre tópicos não é garantida, e cadastro, preço e túnel chegam em separado.
      await sql`
        CREATE TABLE smm_state (
          instrument_id        uuid PRIMARY KEY,
          symbol               text,
          lot_size             integer,
          tick_size            numeric(20, 8),
          odd_lot              boolean NOT NULL DEFAULT false,
          tradable             boolean NOT NULL DEFAULT false,
          status               text NOT NULL DEFAULT 'PENDING',
          enabled              boolean NOT NULL DEFAULT true,
          activated_at         timestamptz,
          initial_stock        bigint NOT NULL DEFAULT 0,
          own_phase            text CHECK (own_phase IN ${PHASES}),
          reference_price      numeric(20, 8),
          reference_seq        bigint NOT NULL DEFAULT 0,
          external_quote_time  timestamptz,
          stale_since          timestamptz,
          stale_at             timestamptz,
          stopped              boolean NOT NULL DEFAULT false,
          band_reference       numeric(20, 8),
          rejection_band_pct   numeric(20, 8),
          inventory            bigint NOT NULL DEFAULT 0,
          average_cost         numeric(24, 8) NOT NULL DEFAULT 0,
          cash_flow            numeric(24, 8) NOT NULL DEFAULT 0,
          realized_pnl         numeric(24, 8) NOT NULL DEFAULT 0,
          volume               bigint NOT NULL DEFAULT 0,
          live_orders          jsonb NOT NULL DEFAULT '[]',
          last_reference       numeric(20, 8),
          last_requote_at      timestamptz,
          spread_multiplier    integer NOT NULL DEFAULT 1,
          best_bid             numeric(20, 8),
          best_ask             numeric(20, 8),
          requotes             bigint NOT NULL DEFAULT 0,
          quoted_ms            bigint NOT NULL DEFAULT 0,
          quoted_since         timestamptz,
          book_seq             bigint NOT NULL DEFAULT 0
        )`.execute(db);
      // Cada vigência traz só os campos que muda; `instrument_id` nulo é o padrão global.
      await sql`
        CREATE TABLE smm_parameters (
          id                   uuid PRIMARY KEY,
          instrument_id        uuid,
          params               jsonb NOT NULL,
          valid_from           timestamptz NOT NULL,
          approval_request_id  uuid
        )`.execute(db);
      await sql`CREATE INDEX smm_parameters_lookup_idx ON smm_parameters (instrument_id, valid_from)`.execute(
        db,
      );
      // Livro principal agregado por preço, com as ofertas do próprio FMS: base da varredura (RN-SMM-012).
      await sql`
        CREATE TABLE smm_book_level (
          instrument_id  uuid NOT NULL,
          side           text NOT NULL CHECK (side IN ('BUY', 'SELL')),
          price          numeric(20, 8) NOT NULL,
          quantity       bigint NOT NULL CHECK (quantity > 0),
          PRIMARY KEY (instrument_id, side, price)
        )`.execute(db);
      // A chave é por lado porque o trade bust precisa desfazer cada ponta do FMS.
      await sql`
        CREATE TABLE smm_fill (
          trade_id       uuid NOT NULL,
          side           text NOT NULL CHECK (side IN ('BUY', 'SELL')),
          instrument_id  uuid NOT NULL,
          quantity       bigint NOT NULL CHECK (quantity > 0),
          price          numeric(20, 8) NOT NULL,
          engine_seq     bigint NOT NULL,
          executed_at    timestamptz NOT NULL,
          busted         boolean NOT NULL DEFAULT false,
          PRIMARY KEY (trade_id, side)
        )`.execute(db);
      await sql`CREATE INDEX smm_fill_instrument_idx ON smm_fill (instrument_id, executed_at, engine_seq)`.execute(
        db,
      );
      // Dupla aprovação local (Backoffice §3–§4): na Fase 3 vira o approval-service.
      await sql`
        CREATE TABLE smm_change_request (
          id               uuid PRIMARY KEY,
          type             text NOT NULL CHECK (type IN ('SMM_ENABLE', 'SMM_PARAMETERS')),
          payload          jsonb NOT NULL,
          current_state    text NOT NULL,
          justification    text NOT NULL,
          maker_id         text NOT NULL,
          status           text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELED', 'STALE')),
          created_at       timestamptz NOT NULL,
          expires_at       timestamptz NOT NULL,
          decided_by       text,
          decided_at       timestamptz,
          decision_reason  text
        )`.execute(db);
      await sql`CREATE INDEX smm_change_request_pending_idx ON smm_change_request (expires_at) WHERE status = 'PENDING'`.execute(
        db,
      );
    },
  },
};
