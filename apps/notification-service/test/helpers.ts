import type { VirtualClock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import {
  BlindIndex,
  createDatabase,
  FieldCipher,
  generateKeyHex,
  loadKeyring,
  migrateToLatest,
  parseKey,
  type DatabaseConfig,
} from '@broker/persistence';
import { Authenticator, createLogger } from '@broker/service-kit';
import { testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { Writable } from 'node:stream';
import request from 'supertest';
import { FieldTokenProtection } from '../src/adapters/integrations.js';
import { createNotificationService, type NotificationServiceDeps } from '../src/app.js';
import type { SourceEvent } from '../src/application/notifier.js';
import {
  DeliveryError,
  type EmailSender,
  type MessageSinkPort,
  type OutgoingEmail,
  type Recipient,
  type RecipientDirectory,
  type RecipientRef,
  type SinkResult,
} from '../src/application/ports.js';
import { migrations } from '../src/migrations.js';

export const ISSUER = 'https://auth.broker.test';
export const AUDIENCE = 'broker-api';

export interface Env {
  pg: StartedPostgres;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  owner: Kysely<unknown>;
  masterKey: Buffer;
}

export async function startEnv(): Promise<Env> {
  const pg = await startPostgres(['notification']);
  const owner = createDatabase(databaseConfig(pg, 'notification', 'migrator'));
  await migrateToLatest(owner, migrations);
  const database = databaseConfig(pg, 'notification', 'app');
  return {
    pg,
    db: createDatabase(database),
    database,
    owner,
    masterKey: parseKey(generateKeyHex()),
  };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  await env?.owner.destroy();
  await env?.pg.container.stop();
}

// ------------------------------------------------------------------ dublês

/** customer-service: destinatários conhecidos por qualquer uma das referências. */
export class FakeRecipients implements RecipientDirectory {
  private readonly byRef = new Map<string, Recipient>();
  calls = 0;
  unavailable = false;

  add(r: Recipient & { customerId?: string; applicationId?: string }): Recipient {
    for (const key of [r.userId, r.accountId, r.customerId, r.applicationId])
      if (key) this.byRef.set(key, r);
    return r;
  }

  async resolve(ref: RecipientRef): Promise<Recipient | null> {
    this.calls++;
    if (this.unavailable) throw new DeliveryError('TRANSIENT', 'UNAVAILABLE', 'fora do ar');
    const r = this.byRef.get(Object.values(ref)[0] as string);
    return r ? { ...r } : null;
  }
}

type Plan = 'OK' | 'TRANSIENT' | 'DEFINITIVE';

export class FakeEmail implements EmailSender {
  sent: OutgoingEmail[] = [];
  attempts = 0;
  /** Comportamento das próximas tentativas (o último se repete). */
  plan: Plan[] = ['OK'];

  async send(m: OutgoingEmail): Promise<void> {
    this.attempts++;
    const p = this.plan.length > 1 ? this.plan.shift()! : this.plan[0]!;
    if (p === 'TRANSIENT') throw new DeliveryError('TRANSIENT', 'SMTP_UNAVAILABLE', 'fora do ar');
    if (p === 'DEFINITIVE') throw new DeliveryError('DEFINITIVE', 'SMTP_550', 'recusado');
    this.sent.push(m);
  }
}

export class FakeSink implements MessageSinkPort {
  smsSent: { to: string; body: string }[] = [];
  pushSent: { deviceToken: string; title: string; body: string; data: Record<string, string> }[] =
    [];
  unregistered = new Set<string>();

  async sms(m: { to: string; body: string }): Promise<SinkResult> {
    this.smsSent.push(m);
    return { status: 'DELIVERED', error: null };
  }

  async push(m: {
    deviceToken: string;
    title: string;
    body: string;
    data: Record<string, string>;
  }): Promise<SinkResult> {
    if (this.unregistered.has(m.deviceToken))
      return { status: 'FAILED', error: 'UNREGISTERED_DEVICE' };
    this.pushSent.push(m);
    return { status: 'DELIVERED', error: null };
  }
}

// ------------------------------------------------------------------ app

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
  overrides: Partial<NotificationServiceDeps> & { clock?: VirtualClock } = {},
) {
  const clock = overrides.clock ?? testClock('2026-10-27T14:00:00Z');
  const logger = createLogger({
    service: 'notification-service',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent(),
  });
  const jwks = createLocalJWKSet({ keys: [(await signingKey()).jwk] });
  const recipients = new FakeRecipients();
  const email = new FakeEmail();
  const sink = new FakeSink();
  const a = await createNotificationService({
    config: {
      SERVICE_NAME: 'notification-service',
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
    recipients,
    email,
    sink,
    tokens: new FieldTokenProtection(
      new FieldCipher(await loadKeyring(env.db, env.masterKey)),
      new BlindIndex(parseKey(generateKeyHex())),
    ),
    appUrl: 'https://app.broker.test',
    authenticator: new Authenticator({ jwks, issuer: ISSUER, audience: AUDIENCE, clock }),
    ...overrides,
  });
  const http = request(a.service.app);

  /** Notifica a partir de um evento de origem, como o consumidor faz (na transação dele). */
  const notify = (s: SourceEvent) => a.store.transaction((tx) => a.notifier.notify(tx, s));
  return { ...a, clock, http, recipients, email, sink, notify };
}

export async function customerToken(clock: VirtualClock, userId: string) {
  const now = Math.floor(clock.now().epochMillis / 1000);
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
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setJti(uuidv7())
    .sign((await signingKey()).key);
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Um cliente com conta aberta, conhecido pelo diretório. */
export async function client(a: App) {
  const r = a.recipients.add({
    userId: uuidv7(),
    accountId: uuidv7(),
    email: `cli.${uuidv7().slice(-8)}@exemplo.com`,
    phone: '+5511987654321',
  });
  return { ...r, accountId: r.accountId!, token: await customerToken(a.clock, r.userId) };
}

export const depositCredited = (accountId: string, amount: string, eventId = uuidv7()) => ({
  eventId,
  occurredAt: '2026-10-27T14:00:00.000Z',
  payload: { depositId: uuidv7(), accountId, amount },
});

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

export async function deliveries(db: Kysely<unknown>, notificationId: string) {
  const { rows } = await sql<{
    channel: string;
    status: string;
    attempts: number;
    next_attempt_at: Date | null;
    last_error: string | null;
    title: string;
    body: string;
  }>`SELECT * FROM notification_delivery WHERE notification_id = ${notificationId} ORDER BY channel`.execute(
    db,
  );
  return rows;
}

export const at = (iso: string) => Instant.parse(iso);
