import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DatabaseConfig } from './config.js';
import { NumericPlugin, typeParsers } from './numeric.js';

/** Pool `pg` com as conversões de tipo do domínio (numeric → Decimal, int8 → bigint). */
export function createPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.maxConnections ?? 10,
    application_name: config.applicationName ?? config.user,
    types: typeParsers,
  });
}

/**
 * Cria a instância Kysely de um serviço (D4). `DB` é a interface das tabelas do serviço.
 * Aceita uma configuração (cria o pool) ou um pool existente.
 */
export function createDatabase<DB>(source: DatabaseConfig | pg.Pool): Kysely<DB> {
  const pool = source instanceof pg.Pool ? source : createPool(source);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [new NumericPlugin()] });
}
