import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import type { VirtualClock } from '@broker/clock';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest, type DatabaseConfig } from '@broker/persistence';
import { Authenticator, createLogger } from '@broker/service-kit';
import { testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { Writable } from 'node:stream';
import request from 'supertest';
import { createSessionService, type SessionServiceDeps } from '../src/app.js';
import { migrations } from '../src/migrations.js';

export const ISSUER = 'https://auth.broker.test';
export const AUDIENCE = 'broker-api';
export const DAY = '2026-03-03'; // terça-feira, dia útil

export const brt = (date: string, hhmm: string) => BusinessDate.parse(date).atLocalTime(hhmm);

export interface Env {
  pg: StartedPostgres;
  db: Kysely<unknown>;
  database: DatabaseConfig;
}

export async function startEnv(): Promise<Env> {
  const pg = await startPostgres(['trading_session']);
  const owner = createDatabase(databaseConfig(pg, 'trading_session', 'migrator'));
  await migrateToLatest(owner, migrations);
  await owner.destroy();
  const database = databaseConfig(pg, 'trading_session', 'app');
  return { pg, db: createDatabase(database), database };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  await env?.pg.container.stop();
}

/** Banco zerado entre testes (DELETE: o papel _app só tem DML; `phase_transition` é append-only e fica). */
export async function reset(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'closing_price',
    'auction',
    'instrument_phase_state',
    'halt',
    'circuit_breaker_event',
    'trading_day',
    'trading_rule_version',
    'session_routine',
    'session_alert',
    'session_change_request',
    'outbox_event',
    'processed_event',
    'consumer_offset',
    'calendar_replica',
  ]) {
    await sql`DELETE FROM ${sql.table(t)}`.execute(db);
  }
  await sql`
    UPDATE market_phase_state SET phase = 'CLOSED', scheduled_phase = 'CLOSED', since = 'epoch',
      expected_end_at = NULL, reason = 'INITIAL', business_date = NULL`.execute(db);
  await sql`
    UPDATE market_watch SET index_last = NULL, index_previous_close = NULL, index_quote_time = NULL,
      last_market_data_at = NULL, budget_level = 'NORMAL'`.execute(db);
}

const silent = () => new Writable({ write: (_c, _e, cb) => cb() });

let keyPair: { key: CryptoKey; jwk: JWK } | undefined;
async function signingKey() {
  if (!keyPair) {
    const pair = await generateKeyPair('ES256', { extractable: true });
    keyPair = {
      key: pair.privateKey,
      jwk: { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' },
    };
  }
  return keyPair;
}

const nowSec = (clock: VirtualClock) => Math.floor(clock.now().epochMillis / 1000);

export async function token(
  clock: VirtualClock,
  roles: string[],
  sub: string,
  realm = 'backoffice',
) {
  return new SignJWT({
    realm,
    roles,
    scope: realm,
    session_id: `s-${sub}`,
    amr: ['pwd', 'otp'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSec(clock))
    .setExpirationTime(nowSec(clock) + 1000 * 24 * 3600)
    .sign((await signingKey()).key);
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

export type App = Awaited<ReturnType<typeof app>>;

export async function app(
  env: Env,
  overrides: Partial<SessionServiceDeps> & { clock?: VirtualClock } = {},
) {
  const clock = overrides.clock ?? testClock({ date: DAY, time: '06:00' });
  const logger = createLogger({
    service: 'trading-session-service',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent(),
  });
  const jwks = createLocalJWKSet({ keys: [(await signingKey()).jwk] });
  const a = await createSessionService({
    config: {
      SERVICE_NAME: 'trading-session-service',
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
    clock,
    calendar: new TradingCalendar(b3Calendar2026To2027),
    newId: uuidv7,
    authenticator: new Authenticator({ jwks, issuer: ISSUER, audience: AUDIENCE, clock }),
    // Sem a vigilância do Market Data, salvo no teste dela: os demais não simulam cotações.
    params: { marketDataOutageMinutes: 0 },
    leaderHeartbeatMs: 200,
    ...overrides,
  });
  const http = request(a.service.app);
  const tokens = {
    market: await token(clock, ['BO_MARKET'], 'op-market'),
    market2: await token(clock, ['BO_MARKET'], 'op-market-2'),
    admin: await token(clock, ['BO_ADMIN'], 'op-admin'),
    customer: await token(clock, [], uuidv7(), 'customers'),
  };
  return { ...a, clock, http, tokens, db: env.db };
}

export interface OutboxRow {
  event_type: string;
  payload: Record<string, unknown>;
  partition_key: string;
}

export async function outbox(db: Kysely<unknown>, type?: string): Promise<OutboxRow[]> {
  const { rows } = await sql<OutboxRow>`
    SELECT event_type, payload, partition_key FROM outbox_event
    ${type ? sql`WHERE event_type = ${type}` : sql``} ORDER BY seq`.execute(db);
  return rows;
}

/** Instrumento negociável na cópia local, com o fechamento anterior já conhecido. */
export async function instrument(a: App, symbol: string, previousClose: string | null = '10.00') {
  const id = uuidv7();
  await a.store.transaction(async (tx) => {
    await tx.upsertInstrumentCopy({ id, symbol, tradable: true, status: 'ACTIVE' });
    if (!previousClose) return;
    const i = (await tx.instrument(id))!;
    const { Decimal } = await import('@broker/domain-kernel');
    i.previousClose = new Decimal(previousClose);
    i.bandReferencePrice = new Decimal(previousClose);
    await tx.saveInstrument(i);
  });
  return id;
}

/** Dispara a rotina como o consumidor de `routine.triggered`, com o relógio no horário dado. */
export async function routine(
  a: App,
  routineName: string,
  at: Instant | null,
  date = DAY,
  executionId = uuidv7(),
) {
  if (at) a.clock.advanceTo(at);
  await a.store.transaction((tx) =>
    a.session.onRoutine(tx, { routineName, businessDate: date, executionId }),
  );
  return executionId;
}

export const market = (a: App) => a.store.transaction((tx) => tx.market());
export const inst = (a: App, id: string) => a.store.transaction((tx) => tx.instrument(id));
export const liveAuctions = (a: App, id?: string) =>
  a.store.transaction((tx) => tx.liveAuctions(id));

export async function openDay(a: App, upTo: 'PRE_OPENING' | 'CONTINUOUS' | 'CLOSING_CALL') {
  await routine(a, 'calendar_check', brt(DAY, '07:00'));
  await routine(a, 'pre_trading', brt(DAY, '09:00'));
  await routine(a, 'pre_opening', brt(DAY, '09:45'));
  if (upTo === 'PRE_OPENING') return;
  await routine(a, 'continuous', brt(DAY, '10:00'));
  if (upTo === 'CONTINUOUS') return;
  await routine(a, 'closing_call', brt(DAY, '16:55'));
}
