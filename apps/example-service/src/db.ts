import { readFileSync } from 'node:fs';
import pg from 'pg';

/** Conecta com a credencial indicada pelo ambiente; a senha vem do Docker secret. */
export function connect(): pg.Client {
  const env = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`variável de ambiente ausente: ${name}`);
    return value;
  };
  return new pg.Client({
    host: env('DB_HOST'),
    port: Number(process.env['DB_PORT'] ?? 5432),
    database: env('DB_NAME'),
    user: env('DB_USER'),
    password: readFileSync(env('DB_PASSWORD_FILE'), 'utf8').trim(),
  });
}
