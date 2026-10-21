import { Instant } from '@broker/domain-kernel';
import { VirtualClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import {
  baseMigrations,
  createDatabase,
  migrateToLatest,
  type DatabaseConfig,
} from '@broker/persistence';
import type { Kysely } from 'kysely';
import { inject } from 'vitest';

export function pgConfig(service: string, kind: 'app' | 'migrator'): DatabaseConfig {
  const { postgres } = inject('broker');
  const user = `${service}_${kind}`;
  return {
    host: postgres.host,
    port: postgres.port,
    database: service,
    user,
    password: postgres.passwords[user]!,
  };
}

/** Database do serviço com as migrações-base aplicadas; devolve a conexão da aplicação. */
export async function serviceDb(service: string): Promise<Kysely<unknown>> {
  const migrator = createDatabase(pgConfig(service, 'migrator'));
  await migrateToLatest(migrator, baseMigrations);
  await migrator.destroy();
  return createDatabase(pgConfig(service, 'app'));
}

export const clock = () => new VirtualClock(Instant.parse('2026-10-16T13:00:00Z'));
export const newId = () => uuidv7();
export const actor = { type: 'USER' as const, id: 'user-1' };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitUntil(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  what = 'condição',
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`tempo esgotado esperando ${what}`);
    await sleep(50);
  }
}
