import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import type { VirtualClock } from '@broker/clock';
import type { Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest, type DatabaseConfig } from '@broker/persistence';
import { Authenticator, createLogger } from '@broker/service-kit';
import { testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { Writable } from 'node:stream';
import request from 'supertest';
import {
  asResponse,
  fixtureFetch,
  loadFixture,
  type BrapiFixture,
} from '../src/adapters/brapi/fixtures.js';
import { BrapiProvider, type FetchLike } from '../src/adapters/brapi/provider.js';
import { StaticTokenSource } from '../src/adapters/brapi/tokens.js';
import { MemoryProviderCache } from '../src/adapters/cache.js';
import { MemoryRawStorage } from '../src/adapters/raw-storage.js';
import { createMarketDataService, type MarketDataServiceDeps } from '../src/app.js';
import type { ProviderAlert } from '../src/application/ports.js';
import { migrations } from '../src/migrations.js';

export const ISSUER = 'https://auth.broker.test';
export const AUDIENCE = 'broker-api';

export interface Env {
  pg: StartedPostgres;
  db: Kysely<unknown>;
  database: DatabaseConfig;
}

export async function startEnv(): Promise<Env> {
  const pg = await startPostgres(['market_data']);
  const owner = createDatabase(databaseConfig(pg, 'market_data', 'migrator'));
  await migrateToLatest(owner, migrations);
  await owner.destroy();
  const database = databaseConfig(pg, 'market_data', 'app');
  return { pg, db: createDatabase(database), database };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  await env?.pg.container.stop();
}

const RESET_TABLES = [
  'instrument_ref',
  'catalog_entry',
  'symbol_rename_seen',
  'external_quote',
  'quote_quarantine',
  'quote_schedule',
  'external_daily_candle',
  'history_fetch',
  'provider_capability',
  'provider_alert',
  'provider_job',
  'provider_job_run',
  'reference_price_state',
  'reference_override',
  'reference_noise',
  'outbox_event',
];

/**
 * Limpa o estado entre testes (o banco é o mesmo contêiner). `external_quote_history` é
 * append-only: cada teste usa os próprios tickers.
 */
export async function reset(db: Kysely<unknown>): Promise<void> {
  for (const t of RESET_TABLES) await sql`DELETE FROM ${sql.table(t)}`.execute(db);
  await sql`UPDATE provider_usage SET usage = NULL, usage_read_at = NULL, sent_since_usage = 0,
    quota_exhausted = false, level = 'NORMAL', auth_blocked_token = NULL`.execute(db);
}

/**
 * `fetch` programável: as fixtures por padrão, com respostas trocadas por caminho+query. Guarda as
 * URLs e os cabeçalhos pedidos.
 */
export class ScriptedFetch {
  readonly calls: { url: string; headers: Record<string, string> }[] = [];
  private readonly overrides = new Map<string, BrapiFixture | (() => BrapiFixture)>();
  private readonly fallback = fixtureFetch();

  set(pathAndQuery: string, f: BrapiFixture | (() => BrapiFixture)): void {
    this.overrides.set(pathAndQuery, f);
  }

  readonly fetch: FetchLike = async (url, init) => {
    this.calls.push({ url, headers: init.headers });
    const u = new URL(url);
    const key = `${u.pathname.replace(/^\/api/, '')}${u.search ? decodeURIComponent(u.search) : ''}`;
    const hit = this.overrides.get(key);
    if (hit) return asResponse(typeof hit === 'function' ? hit() : hit);
    return this.fallback(url, init);
  };

  quoteCalls(symbol?: string): number {
    return this.calls.filter(
      (c) =>
        c.url.includes('/stocks/quote') &&
        (!symbol || c.url.includes(`symbols=${encodeURIComponent(symbol)}`)),
    ).length;
  }
}

/** Fixture de cotação com preço e horário escolhidos (formato real de PETR4). */
export function quoteFixture(symbol: string, price: number, quoteTime: Instant): BrapiFixture {
  const f = structuredClone(loadFixture('quote-petr4'));
  const body = f.response.body as {
    results: { requestedSymbol: string; symbol: string; data: Record<string, unknown> }[];
  };
  const r = body.results[0]!;
  r.requestedSymbol = symbol;
  r.symbol = symbol;
  Object.assign(r.data, {
    shortName: symbol,
    regularMarketPrice: price,
    regularMarketTime: quoteTime.toString(),
    regularMarketDayHigh: price,
    regularMarketDayLow: price,
    regularMarketPreviousClose: price,
    regularMarketChange: 0,
    regularMarketChangePercent: 0,
  });
  f.request = { path: '/v2/stocks/quote', query: { symbols: symbol } };
  return f;
}

/** Saída do log em memória (para conferir o que foi escrito). */
export function logSink() {
  const lines: string[] = [];
  const destination = new Writable({
    write: (chunk, _e, cb) => {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, destination };
}

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

export interface AppOptions extends Partial<MarketDataServiceDeps> {
  clock?: VirtualClock;
  /** A brapi real (com cota e token) ou as fixtures (sem cota). */
  metered?: boolean;
  tokens?: string[];
  logLevel?: 'fatal' | 'info';
}

export async function app(env: Env, o: AppOptions = {}) {
  const clock = o.clock ?? testClock('2026-10-27T14:00:00Z');
  const sink = logSink();
  const logger = createLogger({
    service: 'market-data-service',
    environment: 'test',
    version: '0',
    level: o.logLevel ?? 'fatal',
    clock,
    destination: sink.destination,
  });
  const jwks = createLocalJWKSet({ keys: [(await signingKey()).jwk] });
  const fetch = new ScriptedFetch();
  const alerts: ProviderAlert[] = [];
  const raw = new MemoryRawStorage();
  const leader = { leader: true, isLeader: () => leader.leader };
  const brapi = new BrapiProvider({
    baseUrl: 'https://brapi.dev/api',
    tokens: new StaticTokenSource(o.tokens ?? (o.metered ? ['token-de-teste'] : [])),
    tokenlessSymbols: ['PETR4', 'MGLU3', 'VALE3', 'ITUB4'],
    capabilities: {
      symbolsPerRequest: 1,
      maxHistoryRange: '3mo',
      allowedIntervals: ['1d'],
      dividends: false,
      metered: o.metered ?? false,
    },
    clock,
    logger,
    fetch: fetch.fetch,
    name: o.metered ? 'brapi' : 'fixture',
  });
  const calendar = new TradingCalendar(b3Calendar2026To2027);
  let seq = 0;
  const a = await createMarketDataService({
    config: {
      SERVICE_NAME: 'market-data-service',
      SERVICE_VERSION: '0',
      GIT_COMMIT: 'x',
      ENVIRONMENT: 'test',
      PORT: 0,
      LOG_LEVEL: 'fatal',
      SHUTDOWN_TIMEOUT_MS: 0,
    },
    db: env.db,
    database: env.database,
    clock,
    calendar,
    logger,
    newId: uuidv7,
    authenticator: new Authenticator({ jwks, issuer: ISSUER, audience: AUDIENCE, clock }),
    provider: brapi,
    cache: new MemoryProviderCache(() => clock.now()),
    raw,
    queue: { minIntervalMs: 0, breaker: { failureThreshold: 5, openMs: 120_000 } },
    leader,
    tokenFingerprint: () => brapi.tokenFingerprint(),
    // Folga fixa: 0,5 → 120 s.
    random: () => 0.5,
    onAlert: (alert) => alerts.push(alert),
    workerIntervalMs: 3_600_000,
    ...o,
  });
  a.budget.setTokenFingerprint(await brapi.tokenFingerprint());
  const http = request(a.service.app);
  const tokens = {
    market: await backofficeToken(clock, ['BO_MARKET'], 'op-market'),
    customer: await customerToken(clock, uuidv7()),
  };
  return {
    ...a,
    clock,
    calendar,
    http,
    fetch,
    alerts,
    raw,
    leader,
    log: sink.lines,
    tokens,
    brapi,
    nextSeq: () => ++seq,
  };
}

/** Instrumento como chega pelo `instrument.created` do reference-data. */
export async function instrument(
  a: App,
  symbol: string,
  over: { tradable?: boolean; status?: string; instrumentId?: string } = {},
): Promise<string> {
  const id = over.instrumentId ?? uuidv7();
  await a.store.transaction((tx) =>
    a.instruments.onState(tx, {
      instrumentId: id,
      symbol,
      tickSize: '0.01',
      tradable: over.tradable ?? true,
      status: over.status ?? 'ACTIVE',
    }),
  );
  return id;
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
  return new SignJWT({
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
    .setExpirationTime(nowSec(clock) + 1000 * 24 * 3600)
    .sign((await signingKey()).key);
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

export async function history(db: Kysely<unknown>, symbol: string) {
  const { rows } = await sql<{ disposition: string; raw_sha256: string; provider: string }>`
    SELECT disposition, raw_sha256, provider FROM external_quote_history WHERE symbol = ${symbol}
    ORDER BY fetched_at, id`.execute(db);
  return rows;
}
