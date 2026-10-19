import { inject } from 'vitest';
import type { DatabaseConfig } from '../src/index.js';

/** Configuração de conexão para um usuário (`<svc>_app` ou `<svc>_migrator`) no database `<svc>`. */
export function configFor(
  service: string,
  kind: 'app' | 'migrator',
  database = service,
): DatabaseConfig {
  const pg = inject('postgres');
  const user = `${service}_${kind}`;
  return { host: pg.host, port: pg.port, database, user, password: pg.passwords[user]! };
}

/** Conexão como superusuário, para simular falhas (não é usada pelo código de produção). */
export function superuserConfig(database: string): DatabaseConfig {
  const pg = inject('postgres');
  return { host: pg.host, port: pg.port, database, ...pg.superuser };
}
