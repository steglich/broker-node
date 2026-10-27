import type { VirtualClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest, type DatabaseConfig } from '@broker/persistence';
import { Authenticator, createLogger } from '@broker/service-kit';
import { testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { Writable } from 'node:stream';
import request from 'supertest';
import { createReferenceDataService, type ReferenceServiceDeps } from '../src/app.js';
import type { BackofficeAlert, OpenOrdersPort } from '../src/application/ports.js';
import { migrations } from '../src/migrations.js';

export const ISSUER = 'https://auth.broker.test';
export const AUDIENCE = 'broker-api';

export interface Env {
  pg: StartedPostgres;
  db: Kysely<unknown>;
  database: DatabaseConfig;
}

export async function startEnv(): Promise<Env> {
  const pg = await startPostgres(['reference_data']);
  const owner = createDatabase(databaseConfig(pg, 'reference_data', 'migrator'));
  await migrateToLatest(owner, migrations);
  await owner.destroy();
  const database = databaseConfig(pg, 'reference_data', 'app');
  return { pg, db: createDatabase(database), database };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  await env?.pg.container.stop();
}

/** OMS falso: ordens abertas por instrumento (RN-INS-013). */
export class FakeOrders implements OpenOrdersPort {
  open = new Map<string, number>();
  async openOrdersCount(instrumentId: string) {
    return this.open.get(instrumentId) ?? 0;
  }
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

export type App = Awaited<ReturnType<typeof app>>;

export async function app(
  env: Env,
  overrides: Partial<ReferenceServiceDeps> & { clock?: VirtualClock } = {},
) {
  const clock = overrides.clock ?? testClock();
  const logger = createLogger({
    service: 'reference-data-service',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent(),
  });
  const jwks = createLocalJWKSet({ keys: [(await signingKey()).jwk] });
  const orders = new FakeOrders();
  const alerts: BackofficeAlert[] = [];
  const a = await createReferenceDataService({
    config: {
      SERVICE_NAME: 'reference-data-service',
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
    maxTradableInstruments: 20,
    maxQuoteStalenessDays: 2,
    requestTtlHours: 24,
    allDaysBusiness: false,
    openOrders: orders,
    authenticator: new Authenticator({ jwks, issuer: ISSUER, audience: AUDIENCE, clock }),
    onAlert: (alert) => alerts.push(alert),
    ...overrides,
  });
  const http = request(a.service.app);
  const tokens = {
    market: await backofficeToken(clock, ['BO_MARKET'], 'op-market'),
    market2: await backofficeToken(clock, ['BO_MARKET'], 'op-market-2'),
    admin: await backofficeToken(clock, ['BO_ADMIN'], 'op-admin'),
    support: await backofficeToken(clock, ['BO_SUPPORT'], 'op-support'),
    customer: await customerToken(clock, uuidv7()),
  };
  return { ...a, clock, http, orders, alerts, tokens };
}

const nowSec = (clock: VirtualClock) => Math.floor(clock.now().epochMillis / 1000);

export async function customerToken(clock: VirtualClock, userId: string) {
  return new SignJWT({
    realm: 'customers',
    roles: [],
    scope: 'profile:read',
    session_id: `s-${userId}`,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSec(clock))
    .setExpirationTime(nowSec(clock) + 1000 * 24 * 3600)
    .setJti(uuidv7())
    .sign((await signingKey()).key);
}

export async function backofficeToken(clock: VirtualClock, roles: string[], sub: string) {
  return (
    new SignJWT({
      realm: 'backoffice',
      roles,
      scope: 'backoffice',
      session_id: `s-${sub}`,
      amr: ['pwd', 'otp'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSec(clock))
      // Longo: os testes avançam o relógio virtual por dias.
      .setExpirationTime(nowSec(clock) + 1000 * 24 * 3600)
      .sign((await signingKey()).key)
  );
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function outbox(db: Kysely<unknown>, type?: string) {
  const { rows } = await sql<{
    event_type: string;
    payload: Record<string, unknown>;
    partition_key: string;
  }>`
    SELECT event_type, payload, partition_key FROM outbox_event
    ${type ? sql`WHERE event_type = ${type}` : sql``} ORDER BY seq`.execute(db);
  return rows;
}

/** Catálogo da brapi como o consumidor de `market_data.catalog_synced` recebe. */
export async function syncCatalog(
  a: App,
  newSymbols: {
    symbol: string;
    assetType?: 'STOCK' | 'UNIT' | 'REIT' | 'ETF' | 'BDR';
    shortName?: string;
  }[],
  inactiveSymbols: string[] = [],
) {
  return a.store.transaction((tx) =>
    a.instruments.onCatalogSynced(tx, {
      newSymbols,
      inactiveSymbols,
      syncedAt: a.clock.now().toString(),
    }),
  );
}

export async function idOf(a: App, symbol: string): Promise<string> {
  const res = await a.http
    .get(`/v1/instruments/by-symbol/${symbol}`)
    .set(bearer(a.tokens.market))
    .expect(200);
  return res.body.instrument.instrumentId as string;
}

/** Aprovação pelo checker (BO_ADMIN por padrão). */
export function approve(a: App, requestId: string, token = a.tokens.admin) {
  return a.http.post(`/v1/bo/change-requests/${requestId}/approve`).set(bearer(token));
}

export async function include(a: App, instrumentId: string) {
  const req = await a.http
    .post('/v1/bo/universe/requests')
    .set(bearer(a.tokens.market))
    .set('Idempotency-Key', uuidv7())
    .send({ instrumentId, action: 'INCLUDE', justification: 'entra no universo' });
  return req;
}
