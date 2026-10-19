// One-shot de migração: roda com <svc>_migrator e termina. O serviço só sobe depois dele.
import { baseMigrations, runMigrationsFromEnv } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';

process.exitCode = await runMigrationsFromEnv({
  ...baseMigrations,
  '0001_migration_marker': {
    async up(db: Kysely<unknown>) {
      // IF NOT EXISTS: o volume local pode ter a tabela da versão anterior do exemplo.
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
});
