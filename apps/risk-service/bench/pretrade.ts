// Carga do pré-trade (RNF-003): `pnpm --filter @broker/risk-service bench [ordens] [simultâneas]`.
// Sobe um PostgreSQL real e mede `POST /v1/internal/risk/pre-trade` dentro do serviço, por HTTP local
// com o hold gravado antes da resposta. Sem o barramento: o relay roda à parte e não pesa na resposta.
import { VirtualClock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest } from '@broker/persistence';
import { Authenticator, createLogger } from '@broker/service-kit';
import { databaseConfig, startPostgres } from '@broker/testing/containers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { createRiskService } from '../src/app.js';
import { migrations } from '../src/migrations.js';

const ORDERS = Number(process.argv[2] ?? 20_000);
const CONCURRENCY = Number(process.argv[3] ?? 32);
const ACCOUNTS = 500;
const WARMUP = Math.min(2_000, Math.floor(ORDERS / 5));

const pg = await startPostgres(['risk']);
const owner = createDatabase(databaseConfig(pg, 'risk', 'migrator'));
await migrateToLatest(owner, migrations);
await owner.destroy();
const database = databaseConfig(pg, 'risk', 'app');
const db = createDatabase(database);

const clock = new VirtualClock(Instant.parse('2026-03-03T13:00:00Z'));
const logger = createLogger({
  service: 'risk-service',
  environment: 'bench',
  version: '0',
  level: 'fatal',
  clock,
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const pair = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
const now = Math.floor(clock.now().epochMillis / 1000);
const token = await new SignJWT({ realm: 'services', scope: 'risk:pretrade' })
  .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
  .setSubject('oms-service')
  .setIssuer('bench')
  .setAudience('bench')
  .setIssuedAt(now)
  .setExpirationTime(now + 3600)
  .sign(pair.privateKey);

const app = await createRiskService({
  config: {
    SERVICE_NAME: 'risk-service',
    SERVICE_VERSION: '0',
    GIT_COMMIT: 'x',
    ENVIRONMENT: 'bench',
    PORT: 0,
    LOG_LEVEL: 'fatal',
    SHUTDOWN_TIMEOUT_MS: 0,
  },
  db,
  database,
  logger,
  clock,
  newId: uuidv7,
  authenticator: new Authenticator({
    jwks: createLocalJWKSet({ keys: [jwk] }),
    issuer: 'bench',
    audience: 'bench',
    clock,
  }),
  loopIntervalMs: 3_600_000,
  leaderHeartbeatMs: 100,
});
await app.start();
while (!app.isReady()) await new Promise((r) => setTimeout(r, 20));

// Saldo farto: toda ordem passa pelo caminho inteiro, até gravar o hold.
const accounts = Array.from({ length: ACCOUNTS }, () => uuidv7());
for (const accountId of accounts) {
  await app.store.transaction(async (tx) => {
    await app.projector.onAccountStatus(tx, accountId, 'ACTIVE');
    await app.projector.onBalanceChanged(tx, {
      accountId,
      settled: '100000000.00',
      projected: { d0: '100000000.00', d1: '100000000.00', d2: '100000000.00' },
      lastSequence: 1,
    });
  });
}
const instrumentId = uuidv7();
const server = app.service.app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/internal/risk/pre-trade`;

const latencies: number[] = [];
let sent = 0;
let refused = 0;

const worker = async () => {
  while (sent < ORDERS) {
    const i = sent++;
    const accountId = accounts[i % ACCOUNTS]!;
    const orderId = uuidv7();
    const started = performance.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        requestId: `${orderId}:1`,
        accountId,
        orderId,
        instrumentId,
        board: 'MAIN',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 100,
        referencePrice: '38.45',
        timeInForce: 'DAY',
        tradeIntent: 'NORMAL',
        operation: 'NEW',
      }),
    });
    const body = (await res.json()) as { decision?: string };
    if (i >= WARMUP) latencies.push(performance.now() - started);
    // O limite de ordens abertas também é o caminho inteiro, só sem o hold; a conta é para saber.
    if (body.decision !== 'APPROVED') refused++;
    // Mantém a conta abaixo do limite (RN-RSK §10), como se a ordem tivesse terminado.
    if (body.decision === 'APPROVED') app.memory.account(accountId).openOrders.delete(orderId);
  }
};

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - started) / 1000;

latencies.sort((a, b) => a - b);
const at = (q: number) => latencies[Math.floor(latencies.length * q)]!.toFixed(2);
console.log(
  JSON.stringify(
    {
      ordens: ORDERS,
      simultaneas: CONCURRENCY,
      contas: ACCOUNTS,
      recusadas: refused,
      porSegundo: Math.round(ORDERS / seconds),
      p50ms: at(0.5),
      p95ms: at(0.95),
      p99ms: at(0.99),
      p999ms: at(0.999),
    },
    null,
    2,
  ),
);

server.close();
await app.stop();
await db.destroy();
await pg.container.stop();
