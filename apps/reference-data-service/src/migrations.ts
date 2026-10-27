import { b3Calendar2026To2027 } from '@broker/calendar';
import { BusinessDate } from '@broker/domain-kernel';
import { baseMigrations } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { plainDay } from './domain/calendar.js';
import { SEED_TYPE_DEFAULTS } from './domain/instrument.js';
import { DEFAULT_TRADING_RULES } from './domain/trading-rules.js';

/** Solicitação fictícia das sementes (não houve aprovação: é o padrão de fábrica). */
export const SEED_APPROVAL_ID = '00000000-0000-0000-0000-000000000000';

/** Migrações do reference-data: as da plataforma (outbox, inbox, offsets) e as próprias. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  '0001_instruments': {
    async up(db: Kysely<unknown>) {
      // Padrões de cadastro por tipo (Ativos §2.2), editáveis pelo backoffice.
      await sql`
        CREATE TABLE instrument_type_default (
          asset_type           text PRIMARY KEY CHECK (asset_type IN ('STOCK', 'UNIT', 'REIT', 'ETF', 'BDR')),
          lot_size             integer NOT NULL CHECK (lot_size > 0),
          tick_size            numeric(20, 8) NOT NULL CHECK (tick_size > 0),
          short_sale_enabled   boolean NOT NULL,
          day_trade_enabled    boolean NOT NULL,
          collateral_eligible  boolean NOT NULL,
          haircut              numeric(9, 8) CHECK (haircut BETWEEN 0 AND 1),
          tax_category         text NOT NULL CHECK (tax_category IN ('STOCK', 'REIT', 'ETF_EQUITY', 'BDR')),
          CHECK (collateral_eligible = (haircut IS NOT NULL))
        )`.execute(db);
      // Ativos §2.1. O fracionário é derivado (RN-INS-002/006): coluna gerada, nunca editada.
      await sql`
        CREATE TABLE instrument (
          id                   uuid PRIMARY KEY,
          symbol               text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9]{3,5}[0-9]{1,2}$'),
          isin                 text CHECK (isin ~ '^[A-Z]{2}[A-Z0-9]{10}$'),
          short_name           text,
          long_name            text,
          asset_type           text NOT NULL CHECK (asset_type IN ('STOCK', 'UNIT', 'REIT', 'ETF', 'BDR')),
          share_class          text NOT NULL CHECK (share_class IN ('ON', 'PN', 'PNA', 'PNB', 'UNIT', 'N/A')),
          sector               text,
          subsector            text,
          currency             text NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
          lot_size             integer NOT NULL CHECK (lot_size > 0),
          tick_size            numeric(20, 8) NOT NULL CHECK (tick_size > 0),
          odd_lot_enabled      boolean GENERATED ALWAYS AS (lot_size > 1) STORED,
          odd_lot_symbol       text GENERATED ALWAYS AS (CASE WHEN lot_size > 1 THEN symbol || 'F' END) STORED,
          short_sale_enabled   boolean NOT NULL,
          day_trade_enabled    boolean NOT NULL,
          collateral_eligible  boolean NOT NULL,
          haircut              numeric(9, 8) CHECK (haircut BETWEEN 0 AND 1),
          tax_category         text NOT NULL CHECK (tax_category IN ('STOCK', 'REIT', 'ETF_EQUITY', 'BDR')),
          status               text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'DELISTED')),
          status_reason        text,
          tradable             boolean NOT NULL DEFAULT false,
          logo_url             text,
          source               text NOT NULL CHECK (source IN ('BRAPI', 'MANUAL')),
          stale_since          timestamptz,
          created_at           timestamptz NOT NULL,
          updated_at           timestamptz NOT NULL,
          CHECK (collateral_eligible = (haircut IS NOT NULL)),
          CHECK (NOT (tradable AND status = 'DELISTED'))
        )`.execute(db);
      // Ticker único entre os instrumentos não deslistados (Ativos §2.1).
      await sql`CREATE UNIQUE INDEX instrument_symbol_uq ON instrument (symbol) WHERE status <> 'DELISTED'`.execute(
        db,
      );
      await sql`CREATE INDEX instrument_tradable_idx ON instrument (symbol) WHERE tradable`.execute(
        db,
      );
      await sql`CREATE INDEX instrument_stale_idx ON instrument (id) WHERE stale_since IS NOT NULL`.execute(
        db,
      );
      await sql`CREATE INDEX instrument_name_idx ON instrument (lower(short_name) text_pattern_ops)`.execute(
        db,
      );
      // RN-INS-030: tickers antigos com vigência (datas inclusivas).
      await sql`
        CREATE TABLE instrument_symbol_history (
          instrument_id     uuid NOT NULL REFERENCES instrument (id),
          symbol            text NOT NULL,
          valid_from        date NOT NULL,
          valid_to          date NOT NULL,
          conversion_ratio  numeric(20, 8),
          PRIMARY KEY (instrument_id, valid_from),
          CHECK (valid_to >= valid_from)
        )`.execute(db);
      await sql`CREATE INDEX instrument_symbol_history_symbol_idx ON instrument_symbol_history (symbol, valid_to DESC)`.execute(
        db,
      );
      for (const d of SEED_TYPE_DEFAULTS) {
        await sql`
          INSERT INTO instrument_type_default (asset_type, lot_size, tick_size, short_sale_enabled, day_trade_enabled,
                                               collateral_eligible, haircut, tax_category)
          VALUES (${d.assetType}, ${d.lotSize}, ${d.tickSize}, ${d.shortSaleEnabled}, ${d.dayTradeEnabled},
                  ${d.collateralEligible}, ${d.haircut}, ${d.taxCategory})`.execute(db);
      }
    },
  },
  '0002_change_requests_tasks': {
    async up(db: Kysely<unknown>) {
      // Dupla aprovação local (Backoffice §4) até o approval-service (Fase 3).
      await sql`
        CREATE TABLE change_request (
          id               uuid PRIMARY KEY,
          type             text NOT NULL CHECK (type IN ('UNIVERSE_INCLUDE', 'UNIVERSE_REMOVE', 'TRADING_RULES', 'CALENDAR', 'SESSION_SCHEDULE')),
          target_id        text NOT NULL,
          payload          jsonb NOT NULL,
          current_state    jsonb NOT NULL,
          justification    text NOT NULL,
          maker_id         text NOT NULL,
          status           text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELED', 'STALE')),
          created_at       timestamptz NOT NULL,
          expires_at       timestamptz NOT NULL,
          decided_by       text,
          decided_at       timestamptz,
          decision_reason  text,
          -- RN-BO-001: o maker nunca decide a própria solicitação.
          CHECK (status NOT IN ('APPROVED', 'REJECTED') OR decided_by <> maker_id)
        )`.execute(db);
      await sql`CREATE UNIQUE INDEX change_request_pending_uq ON change_request (type, target_id) WHERE status = 'PENDING'`.execute(
        db,
      );
      await sql`CREATE INDEX change_request_status_idx ON change_request (status, created_at DESC)`.execute(
        db,
      );
      await sql`
        CREATE TABLE backoffice_task (
          id             uuid PRIMARY KEY,
          kind           text NOT NULL,
          dedupe_key     text NOT NULL UNIQUE,
          instrument_id  uuid REFERENCES instrument (id),
          data           jsonb NOT NULL,
          status         text NOT NULL CHECK (status IN ('OPEN', 'DONE', 'DISMISSED')),
          created_at     timestamptz NOT NULL,
          resolved_by    text,
          resolved_at    timestamptz
        )`.execute(db);
      await sql`CREATE INDEX backoffice_task_status_idx ON backoffice_task (status, created_at DESC)`.execute(
        db,
      );
    },
  },
  '0003_trading_rules': {
    async up(db: Kysely<unknown>) {
      // Ativos §7: vigência [valid_from, valid_to); global (instrument_id NULL) com todos os campos,
      // sobrescrita só com os campos que muda. Uma vigência aberta por escopo.
      await sql`
        CREATE TABLE instrument_trading_rules (
          id                              uuid PRIMARY KEY,
          instrument_id                   uuid REFERENCES instrument (id),
          rejection_band_pct              numeric(9, 8),
          static_auction_band_pct         numeric(9, 8),
          dynamic_auction_band_pct        numeric(9, 8),
          volatility_auction_duration_s   integer,
          volatility_auction_extension_s  integer,
          auction_random_end_max_s        integer,
          max_order_quantity              bigint,
          max_order_notional              numeric(20, 2),
          market_protection_pct           numeric(9, 8),
          smm_spread_bps                  integer,
          valid_from                      timestamptz NOT NULL,
          valid_to                        timestamptz,
          approval_request_id             uuid NOT NULL,
          CHECK (valid_to IS NULL OR valid_to > valid_from),
          CHECK (instrument_id IS NOT NULL OR (
            rejection_band_pct IS NOT NULL AND static_auction_band_pct IS NOT NULL AND dynamic_auction_band_pct IS NOT NULL
            AND volatility_auction_duration_s IS NOT NULL AND volatility_auction_extension_s IS NOT NULL
            AND auction_random_end_max_s IS NOT NULL AND max_order_quantity IS NOT NULL
            AND max_order_notional IS NOT NULL AND market_protection_pct IS NOT NULL AND smm_spread_bps IS NOT NULL))
        )`.execute(db);
      await sql`
        CREATE UNIQUE INDEX instrument_trading_rules_from_uq
          ON instrument_trading_rules (COALESCE(instrument_id, '00000000-0000-0000-0000-000000000000'::uuid), valid_from)`.execute(
        db,
      );
      await sql`
        CREATE UNIQUE INDEX instrument_trading_rules_open_uq
          ON instrument_trading_rules (COALESCE(instrument_id, '00000000-0000-0000-0000-000000000000'::uuid))
          WHERE valid_to IS NULL`.execute(db);
      const r = DEFAULT_TRADING_RULES;
      await sql`
        INSERT INTO instrument_trading_rules (id, instrument_id, rejection_band_pct, static_auction_band_pct,
          dynamic_auction_band_pct, volatility_auction_duration_s, volatility_auction_extension_s,
          auction_random_end_max_s, max_order_quantity, max_order_notional, market_protection_pct, smm_spread_bps,
          valid_from, approval_request_id)
        VALUES (gen_random_uuid(), NULL, ${r.rejectionBandPct}, ${r.staticAuctionBandPct}, ${r.dynamicAuctionBandPct},
          ${r.volatilityAuctionDurationS}, ${r.volatilityAuctionExtensionS}, ${r.auctionRandomEndMaxS},
          ${r.maxOrderQuantity}, ${r.maxOrderNotional}, ${r.marketProtectionPct}, ${r.smmSpreadBps},
          '2026-01-01T00:00:00Z', ${SEED_APPROVAL_ID})`.execute(db);
    },
  },
  '0004_calendar': {
    async up(db: Kysely<unknown>) {
      // RN-CAL-001: todo dia do período carregado, com o tipo; o período é [min(date), max(date)].
      await sql`
        CREATE TABLE trading_calendar (
          date                 date PRIMARY KEY,
          day_type             text NOT NULL CHECK (day_type IN ('BUSINESS_DAY', 'HOLIDAY', 'NO_TRADING', 'LATE_OPEN', 'WEEKEND')),
          description          text,
          session_schedule_id  uuid,
          CHECK ((day_type = 'WEEKEND') = (extract(isodow FROM date) IN (6, 7)))
        )`.execute(db);
      // RN-CAL-003: grade com vigência (datas inclusivas) por tipo de dia com pregão.
      await sql`
        CREATE TABLE session_schedule (
          id          uuid PRIMARY KEY,
          name        text NOT NULL,
          day_type    text NOT NULL CHECK (day_type IN ('BUSINESS_DAY', 'LATE_OPEN')),
          phases      jsonb NOT NULL,
          valid_from  date NOT NULL,
          valid_to    date,
          CHECK (valid_to IS NULL OR valid_to >= valid_from),
          UNIQUE (day_type, valid_from)
        )`.execute(db);
      await sql`CREATE UNIQUE INDEX session_schedule_open_uq ON session_schedule (day_type) WHERE valid_to IS NULL`.execute(
        db,
      );
      // Versão do calendário: a trava serializa mudanças e invalida propostas antigas e caches.
      await sql`
        CREATE TABLE calendar_state (
          id       smallint PRIMARY KEY CHECK (id = 1),
          version  integer NOT NULL
        )`.execute(db);
      await sql`INSERT INTO calendar_state (id, version) VALUES (1, 1)`.execute(db);
      // Semente B3 2026–2027 (D15).
      const seed = b3Calendar2026To2027;
      const special = new Map(seed.days.map((d) => [d.date, d]));
      const to = BusinessDate.parse(seed.coverage.to);
      for (let d = BusinessDate.parse(seed.coverage.from); !d.isAfter(to); d = d.plusDays(1)) {
        const s = special.get(d.toString());
        const row = s ? { dayType: s.type, description: s.description } : plainDay(d);
        await sql`
          INSERT INTO trading_calendar (date, day_type, description)
          VALUES (${d.toString()}, ${row.dayType}, ${row.description})`.execute(db);
      }
      for (const s of seed.schedules) {
        await sql`
          INSERT INTO session_schedule (id, name, day_type, phases, valid_from, valid_to)
          VALUES (gen_random_uuid(), ${s.dayType === 'LATE_OPEN' ? 'Abertura tardia' : 'Grade padrão'}, ${s.dayType},
                  ${JSON.stringify(s.phases)}, ${s.validFrom}, ${s.validTo})`.execute(db);
      }
    },
  },
};
