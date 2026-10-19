import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationResultSet } from 'kysely/migration';
import { databaseConfigFromEnv } from './config.js';
import { createDatabase } from './database.js';

/** Tabela de controle de migrações (RN-DB §4: `schema_migration`). */
export const MIGRATION_TABLE = 'schema_migration';

/**
 * Aplica as migrações pendentes, em ordem alfabética do nome (use prefixo numérico: `0001_...`).
 * Migrações versionadas e sequenciais (RN-DB-020), aplicadas por um único processo por vez
 * (o Kysely trava a tabela `schema_migration_lock`).
 */
export async function migrateToLatest(
  db: Kysely<unknown>,
  migrations: Record<string, Migration>,
): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: `${MIGRATION_TABLE}_lock`,
  });
  const result = await migrator.migrateToLatest();
  if (result.error) throw result.error;
  return result;
}

/**
 * Ponto de entrada do contêiner one-shot de migração (D4, D22): conecta com o usuário
 * `<svc>_migrator` (variáveis `DB_*`), aplica as migrações, informa o resultado e devolve o
 * código de saída. O serviço só sobe depois que este processo termina com 0.
 */
export async function runMigrationsFromEnv(
  migrations: Record<string, Migration>,
  log: (line: string) => void = console.log,
): Promise<number> {
  const db = createDatabase<unknown>(databaseConfigFromEnv());
  try {
    const { results = [] } = await migrateToLatest(db, migrations);
    for (const r of results) log(`migração ${r.migrationName}: ${r.status}`);
    if (results.length === 0) log('nenhuma migração pendente');
    return 0;
  } catch (err) {
    log(`falha na migração: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await db.destroy();
  }
}
