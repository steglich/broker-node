import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest, type DatabaseConfig } from '@broker/persistence';
import { createLogger } from '@broker/service-kit';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { sql, type Kysely } from 'kysely';
import { Writable } from 'node:stream';
import { createSchedulerService, type SchedulerServiceDeps } from '../src/app.js';
import { migrations } from '../src/migrations.js';

export const calendar = new TradingCalendar(b3Calendar2026To2027);
export const brt = (date: string, hhmm: string) => BusinessDate.parse(date).atLocalTime(hhmm);

export interface Env {
  pg: StartedPostgres;
  db: Kysely<unknown>;
  database: DatabaseConfig;
}

export async function startDb(): Promise<Env> {
  const pg = await startPostgres(['scheduler']);
  const migrator = createDatabase(databaseConfig(pg, 'scheduler', 'migrator'));
  await migrateToLatest(migrator, migrations);
  await migrator.destroy();
  const database = databaseConfig(pg, 'scheduler', 'app');
  return { pg, db: createDatabase(database), database };
}

/** Banco zerado entre testes (DELETE: o papel _app só tem DML). */
export async function reset(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'routine_execution',
    'clock_state',
    'outbox_event',
    'processed_event',
    'consumer_offset',
  ]) {
    await sql`DELETE FROM ${sql.table(t)}`.execute(db);
  }
  await sql`UPDATE scheduler_state SET cursor = NULL`.execute(db);
  await sql`DELETE FROM routine_definition WHERE name LIKE 'test_%'`.execute(db);
  await sql`UPDATE routine_definition SET enabled = true`.execute(db);
}

const silent = () => new Writable({ write: (_c, _e, cb) => cb() });

export async function app(env: Env, overrides: Partial<SchedulerServiceDeps> = {}) {
  const logger = createLogger({
    service: 'scheduler-service',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock: {
      mode: 'VIRTUAL',
      now: () => Instant.parse('2026-01-01T00:00:00Z'),
      businessDate: () => BusinessDate.parse('2026-01-01'),
    },
    destination: silent(),
  });
  return createSchedulerService({
    config: {
      SERVICE_NAME: 'scheduler-service',
      SERVICE_VERSION: '0',
      GIT_COMMIT: 'x',
      ENVIRONMENT: 'test',
      PORT: 0,
      LOG_LEVEL: 'fatal',
      SHUTDOWN_TIMEOUT_MS: 0,
    },
    db: env.db,
    database: env.database,
    logger,
    calendar,
    newId: uuidv7,
    clock: { mode: 'VIRTUAL', start: brt('2026-03-03', '06:00') },
    adminApi: true,
    leaderHeartbeatMs: 200,
    ...overrides,
  });
}

/** `routine.triggered` gravados na outbox, em ordem de gravação. */
export async function triggered(db: Kysely<unknown>) {
  const { rows } = await sql<{
    payload: {
      routineName: string;
      businessDate: string;
      executionId: string;
      attempt: number;
      catchUp: boolean;
    };
  }>`
    SELECT payload FROM outbox_event WHERE event_type = 'routine.triggered' ORDER BY seq`.execute(
    db,
  );
  return rows.map((r) => r.payload);
}

export async function ticks(db: Kysely<unknown>) {
  const { rows } = await sql<{
    payload: { virtualNow: string; mode: string; speedFactor: number };
  }>`
    SELECT payload FROM outbox_event WHERE event_type = 'clock.ticked' ORDER BY seq`.execute(db);
  return rows.map((r) => r.payload);
}

/** O papel de cada serviço dono: conclui tudo o que está disparado. */
export async function completeAll(
  scheduler: Awaited<ReturnType<typeof app>>['scheduler'],
  db: Kysely<unknown>,
) {
  const { rows } = await sql<{ routine_name: string; business_date: string; execution_id: string }>`
    SELECT routine_name, business_date::text AS business_date, execution_id FROM routine_execution WHERE status = 'TRIGGERED'`.execute(
    db,
  );
  for (const r of rows) {
    await scheduler.finish({
      routineName: r.routine_name,
      businessDate: r.business_date,
      executionId: r.execution_id,
      status: 'COMPLETED',
    });
  }
  return rows.length;
}

export const waitUntil = async (
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  what = 'condição',
) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`tempo esgotado esperando ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
