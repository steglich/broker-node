import { baseMigrations } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Migrações do Risco: as da plataforma (outbox, inbox, offsets) e as próprias. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  '0001_risk': {
    async up(db: Kysely<unknown>) {
      // Cerca do líder (D14): cada eleição sobe a época, e a escrita de um líder antigo é recusada.
      await sql`
        CREATE TABLE risk_leader (
          id     smallint PRIMARY KEY CHECK (id = 1),
          epoch  bigint NOT NULL
        )`.execute(db);
      await sql`INSERT INTO risk_leader (id, epoch) VALUES (1, 0)`.execute(db);
      // A linha trava os eventos de uma conta: são gravados aqui, na transação do offset (Cache §2).
      await sql`
        CREATE TABLE account_risk_projection (
          account_id       uuid PRIMARY KEY,
          account_status   text,
          settled_balance  numeric(18, 2) NOT NULL DEFAULT 0,
          projected_d0     numeric(18, 2) NOT NULL DEFAULT 0,
          projected_d1     numeric(18, 2) NOT NULL DEFAULT 0,
          projected_d2     numeric(18, 2) NOT NULL DEFAULT 0,
          last_ledger_seq  bigint NOT NULL DEFAULT 0
        )`.execute(db);
      await sql`
        CREATE TABLE risk_position (
          account_id     uuid NOT NULL,
          instrument_id  uuid NOT NULL,
          quantity       bigint NOT NULL,
          PRIMARY KEY (account_id, instrument_id)
        )`.execute(db);
      // Pontas dos negócios. `executed = false`: o lançamento do ledger chegou antes do negócio do
      // Motor (tópicos diferentes), e a ponta só marca que o principal já está em P2 (ADR-0003).
      await sql`
        CREATE TABLE risk_trade (
          trade_id        uuid NOT NULL,
          side            text NOT NULL CHECK (side IN ('BUY', 'SELL')),
          account_id      uuid NOT NULL,
          instrument_id   uuid,
          quantity        bigint NOT NULL DEFAULT 0,
          notional        numeric(18, 2) NOT NULL DEFAULT 0,
          estimated_cost  numeric(18, 2) NOT NULL DEFAULT 0,
          trading_date    date,
          executed        boolean NOT NULL,
          booked          boolean NOT NULL DEFAULT false,
          fees_booked     boolean NOT NULL DEFAULT false,
          busted          boolean NOT NULL DEFAULT false,
          PRIMARY KEY (trade_id, side)
        )`.execute(db);
      await sql`
        CREATE INDEX risk_trade_open_idx ON risk_trade (account_id)
        WHERE executed AND NOT busted AND NOT (booked AND fees_booked)`.execute(db);
      // Modelo de dados §8. Uma reserva por referência e tipo.
      await sql`
        CREATE TABLE hold (
          id                  uuid PRIMARY KEY,
          account_id          uuid NOT NULL,
          type                text NOT NULL CHECK (type IN ('ORDER_CASH', 'ORDER_POSITION', 'ORDER_MARGIN',
                                                            'WITHDRAWAL', 'BTC_COLLATERAL', 'BTC_LENT')),
          resource            text NOT NULL,
          original_amount     numeric(18, 2) NOT NULL CHECK (original_amount >= 0),
          remaining_amount    numeric(18, 2) NOT NULL CHECK (remaining_amount >= 0),
          original_quantity   bigint,
          remaining_quantity  bigint CHECK (remaining_quantity >= 0),
          reference_type      text NOT NULL,
          reference_id        text NOT NULL,
          status              text NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
          created_at          timestamptz NOT NULL,
          updated_at          timestamptz NOT NULL,
          UNIQUE (reference_type, reference_id, type)
        )`.execute(db);
      await sql`CREATE INDEX hold_active_idx ON hold (account_id) WHERE status = 'ACTIVE'`.execute(
        db,
      );
      // Estado da referência dos holds: ordens abertas (RN do limite) e terminais (RN-HLD-007).
      await sql`
        CREATE TABLE hold_reference (
          reference_type  text NOT NULL,
          reference_id    text NOT NULL,
          account_id      uuid NOT NULL,
          status          text,
          terminal_at     timestamptz,
          PRIMARY KEY (reference_type, reference_id)
        )`.execute(db);
      await sql`
        CREATE INDEX hold_reference_open_idx ON hold_reference (account_id)
        WHERE terminal_at IS NULL`.execute(db);
      await sql`
        CREATE INDEX hold_reference_terminal_idx ON hold_reference (terminal_at)
        WHERE terminal_at IS NOT NULL`.execute(db);
      // Idempotência do pré-trade (Contratos §10.1): repetir o `requestId` devolve a mesma decisão.
      await sql`
        CREATE TABLE pretrade_decision (
          request_id  text PRIMARY KEY,
          account_id  uuid NOT NULL,
          response    jsonb NOT NULL,
          created_at  timestamptz NOT NULL
        )`.execute(db);
      await sql`
        CREATE TABLE risk_price (
          instrument_id  uuid PRIMARY KEY,
          price          numeric(20, 8) NOT NULL,
          seq            bigint NOT NULL
        )`.execute(db);
    },
  },
};
