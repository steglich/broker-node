import type { VirtualClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest, type DatabaseConfig } from '@broker/persistence';
import { Authenticator, createLogger } from '@broker/service-kit';
import { testClock, waitUntil } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { Writable } from 'node:stream';
import request from 'supertest';
import { createRiskService, type RiskServiceDeps } from '../src/app.js';
import type { OrphanHoldAlert } from '../src/application/ports.js';
import { migrations } from '../src/migrations.js';

export const ISSUER = 'https://auth.broker.test';
export const AUDIENCE = 'broker-api';
export const DAY = '2026-03-03'; // terça-feira, dia útil

export interface Env {
  pg: StartedPostgres;
  db: Kysely<unknown>;
  database: DatabaseConfig;
}

export async function startEnv(): Promise<Env> {
  const pg = await startPostgres(['risk']);
  const owner = createDatabase(databaseConfig(pg, 'risk', 'migrator'));
  await migrateToLatest(owner, migrations);
  await owner.destroy();
  const database = databaseConfig(pg, 'risk', 'app');
  return { pg, db: createDatabase(database), database };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  await env?.pg.container.stop();
}

/** Banco zerado entre testes (DELETE: o papel _app só tem DML). */
export async function reset(db: Kysely<unknown>): Promise<void> {
  for (const t of [
    'account_risk_projection',
    'risk_position',
    'risk_trade',
    'hold',
    'hold_reference',
    'pretrade_decision',
    'risk_price',
    'outbox_event',
    'processed_event',
    'consumer_offset',
  ]) {
    await sql`DELETE FROM ${sql.table(t)}`.execute(db);
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

export async function serviceToken(clock: VirtualClock, scopes: string[]) {
  const now = Math.floor(clock.now().epochMillis / 1000);
  return new SignJWT({ realm: 'services', scope: scopes.join(' ') })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setSubject('oms-service')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 1000 * 24 * 3600)
    .sign((await signingKey()).key);
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

export type App = Awaited<ReturnType<typeof app>>;

/** Sobe o serviço; `start: false` deixa-o sem liderança, como uma réplica em espera. */
export async function app(
  env: Env,
  overrides: Partial<RiskServiceDeps> & { clock?: VirtualClock; start?: boolean } = {},
) {
  const { start = true, ...deps } = overrides;
  const clock = deps.clock ?? testClock({ date: DAY, time: '10:00' });
  const logger = createLogger({
    service: 'risk-service',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent(),
  });
  const jwks = createLocalJWKSet({ keys: [(await signingKey()).jwk] });
  const alerts: OrphanHoldAlert[] = [];
  const a = await createRiskService({
    config: {
      SERVICE_NAME: 'risk-service',
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
    leaderHeartbeatMs: 100,
    // Nos testes, o laço de fundo é chamado à mão.
    loopIntervalMs: 3_600_000,
    onAlert: (alert) => alerts.push(alert),
    ...deps,
  });
  if (start) {
    await a.start();
    await waitUntil(() => a.isReady());
  }
  const http = request(a.service.app);
  return {
    ...a,
    clock,
    http,
    alerts,
    db: env.db,
    tokens: {
      oms: await serviceToken(clock, ['risk:pretrade']),
      ledger: await serviceToken(clock, ['risk:holds']),
    },
  };
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

// ------------------------------------------------------------------ eventos dos outros serviços

let ledgerSeq = 1000;

/** Conta aberta e com saldo, como o ledger a publicaria. */
export async function funded(a: App, amount: string, accountId = uuidv7()) {
  await a.store.transaction((tx) => a.projector.onAccountStatus(tx, accountId, 'ACTIVE'));
  await balance(a, accountId, { all: amount });
  return accountId;
}

export const balance = (
  a: App,
  accountId: string,
  v: { all?: string; settled?: string; d0?: string; d1?: string; d2?: string; seq?: number },
) =>
  a.store.transaction((tx) =>
    a.projector.onBalanceChanged(tx, {
      accountId,
      settled: v.settled ?? v.all!,
      projected: { d0: v.d0 ?? v.all!, d1: v.d1 ?? v.all!, d2: v.d2 ?? v.all! },
      lastSequence: v.seq ?? ++ledgerSeq,
    }),
  );

const FMS = '00000000-0000-7000-8000-00000000f115';

/** Negócio do Motor contra o FMS: só a ponta do cliente passa pelo Risco. */
export async function trade(
  a: App,
  input: {
    accountId: string;
    orderId?: string;
    side: 'BUY' | 'SELL';
    instrumentId: string;
    price: string;
    quantity: number;
    tradeId?: string;
  },
) {
  const tradeId = input.tradeId ?? uuidv7();
  const buying = input.side === 'BUY';
  const orderId = input.orderId ?? uuidv7();
  await a.store.transaction((tx) =>
    a.projector.onTradeExecuted(tx, {
      instrumentId: input.instrumentId,
      tradeId,
      price: input.price,
      quantity: input.quantity,
      buyOrderId: buying ? orderId : uuidv7(),
      sellOrderId: buying ? uuidv7() : orderId,
      buyAccountId: buying ? input.accountId : FMS,
      sellAccountId: buying ? FMS : input.accountId,
      buyParticipantType: buying ? 'CUSTOMER' : 'MARKET_MAKER',
      sellParticipantType: buying ? 'MARKET_MAKER' : 'CUSTOMER',
      tradingDate: DAY,
    }),
  );
  return tradeId;
}

/** O lançamento do principal do negócio: `amount` com sinal (compra negativa). */
export const journal = (
  a: App,
  input: { accountId: string; tradeId: string; amount: string; type?: 'TRADE' | 'FEES' },
) => {
  const seq = ++ledgerSeq;
  return a.store
    .transaction((tx) =>
      a.projector.onJournalPosted(tx, {
        type: input.type ?? 'TRADE',
        referenceId: input.tradeId,
        bookingDate: DAY,
        entries: [
          {
            accountCode: 'CUST_CASH',
            ownerId: input.accountId,
            amount: input.amount,
            sequence: seq,
          },
          { accountCode: 'CLEARING_HOUSE', ownerId: null, amount: input.amount, sequence: seq },
        ],
      }),
    )
    .then(() => seq);
};

export const buy = (
  a: App,
  input: {
    accountId: string;
    orderId?: string;
    instrumentId?: string;
    quantity: number;
    price: string;
    requestId?: string;
    operation?: 'NEW' | 'REPLACE';
    tradeIntent?: 'NORMAL' | 'DAY_TRADE';
  },
) => order(a, { ...input, side: 'BUY' });

export const sell = (
  a: App,
  input: {
    accountId: string;
    orderId?: string;
    instrumentId: string;
    quantity: number;
    price: string;
  },
) => order(a, { ...input, side: 'SELL' });

function order(
  a: App,
  input: {
    accountId: string;
    side: 'BUY' | 'SELL';
    orderId?: string;
    instrumentId?: string;
    quantity: number;
    price: string;
    requestId?: string;
    operation?: 'NEW' | 'REPLACE';
    tradeIntent?: 'NORMAL' | 'DAY_TRADE';
  },
) {
  const orderId = input.orderId ?? uuidv7();
  return a.decisions.preTrade({
    requestId: input.requestId ?? uuidv7(),
    accountId: input.accountId,
    orderId,
    instrumentId: input.instrumentId ?? uuidv7(),
    side: input.side,
    quantity: input.quantity,
    referencePrice: input.price,
    tradeIntent: input.tradeIntent ?? 'NORMAL',
    operation: input.operation ?? 'NEW',
  });
}

export const stopAll = async (...apps: (App | undefined)[]) => {
  for (const x of apps) await x?.stop();
};
