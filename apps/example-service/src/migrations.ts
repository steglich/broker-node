import { baseMigrations } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Migrações do serviço: as da plataforma mais as próprias (D4). */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  '0001_migration_marker': {
    async up(db: Kysely<unknown>) {
      // IF NOT EXISTS: o volume local pode ter a tabela da primeira versão do exemplo.
      await sql`
        CREATE TABLE IF NOT EXISTS migration_marker (
          id integer PRIMARY KEY,
          migrated_at timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
      await sql`INSERT INTO migration_marker (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET migrated_at = now()`.execute(
        db,
      );
    },
  },
  '0002_ping': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE ping (
          id            uuid PRIMARY KEY,
          created_at    timestamptz NOT NULL,
          processed_at  timestamptz
        )`.execute(db);
    },
  },
};
