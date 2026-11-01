import { baseMigrations, environmentClockMigrations, makeAppendOnly } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Migrações do Motor: as da plataforma (outbox, inbox, offsets, relógio) e as próprias (D12). */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  ...environmentClockMigrations,
  '0001_engine': {
    async up(db: Kysely<unknown>) {
      // Quem o Motor já viu, e em que partição: a recuperação e o corte das notas partem daqui.
      await sql`
        CREATE TABLE engine_instrument (
          instrument_id  text PRIMARY KEY,
          partition      integer NOT NULL,
          created_at     timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
      await sql`CREATE INDEX engine_instrument_partition_idx ON engine_instrument (partition)`.execute(
        db,
      );

      // RN-ME-003: gravado antes de processar. A chave primária também é a cerca contra um líder
      // antigo: dois escritores no mesmo livro colidem no mesmo `input_seq`.
      await sql`
        CREATE TABLE engine_journal (
          instrument_id   text NOT NULL,
          input_seq       bigint NOT NULL,
          command_id      uuid,
          command         jsonb NOT NULL,
          ts              timestamptz NOT NULL,
          trading_date    date NOT NULL,
          seed            bigint NOT NULL,
          correlation_id  text NOT NULL,
          recorded_at     timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (instrument_id, input_seq)
        )`.execute(db);
      // O broker pode reentregar um comando com outro offset (relay do produtor repetindo).
      await sql`
        CREATE UNIQUE INDEX engine_journal_command_idx ON engine_journal (instrument_id, command_id)
        WHERE command_id IS NOT NULL`.execute(db);
      await makeAppendOnly(db, 'engine_journal');

      // RN-ME-004. `seq` dá a ordem de publicação; o relay deduplica pelo `engine_seq`.
      await sql`
        CREATE TABLE engine_output (
          instrument_id   text NOT NULL,
          board           text NOT NULL CHECK (board IN ('MAIN', 'ODD_LOT')),
          engine_seq      bigint NOT NULL,
          input_seq       bigint NOT NULL,
          seq             bigserial NOT NULL,
          event_id        uuid NOT NULL,
          event_type      text NOT NULL,
          payload         jsonb NOT NULL,
          occurred_at     timestamptz NOT NULL,
          causation_id    uuid,
          correlation_id  text NOT NULL,
          published_at    timestamptz,
          PRIMARY KEY (instrument_id, board, engine_seq)
        )`.execute(db);
      await sql`CREATE INDEX engine_output_pending_idx ON engine_output (seq) WHERE published_at IS NULL`.execute(
        db,
      );

      // RN-REC-001. O jsonb grande já sai comprimido pelo TOAST (D12).
      await sql`
        CREATE TABLE engine_snapshot (
          instrument_id  text NOT NULL,
          input_seq      bigint NOT NULL,
          state          jsonb NOT NULL,
          taken_at       timestamptz NOT NULL,
          PRIMARY KEY (instrument_id, input_seq)
        )`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      for (const table of [
        'engine_snapshot',
        'engine_output',
        'engine_journal',
        'engine_instrument',
      ])
        await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
    },
  },
};
