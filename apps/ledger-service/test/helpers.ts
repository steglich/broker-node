import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import type { VirtualClock } from '@broker/clock';
import { Instant, Money } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest, type DatabaseConfig } from '@broker/persistence';
import { Authenticator, createLogger, SignatureVerifier } from '@broker/service-kit';
import { generateCpf, seededRandom, testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { signedHeaders } from '@broker/webhooks';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { createHash, randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import request from 'supertest';
import { createLedgerService, type LedgerServiceDeps } from '../src/app.js';
import {
  IntegrationError,
  type BankTransaction,
  type CriticalLedgerAlert,
  type CustomerDirectory,
  type PixGateway,
  type WithdrawalDestination,
} from '../src/application/ports.js';
import { migrations } from '../src/migrations.js';

export const ISSUER = 'https://auth.broker.test';
export const AUDIENCE = 'broker-api';
export const WEBHOOK_SECRET = 'segredo-do-webhook-pix-0123456789';

export const brl = (v: string) => Money.of(v, 'BRL');

export interface Env {
  pg: StartedPostgres;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  /** Conexão do migrador (dono das tabelas), para os testes das barreiras do banco. */
  owner: Kysely<unknown>;
}

export async function startEnv(): Promise<Env> {
  const pg = await startPostgres(['ledger']);
  const owner = createDatabase(databaseConfig(pg, 'ledger', 'migrator'));
  await migrateToLatest(owner, migrations);
  const database = databaseConfig(pg, 'ledger', 'app');
  return { pg, db: createDatabase(database), database, owner };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  await env?.owner.destroy();
  await env?.pg.container.stop();
}

// ------------------------------------------------------------------ Banco Simulado falso

type SendBehavior = 'OK' | 'TRANSIENT' | { definitive: string };

let e2eSeq = 0;
const e2e = (at: Instant) =>
  `ESIM${at.toString().replace(/[-:T]/g, '').slice(0, 14)}${(++e2eSeq).toString(36).padStart(14, '0')}`;

/** Simula o Banco Simulado: cobranças, pagamentos (geram o webhook), devoluções e envios. */
export class FakePix implements PixGateway {
  charges = new Map<string, { amount: Money; expiresInSeconds: number }>();
  txs: BankTransaction[] = [];
  refunds: { endToEndId: string; refundId: string; amount: Money }[] = [];
  sends = new Map<string, { endToEndId: string; amount: Money; pixKey: string }>();
  sendAttempts = 0;
  /** Comportamento dos próximos envios (o último se repete). */
  sendPlan: SendBehavior[] = ['OK'];
  failRefunds = 0;
  unavailable = false;

  constructor(private readonly clock: VirtualClock) {}

  async createCharge(input: { txid: string; amount: Money; expiresInSeconds: number }) {
    if (this.unavailable) throw new IntegrationError('TRANSIENT', 'UNAVAILABLE', 'fora do ar');
    this.charges.set(input.txid, {
      amount: input.amount,
      expiresInSeconds: input.expiresInSeconds,
    });
    return { copyPaste: `00020101SIMULADO${input.txid}` };
  }

  /** O cliente (ou um terceiro) paga a cobrança: devolve o item do webhook. */
  pay(txid: string, payerCpf: string, amount?: Money) {
    const charge = this.charges.get(txid)!;
    const now = this.clock.now();
    const tx: BankTransaction = {
      endToEndId: e2e(now),
      kind: 'CHARGE_PAYMENT',
      completed: true,
      amount: amount ?? charge.amount,
      at: now,
      refunds: [],
    };
    this.txs.push(tx);
    return {
      endToEndId: tx.endToEndId,
      txid,
      valor: tx.amount.amount.toFixed(2),
      horario: now.toString(),
      pagador: { cpf: payerCpf, nome: 'Pagador' },
    };
  }

  async refund(input: { endToEndId: string; refundId: string; amount: Money }) {
    if (this.failRefunds > 0) {
      this.failRefunds--;
      throw new IntegrationError('TRANSIENT', 'HTTP_503', 'fora do ar');
    }
    const original = this.txs.find((t) => t.endToEndId === input.endToEndId)!;
    const existing = this.refunds.find((r) => r.refundId === input.refundId);
    if (existing) return { returnId: original.refunds[0]! };
    const id = e2e(this.clock.now());
    this.refunds.push(input);
    original.refunds.push(id);
    this.txs.push({
      endToEndId: id,
      kind: 'REFUND',
      completed: true,
      amount: input.amount,
      at: this.clock.now(),
      refunds: [],
    });
    return { returnId: id };
  }

  async send(input: { sendId: string; amount: Money; pixKey: string; holderTaxId: string | null }) {
    this.sendAttempts++;
    const done = this.sends.get(input.sendId);
    if (done) return { endToEndId: done.endToEndId };
    const behavior = this.sendPlan.length > 1 ? this.sendPlan.shift()! : this.sendPlan[0]!;
    if (behavior === 'TRANSIENT') throw new IntegrationError('TRANSIENT', 'HTTP_503', 'fora do ar');
    const id = e2e(this.clock.now());
    if (typeof behavior === 'object') {
      this.txs.push({
        endToEndId: id,
        kind: 'TRANSFER',
        completed: false,
        amount: input.amount,
        at: this.clock.now(),
        refunds: [],
      });
      throw new IntegrationError('DEFINITIVE', behavior.definitive, 'PIX recusado');
    }
    this.sends.set(input.sendId, { endToEndId: id, amount: input.amount, pixKey: input.pixKey });
    this.txs.push({
      endToEndId: id,
      kind: 'TRANSFER',
      completed: true,
      amount: input.amount,
      at: this.clock.now(),
      refunds: [],
    });
    return { endToEndId: id };
  }

  async transactions(from: Instant, to: Instant) {
    return this.txs.filter((t) => !t.at.isBefore(from) && t.at.isBefore(to));
  }

  async transaction(endToEndId: string) {
    return this.txs.find((t) => t.endToEndId === endToEndId) ?? null;
  }
}

// ------------------------------------------------------------------ customer-service falso

export class FakeCustomers implements CustomerDirectory {
  holders = new Map<string, string>();
  blockedWithdraw = new Set<string>();
  destinations = new Map<string, WithdrawalDestination & { accountId: string }>();
  unavailable = false;

  async holderMatches(accountId: string, taxId: string) {
    if (this.unavailable) throw new IntegrationError('TRANSIENT', 'UNAVAILABLE', 'fora do ar');
    return this.holders.get(accountId) === taxId;
  }
  async eligibility(accountId: string) {
    if (this.unavailable) throw new IntegrationError('TRANSIENT', 'UNAVAILABLE', 'fora do ar');
    return this.blockedWithdraw.has(accountId)
      ? { allowed: false, code: 'ACCOUNT_NOT_ACTIVE' }
      : { allowed: true };
  }
  async withdrawalDestination(accountId: string, id: string) {
    if (this.unavailable) throw new IntegrationError('TRANSIENT', 'UNAVAILABLE', 'fora do ar');
    const d = this.destinations.get(id);
    return d && d.accountId === accountId ? d : null;
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
  overrides: Partial<LedgerServiceDeps> & { clock?: VirtualClock } = {},
) {
  const clock = overrides.clock ?? testClock();
  const logger = createLogger({
    service: 'ledger-service',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent(),
  });
  const jwks = createLocalJWKSet({ keys: [(await signingKey()).jwk] });
  const pix = new FakePix(clock);
  const customers = new FakeCustomers();
  const alerts: CriticalLedgerAlert[] = [];
  const a = await createLedgerService({
    config: {
      SERVICE_NAME: 'ledger-service',
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
    pix,
    customers,
    taxIds: { hash: (v) => createHash('sha256').update(`teste:${v}`).digest('hex') },
    depositRules: { min: brl('1.00'), max: brl('1000000.00'), expiresInSeconds: 1800 },
    withdrawalRules: {
      min: brl('1.00'),
      daily: brl('100000.00'),
      nightly: brl('1000.00'),
      nightStart: '20:00',
      nightEnd: '06:00',
      reviewAbove: brl('50000.00'),
      maxAttempts: 5,
      retryWindowMs: 30 * 60_000,
    },
    authenticator: new Authenticator({ jwks, issuer: ISSUER, audience: AUDIENCE, clock }),
    signatureVerifier: new SignatureVerifier({ jwks, issuer: ISSUER, audience: AUDIENCE, clock }),
    pixWebhookSecret: WEBHOOK_SECRET,
    onCriticalAlert: (alert) => alerts.push(alert),
    ...overrides,
  });
  const http = request(a.service.app);
  return { ...a, clock, http, pix, customers, alerts };
}

// ------------------------------------------------------------------ tokens

const nowSec = (clock: VirtualClock) => Math.floor(clock.now().epochMillis / 1000);

export async function customerToken(clock: VirtualClock, userId: string, accountId?: string) {
  return new SignJWT({
    realm: 'customers',
    roles: [],
    scope: 'profile:read',
    session_id: `s-${userId}`,
    amr: ['pwd'],
    ...(accountId ? { account_id: accountId } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSec(clock))
    .setExpirationTime(nowSec(clock) + 3600)
    .setJti(uuidv7())
    .sign((await signingKey()).key);
}

export async function signatureToken(clock: VirtualClock, userId: string, scope: string) {
  return new SignJWT({ session_id: `s-${userId}`, sig_scope: scope })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'sig+jwt' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSec(clock))
    .setExpirationTime(nowSec(clock) + 300)
    .setJti(uuidv7())
    .sign((await signingKey()).key);
}

export async function backofficeToken(clock: VirtualClock, roles: string[], sub = 'op-1') {
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
    .setExpirationTime(nowSec(clock) + 3600)
    .sign((await signingKey()).key);
}

export async function serviceToken(clock: VirtualClock, scopes: string[]) {
  return new SignJWT({
    realm: 'services',
    roles: [],
    scope: scopes.join(' '),
    client_id: 'customer-service',
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setSubject('customer-service')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSec(clock))
    .setExpirationTime(nowSec(clock) + 3600)
    .sign((await signingKey()).key);
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// ------------------------------------------------------------------ cenários

export const randomCpf = () => generateCpf({ random: seededRandom(randomInt(1, 2 ** 31)) });

export interface Client {
  accountId: string;
  userId: string;
  taxId: string;
  token: string;
}

/** Conta aberta no ledger (como o consumidor de `account.opened` faz) e titular conhecido. */
export async function openClient(a: App): Promise<Client> {
  const accountId = uuidv7();
  const userId = uuidv7();
  const taxId = randomCpf();
  await a.store.transaction((tx) =>
    a.accounts.onAccountOpened(tx, {
      accountId,
      customerId: uuidv7(),
      accountNumber: '1000001-9',
      openedAt: a.clock.now().toString(),
    }),
  );
  a.customers.holders.set(accountId, taxId);
  return { accountId, userId, taxId, token: await customerToken(a.clock, userId, accountId) };
}

/** Envia o webhook `pix.recebido` assinado, como o Banco Simulado. */
export function webhook(a: App, item: ReturnType<FakePix['pay']>, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify({ pix: [item] });
  return a.http
    .post('/webhooks/pix-simulator')
    .set({
      'content-type': 'application/json',
      'X-Webhook-Event': 'pix.recebido',
      'X-Webhook-Id': item.endToEndId,
      ...signedHeaders(secret, a.clock.now().epochMillis, raw),
    })
    .send(raw);
}

/** Depósito completo: cobrança, pagamento pelo titular e webhook. Devolve o id do depósito. */
export async function deposit(a: App, c: Client, amount: string): Promise<string> {
  const created = await a.http
    .post('/v1/me/deposits')
    .set(bearer(c.token))
    .set('Idempotency-Key', uuidv7())
    .send({ amount })
    .expect(201);
  const txid = (created.body.id as string).replaceAll('-', '');
  await webhook(a, a.pix.pay(txid, c.taxId)).expect(204);
  return created.body.id as string;
}

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

export const balancesOf = async (a: App, c: Client) =>
  (await a.http.get('/v1/me/balances').set(bearer(c.token)).expect(200)).body as {
    settled: string;
    projected: { d0: string; d1: string; d2: string };
    projectedTotal: string;
    withdrawable: string;
    holds: string;
    asOf: string;
    lastSequence: number;
  };

export const at = (iso: string) => Instant.parse(iso);
