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
import { createSmmService, type SmmServiceDeps } from '../src/app.js';
import type { Phase } from '../src/domain/phases.js';
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
  const pg = await startPostgres(['market_maker']);
  const owner = createDatabase(databaseConfig(pg, 'market_maker', 'migrator'));
  await migrateToLatest(owner, migrations);
  await owner.destroy();
  const database = databaseConfig(pg, 'market_maker', 'app');
  return { pg, db: createDatabase(database), database };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  await env?.pg.container.stop();
}

/** Banco zerado entre testes (DELETE: o papel _app só tem DML). */
export async function reset(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'smm_state',
    'smm_parameters',
    'smm_book_level',
    'smm_fill',
    'smm_change_request',
    'outbox_event',
    'processed_event',
    'consumer_offset',
  ]) {
    await sql`DELETE FROM ${sql.table(t)}`.execute(db);
  }
  await sql`UPDATE smm_control SET market_phase = 'CLOSED', global_enabled = true`.execute(db);
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
  overrides: Partial<SmmServiceDeps> & { clock?: VirtualClock } = {},
) {
  const clock = overrides.clock ?? testClock({ date: DAY, time: '10:00' });
  const logger = createLogger({
    service: 'market-maker-service',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent(),
  });
  const jwks = createLocalJWKSet({ keys: [(await signingKey()).jwk] });
  const a = await createSmmService({
    config: {
      SERVICE_NAME: 'market-maker-service',
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
    newId: uuidv7,
    authenticator: new Authenticator({ jwks, issuer: ISSUER, audience: AUDIENCE, clock }),
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

export const clearOutbox = (db: Kysely<unknown>) => sql`DELETE FROM outbox_event`.execute(db);

export const inst = (a: App, id: string) =>
  a.store.transaction(async (tx) => (await tx.instrument(id))!);

/** Instrumento negociável com referência e, opcionalmente, já numa fase de mercado. */
export async function instrument(
  a: App,
  opts: { lotSize?: number; tick?: string; price?: string; phase?: Phase } = {},
) {
  const id = uuidv7();
  await a.store.transaction((tx) =>
    a.maker.onInstrumentState(tx, {
      instrumentId: id,
      symbol: 'PETR4',
      lotSize: opts.lotSize ?? 100,
      tickSize: opts.tick ?? '0.01',
      oddLotEnabled: true,
      tradable: true,
      status: 'ACTIVE',
    }),
  );
  await reference(a, id, opts.price ?? '38.5000', 1);
  if (opts.phase) await phase(a, 'MARKET', opts.phase);
  return id;
}

export const reference = (
  a: App,
  instrumentId: string,
  price: string,
  seq: number,
  externalQuoteTime: Instant | null = null,
) =>
  a.store.transaction((tx) =>
    a.maker.onReferencePrice(tx, { instrumentId, seq, price, externalQuoteTime }),
  );

export const phase = (a: App, scope: string, to: Phase) =>
  a.store.transaction((tx) => a.maker.onPhaseChanged(tx, { scope, to }));

/** Devolve os comandos de cancelar e criar publicados desde a última limpeza. */
export async function commands(db: Kysely<unknown>) {
  const rows = await outbox(db);
  return {
    newOrders: rows
      .filter((r) => r.event_type === 'engine.new_order')
      .map(
        (r) =>
          r.payload as {
            orderId: string;
            board: string;
            side: 'BUY' | 'SELL';
            quantity: number;
            limitPrice: string;
            timeInForce: string;
            participantType: string;
            accountId: string;
          },
      ),
    cancels: rows
      .filter((r) => r.event_type === 'engine.cancel_order')
      .map((r) => r.payload as { orderId: string }),
    order: rows.map((r) => r.event_type),
  };
}

/** O Motor confirma todas as ordens `SENT`, e as de cancelamento saem do livro. */
export async function engineAcks(a: App, instrumentId: string) {
  const state = await inst(a, instrumentId);
  for (const o of state.liveOrders) {
    await a.store.transaction((tx) =>
      o.status === 'CANCELING'
        ? a.maker.onOrderGone(tx, { instrumentId, orderId: o.orderId })
        : a.maker.onOrderBooked(tx, {
            instrumentId,
            orderId: o.orderId,
            remainingQuantity: o.remaining,
          }),
    );
  }
}

let engineSeq = 0;

/** Negócio contra um cliente, como o Motor o publicaria. */
export async function trade(
  a: App,
  input: {
    instrumentId: string;
    orderId: string;
    side: 'BUY' | 'SELL';
    price: string;
    quantity: number;
    tradeId?: string;
  },
) {
  const tradeId = input.tradeId ?? uuidv7();
  const client = uuidv7();
  const buying = input.side === 'BUY';
  await a.store.transaction((tx) =>
    a.maker.onTradeExecuted(tx, {
      instrumentId: input.instrumentId,
      engineSeq: ++engineSeq,
      tradeId,
      price: input.price,
      quantity: input.quantity,
      buyOrderId: buying ? input.orderId : uuidv7(),
      sellOrderId: buying ? uuidv7() : input.orderId,
      buyAccountId: buying ? a.accountId : client,
      sellAccountId: buying ? client : a.accountId,
      buyParticipantType: buying ? 'MARKET_MAKER' : 'CUSTOMER',
      sellParticipantType: buying ? 'CUSTOMER' : 'MARKET_MAKER',
      executedAt: a.clock.now().toString(),
    }),
  );
  return tradeId;
}

export const plusMinutes = (t: Instant, minutes: number) => t.plusMillis(minutes * 60_000);
