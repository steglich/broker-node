import { sql, type Kysely } from 'kysely';

/**
 * Torna uma tabela append-only (RN-DB §3: `ledger_entry`, `journal`, `order_event`...), com duas
 * barreiras independentes:
 *
 * 1. Permissão: o usuário da aplicação (`<svc>_app`) perde UPDATE, DELETE e TRUNCATE na tabela.
 * 2. Gatilho: qualquer UPDATE, DELETE ou TRUNCATE é recusado por `forbid_mutation()`, inclusive
 *    pelo dono da tabela (o migrador). Isso pega o erro mesmo se alguém der GRANT por engano.
 *
 * Chame dentro de uma migração, depois do CREATE TABLE. Sem `appRole`, o usuário da aplicação é
 * deduzido do usuário de migração: `ledger_migrator` → `ledger_app` (padrão do init do Postgres).
 * Depende da função `forbid_mutation()`, criada pelas migrações-base.
 */
export async function makeAppendOnly(
  db: Kysely<unknown>,
  table: string,
  appRole?: string,
): Promise<void> {
  const role =
    appRole ??
    (
      await sql<{
        role: string;
      }>`SELECT replace(current_user, '_migrator', '_app') AS role`.execute(db)
    ).rows[0]!.role;
  const roleExists = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`.execute(db);
  if (roleExists.rows.length === 0) throw new Error(`papel da aplicação não existe: ${role}`);

  await sql`REVOKE UPDATE, DELETE, TRUNCATE ON ${sql.table(table)} FROM ${sql.id(role)}`.execute(
    db,
  );
  await sql`
    CREATE TRIGGER ${sql.id(`${table}_append_only`)}
    BEFORE UPDATE OR DELETE ON ${sql.table(table)}
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`.execute(db);
  await sql`
    CREATE TRIGGER ${sql.id(`${table}_append_only_truncate`)}
    BEFORE TRUNCATE ON ${sql.table(table)}
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`.execute(db);
}
