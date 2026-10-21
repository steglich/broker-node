import { VirtualClock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import {
  baseMigrations,
  createDatabase,
  migrateToLatest,
  type DatabaseConfig,
} from '@broker/persistence';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { Writable } from 'node:stream';
import { inject } from 'vitest';
import { createLogger, createService, type BaseConfig, type ServiceOptions } from '../src/index.js';

export function pgConfig(service: string, kind: 'app' | 'migrator'): DatabaseConfig {
  const { postgres } = inject('kit');
  const user = `${service}_${kind}`;
  return {
    host: postgres.host,
    port: postgres.port,
    database: service,
    user,
    password: postgres.passwords[user]!,
  };
}

export async function serviceDb(
  service: string,
  extra: Record<string, Migration> = {},
): Promise<Kysely<unknown>> {
  const migrator = createDatabase(pgConfig(service, 'migrator'));
  await migrateToLatest(migrator, { ...baseMigrations, ...extra });
  await migrator.destroy();
  return createDatabase(pgConfig(service, 'app'));
}

export const config = (overrides: Partial<BaseConfig> = {}): BaseConfig => ({
  SERVICE_NAME: 'test-service',
  SERVICE_VERSION: '1.2.3',
  GIT_COMMIT: 'abc1234',
  ENVIRONMENT: 'prod',
  PORT: 8080,
  LOG_LEVEL: 'info',
  SHUTDOWN_TIMEOUT_MS: 2000,
  ...overrides,
});

/** Logger que grava em memória: cada linha JSON vira um objeto em `lines`. */
export function memoryLogger(clock = new VirtualClock(Instant.parse('2027-01-04T13:00:00Z'))) {
  const lines: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const l of chunk.toString().split('\n').filter(Boolean))
        lines.push(JSON.parse(l) as Record<string, unknown>);
      cb();
    },
  });
  const logger = createLogger({
    service: 'test-service',
    environment: 'prod',
    version: '1.2.3',
    clock,
    destination,
  });
  return { logger, lines, clock };
}

export function testService(options: Partial<ServiceOptions> = {}) {
  const { logger, lines, clock } = memoryLogger();
  const service = createService({ config: config(), clock, logger, ...options });
  return { service, lines, clock };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
