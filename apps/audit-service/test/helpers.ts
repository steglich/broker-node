import {
  CreateBucketCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { VirtualClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest, type DatabaseConfig } from '@broker/persistence';
import { Authenticator, createLogger } from '@broker/service-kit';
import { testClock } from '@broker/testing';
import {
  databaseConfig,
  startMinio,
  startPostgres,
  type StartedMinio,
  type StartedPostgres,
} from '@broker/testing/containers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { Writable } from 'node:stream';
import { S3AnchorStorage } from '../src/adapters/s3-anchor-storage.js';
import { createAuditService, type AuditServiceDeps } from '../src/app.js';
import type { CapturedEvent } from '../src/domain/capture.js';
import { migrations } from '../src/migrations.js';

export const BUCKET = 'audit-anchors';

export interface Env {
  pg: StartedPostgres;
  minio: StartedMinio;
  db: Kysely<unknown>;
  /** Conexão de superusuário: faz o papel de quem mexe direto no banco. */
  superDb: Kysely<unknown>;
  database: DatabaseConfig;
  s3: S3Client;
}

export async function startEnv(): Promise<Env> {
  const [pg, minio] = await Promise.all([startPostgres(['audit']), startMinio()]);
  const migrator = createDatabase(databaseConfig(pg, 'audit', 'migrator'));
  await migrateToLatest(migrator, migrations);
  await migrator.destroy();
  const database = databaseConfig(pg, 'audit', 'app');
  const s3 = new S3Client({
    endpoint: minio.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });
  // Como o infra/minio/init.sh: bucket com object lock em modo COMPLIANCE (RN-AUD-002).
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET, ObjectLockEnabledForBucket: true }));
  await s3.send(
    new PutObjectLockConfigurationCommand({
      Bucket: BUCKET,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 1 } },
      },
    }),
  );
  return {
    pg,
    minio,
    db: createDatabase(database),
    superDb: createDatabase({
      host: pg.host,
      port: pg.port,
      database: 'audit',
      user: pg.superuser.user,
      password: pg.superuser.password,
    }),
    database,
    s3,
  };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  await env?.superDb.destroy();
  env?.s3.destroy();
  await Promise.all([env?.pg.container.stop(), env?.minio.container.stop()]);
}

/**
 * Zera a trilha entre testes. O papel _app não pode apagar (é justamente o que se testa): quem
 * limpa é o superusuário, com os gatilhos desligados nesta sessão.
 */
export async function reset(env: Env): Promise<void> {
  await env.superDb.connection().execute(async (c) => {
    await sql`SET session_replication_role = replica`.execute(c);
    await sql`TRUNCATE audit_record, audit_anchor, audit_verification, outbox_event, processed_event, consumer_offset`.execute(
      c,
    );
    await sql`SET session_replication_role = DEFAULT`.execute(c);
  });
}

/** Mexe direto no banco, passando por cima do gatilho append-only (o atacante com acesso ao banco). */
export async function tamper(env: Env, statement: ReturnType<typeof sql>): Promise<void> {
  await env.superDb.connection().execute(async (c) => {
    await sql`SET session_replication_role = replica`.execute(c);
    await statement.execute(c);
    await sql`SET session_replication_role = DEFAULT`.execute(c);
  });
}

const silent = () => new Writable({ write: (_c, _e, cb) => cb() });

export const ISSUER = 'https://auth.broker.test/backoffice';
export const AUDIENCE = 'broker-api';
let signingKey: CryptoKey | undefined;
let jwk: JWK | undefined;

async function keys() {
  if (!signingKey) {
    const pair = await generateKeyPair('ES256', { extractable: true });
    signingKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
  }
  return { signingKey, jwk: jwk! };
}

/** Access token do backoffice com os papéis dados (claims do identity-service, D10). */
export async function backofficeToken(clock: VirtualClock, sub: string, roles: string[]) {
  const now = Math.floor(clock.now().epochMillis / 1000);
  return new SignJWT({ realm: 'backoffice', roles })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign((await keys()).signingKey);
}

export async function app(
  env: Env,
  overrides: Partial<AuditServiceDeps> & { clock?: VirtualClock } = {},
) {
  const clock = overrides.clock ?? testClock();
  const logger = createLogger({
    service: 'audit-service',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent(),
  });
  const anchors = new S3AnchorStorage({
    endpoint: env.minio.endpoint,
    accessKey: env.minio.accessKey,
    secretKey: env.minio.secretKey,
    bucket: BUCKET,
  });
  const a = await createAuditService({
    config: {
      SERVICE_NAME: 'audit-service',
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
    anchors,
    authenticator: new Authenticator({
      jwks: createLocalJWKSet({ keys: [(await keys()).jwk] }),
      issuer: ISSUER,
      audience: AUDIENCE,
      clock,
    }),
    ...overrides,
  });
  return { ...a, clock, anchors };
}

/** Evento do barramento como o consumidor entrega (envelope RN-MSG-B §4). */
export function event(overrides: Partial<CapturedEvent> = {}): CapturedEvent {
  return {
    eventId: uuidv7(),
    eventType: 'order.created',
    source: 'oms-service',
    occurredAt: '2026-01-05T13:00:00.000Z',
    partitionKey: 'acc-1',
    correlationId: uuidv7(),
    actor: { type: 'USER', id: 'user-1' },
    auditable: true,
    payload: { orderId: 'o-1', side: 'BUY', quantity: 100 },
    ...overrides,
  };
}

/** Grava eventos na trilha como o consumidor faria (uma transação por evento). */
export async function captureAll(
  a: Awaited<ReturnType<typeof app>>,
  events: readonly CapturedEvent[],
): Promise<void> {
  for (const e of events) await a.store.transaction((tx) => a.trail.capture(tx, e));
}

export async function outbox(db: Kysely<unknown>) {
  const { rows } = await sql<{ event_type: string; payload: Record<string, unknown> }>`
    SELECT event_type, payload FROM outbox_event ORDER BY seq`.execute(db);
  return rows;
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
