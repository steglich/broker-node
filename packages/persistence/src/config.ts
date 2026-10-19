import { readFileSync } from 'node:fs';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Conexões máximas do pool (padrão 10). */
  maxConnections?: number;
  applicationName?: string;
}

/**
 * Lê a configuração do banco do ambiente: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e a senha em
 * `DB_PASSWORD_FILE` (Docker secret, D18) ou, só em desenvolvimento, `DB_PASSWORD`.
 */
export function databaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`variável de ambiente ausente: ${name}`);
    return value;
  };
  const passwordFile = env['DB_PASSWORD_FILE'];
  const password = passwordFile
    ? readFileSync(passwordFile, 'utf8').trim()
    : required('DB_PASSWORD');
  return {
    host: required('DB_HOST'),
    port: Number(env['DB_PORT'] ?? 5432),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password,
    ...(env['DB_POOL_MAX'] ? { maxConnections: Number(env['DB_POOL_MAX']) } : {}),
    ...(env['SERVICE_NAME'] ? { applicationName: env['SERVICE_NAME'] } : {}),
  };
}
