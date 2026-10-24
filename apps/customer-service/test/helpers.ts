import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { VirtualClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import {
  BlindIndex,
  createDatabase,
  FieldCipher,
  loadKeyring,
  migrateToLatest,
  type DatabaseConfig,
} from '@broker/persistence';
import { Authenticator, createLogger, SignatureVerifier } from '@broker/service-kit';
import { generateCpf, seededRandom, testClock, type KycScenarioDigit } from '@broker/testing';
import {
  databaseConfig,
  startMinio,
  startPostgres,
  type StartedMinio,
  type StartedPostgres,
} from '@broker/testing/containers';
import { signedHeaders } from '@broker/webhooks';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { randomBytes, randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import request from 'supertest';
import { FieldProtectionAdapter, nodeRandomness } from '../src/adapters/crypto.js';
import { S3DocumentStorage } from '../src/adapters/s3-documents.js';
import { createCustomerService, type CustomerServiceDeps } from '../src/app.js';
import type {
  BankPort,
  ClosureCheck,
  ClosurePendency,
  KycProvider,
  Messenger,
} from '../src/application/ports.js';
import { migrations } from '../src/migrations.js';

export const ISSUER = 'https://auth.broker.test';
export const AUDIENCE = 'broker-api';
export const WEBHOOK_SECRET = 'segredo-do-webhook-kyc-0123456789';

export interface Env {
  pg: StartedPostgres;
  minio: StartedMinio;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  keys: { master: Buffer; index: Buffer };
}

export async function startEnv(): Promise<Env> {
  const [pg, minio] = await Promise.all([startPostgres(['customer']), startMinio()]);
  const migrator = createDatabase(databaseConfig(pg, 'customer', 'migrator'));
  await migrateToLatest(migrator, migrations);
  await migrator.destroy();
  const s3 = new S3Client({
    endpoint: minio.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });
  await s3.send(new CreateBucketCommand({ Bucket: 'documents' }));
  s3.destroy();
  const database = databaseConfig(pg, 'customer', 'app');
  return {
    pg,
    minio,
    db: createDatabase(database),
    database,
    keys: { master: randomBytes(32), index: randomBytes(32) },
  };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  await Promise.all([env?.pg.container.stop(), env?.minio.container.stop()]);
}

export class FakeMessenger implements Messenger {
  emails: { to: string; text: string }[] = [];
  texts: { to: string; text: string }[] = [];
  async email(to: string, _subject: string, text: string) {
    this.emails.push({ to, text });
  }
  async sms(to: string, text: string) {
    this.texts.push({ to, text });
  }
  lastEmailCode(to: string) {
    return /(\d{6})/.exec([...this.emails].reverse().find((m) => m.to === to)?.text ?? '')![1]!;
  }
  lastSmsCode(to: string) {
    return /(\d{6})/.exec([...this.texts].reverse().find((m) => m.to === to)?.text ?? '')![1]!;
  }
}

/** KYC simulado falso: guarda as submissões; o teste manda os webhooks assinados. */
export class FakeKyc implements KycProvider {
  submissions: (Parameters<KycProvider['submit']>[0] & { checkId: string })[] = [];
  async submit(input: Parameters<KycProvider['submit']>[0]) {
    const checkId = crypto.randomUUID();
    this.submissions.push({ ...input, checkId });
    return { checkId };
  }
}

export class FakeBank implements BankPort {
  accounts: { taxId: string; name: string; id: string }[] = [];
  keys = new Map<string, { type: string; cpf: string; name: string }>();
  failNextOpen = 0;
  async openAccount(taxId: string, name: string) {
    if (this.failNextOpen > 0) {
      this.failNextOpen--;
      throw new Error('Banco Simulado indisponível');
    }
    const existing = this.accounts.find((a) => a.taxId === taxId);
    if (existing) return { id: existing.id };
    const id = crypto.randomUUID();
    this.accounts.push({ taxId, name, id });
    return { id };
  }
  async lookupKey(key: string) {
    const k = this.keys.get(key);
    return k
      ? { type: k.type, holderTaxId: k.cpf, holderNameMasked: `${k.name.split(' ')[0]} S***` }
      : null;
  }
}

export class FakeClosure implements ClosureCheck {
  pending: ClosurePendency[] = [];
  constructor(readonly source: ClosurePendency['source']) {}
  async pendencies() {
    return this.pending.filter((p) => p.source === this.source);
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
  overrides: Partial<CustomerServiceDeps> & { clock?: VirtualClock } = {},
) {
  const clock = overrides.clock ?? testClock();
  const logger = createLogger({
    service: 'customer-service',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent(),
  });
  const fields = new FieldProtectionAdapter(
    new FieldCipher(await loadKeyring(env.db, env.keys.master)),
    new BlindIndex(env.keys.index),
  );
  const jwks = createLocalJWKSet({ keys: [(await signingKey()).jwk] });
  const messenger = new FakeMessenger();
  const kyc = new FakeKyc();
  const bank = new FakeBank();
  const closure = (['LEDGER', 'CUSTODY', 'SECURITIES_LENDING', 'CLEARING', 'TAX'] as const).map(
    (s) => new FakeClosure(s),
  );
  const documents = new S3DocumentStorage({
    endpoint: env.minio.endpoint,
    accessKey: env.minio.accessKey,
    secretKey: env.minio.secretKey,
    bucket: 'documents',
  });
  const a = await createCustomerService({
    config: {
      SERVICE_NAME: 'customer-service',
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
    fields,
    random: nodeRandomness,
    documents,
    kyc,
    bank,
    messenger,
    closureChecks: closure,
    authenticator: new Authenticator({ jwks, issuer: ISSUER, audience: AUDIENCE, clock }),
    signatureVerifier: new SignatureVerifier({ jwks, issuer: ISSUER, audience: AUDIENCE, clock }),
    kycWebhookSecret: WEBHOOK_SECRET,
    sagaResumeMs: 60_000,
    ...overrides,
  });
  const http = request(a.service.app);
  return { ...a, clock, http, messenger, kyc, bank, closure, documents, fields };
}

// ------------------------------------------------------------------ tokens

const now = (clock: VirtualClock) => Math.floor(clock.now().epochMillis / 1000);

export async function customerToken(
  clock: VirtualClock,
  userId: string,
  opts: { sessionId?: string; mfaAgoSec?: number } = {},
) {
  return new SignJWT({
    realm: 'customers',
    roles: [],
    scope: 'profile:read profile:write',
    session_id: opts.sessionId ?? `s-${userId}`,
    amr: ['pwd'],
    ...(opts.mfaAgoSec !== undefined ? { mfa_time: now(clock) - opts.mfaAgoSec } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now(clock))
    .setExpirationTime(now(clock) + 600)
    .setJti(uuidv7())
    .sign((await signingKey()).key);
}

export async function signatureToken(clock: VirtualClock, userId: string, scope: string) {
  return new SignJWT({ session_id: `s-${userId}`, sig_scope: scope })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'sig+jwt' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now(clock))
    .setExpirationTime(now(clock) + 300)
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
    .setIssuedAt(now(clock))
    .setExpirationTime(now(clock) + 600)
    .sign((await signingKey()).key);
}

export async function serviceToken(clock: VirtualClock, scopes: string[]) {
  return new SignJWT({
    realm: 'services',
    roles: [],
    scope: scopes.join(' '),
    client_id: 'oms-service',
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setSubject('oms-service')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now(clock))
    .setExpirationTime(now(clock) + 600)
    .sign((await signingKey()).key);
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// ------------------------------------------------------------------ dados e arquivos

/** PNG mínimo com as dimensões no cabeçalho IHDR (o que a inspeção lê). */
export function png(width: number, height: number, size = 4096): Buffer {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** CPF válido com o penúltimo dígito escolhido (regra do KYC simulado, Onboarding §5.2). */
export const cpfWithDigit = (digit: number) =>
  generateCpf({
    penultimateDigit: digit as KycScenarioDigit,
    random: seededRandom(randomInt(1, 2 ** 31)),
  });

export function personal(over: Record<string, unknown> = {}) {
  return {
    fullName: 'Maria Souza',
    taxId: cpfWithDigit(3),
    birthDate: '1990-05-10',
    nationality: 'BRAZILIAN',
    maritalStatus: 'SINGLE',
    motherName: 'Joana Souza',
    idDocument: {
      type: 'RG',
      number: '123456789',
      issuer: 'SSP',
      issuerState: 'SP',
      issueDate: '2015-01-10',
    },
    ...over,
  };
}

export const ADDRESS = {
  zipCode: '01310100',
  street: 'Avenida Paulista',
  number: '1000',
  district: 'Bela Vista',
  city: 'São Paulo',
  state: 'SP',
};

export function financial(over: Record<string, unknown> = {}) {
  return {
    occupation: 'EMPLOYEE',
    monthlyIncome: '8000.00',
    declaredNetWorth: '150000.00',
    pep: false,
    linkedPerson: false,
    fundsOrigin: 'Salário',
    foreignTaxResidency: false,
    ...over,
  };
}

/** Respostas do questionário v1 que somam `target` pontos (8 perguntas, pesos 0/2/4/6 e 0..3). */
export function answersFor(target: number): Record<string, string> {
  const ids = [
    'objective',
    'horizon',
    'knowledge',
    'experience',
    'frequency',
    'loss_reaction',
    'share',
  ];
  const answers: Record<string, string> = {};
  let left = target;
  const liq = Math.min(3, left % 2 === 1 ? 1 : 0);
  answers['liquidity'] = 'abcd'[liq]!;
  left -= liq;
  for (const id of ids) {
    const w = Math.min(6, left);
    answers[id] = 'abcd'[w / 2]!;
    left -= w;
  }
  if (left !== 0) throw new Error(`não dá para somar ${target}`);
  return answers;
}

export interface Applicant {
  userId: string;
  token: string;
  email: string;
  phone: string;
  taxId: string;
}

/** Faz as etapas até a escolhida (inclusive), pelo HTTP, como o app faria. */
export async function onboardUntil(
  a: App,
  until:
    | 'CONTACT_VERIFIED'
    | 'PERSONAL_DATA'
    | 'ADDRESS'
    | 'FINANCIAL_PROFILE'
    | 'DOCUMENTS'
    | 'SUITABILITY'
    | 'TERMS',
  over: { taxId?: string; financial?: Record<string, unknown>; points?: number } = {},
): Promise<Applicant> {
  const userId = uuidv7();
  const token = await customerToken(a.clock, userId);
  const h = bearer(token);
  const email = `cli.${userId.slice(-8)}@exemplo.com`;
  const phone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const taxId = over.taxId ?? cpfWithDigit(3);
  const steps = [
    'CONTACT_VERIFIED',
    'PERSONAL_DATA',
    'ADDRESS',
    'FINANCIAL_PROFILE',
    'DOCUMENTS',
    'SUITABILITY',
    'TERMS',
  ];
  const want = (s: string) => steps.indexOf(s) <= steps.indexOf(until);

  await a.http.put('/v1/me/onboarding/contact').set(h).send({ email, phone }).expect(204);
  await a.http
    .post('/v1/me/onboarding/contact/verify')
    .set(h)
    .send({
      emailCode: a.messenger.lastEmailCode(email),
      phoneCode: a.messenger.lastSmsCode(phone),
    })
    .expect(204);
  if (want('PERSONAL_DATA'))
    await a.http
      .put('/v1/me/onboarding/personal-data')
      .set(h)
      .send(personal({ taxId }))
      .expect(204);
  if (want('ADDRESS'))
    await a.http.put('/v1/me/onboarding/address').set(h).send(ADDRESS).expect(204);
  if (want('FINANCIAL_PROFILE'))
    await a.http
      .put('/v1/me/onboarding/financial-profile')
      .set(h)
      .send(financial(over.financial))
      .expect(204);
  if (want('DOCUMENTS')) {
    for (const type of ['ID_FRONT', 'SELFIE']) await uploadDocument(a, token, type, png(1200, 900));
  }
  if (want('SUITABILITY')) {
    await a.http
      .post('/v1/me/suitability/assessments')
      .set(h)
      .send({ questionnaireVersion: 1, answers: answersFor(over.points ?? 20) })
      .expect(201);
  }
  if (want('TERMS')) {
    const pending = (await a.http.get('/v1/me/terms/pending').set(h).expect(200)).body.terms as {
      termsId: string;
      version: number;
      moment: string;
      mandatory: boolean;
    }[];
    for (const t of pending.filter((x) => x.mandatory && x.moment === 'ONBOARDING')) {
      await a.http
        .post(`/v1/me/terms/${t.termsId}/accept`)
        .set(h)
        .send({ version: t.version })
        .expect(204);
    }
  }
  return { userId, token, email, phone, taxId };
}

/** URL assinada → PUT direto no MinIO → registro do documento. */
export async function uploadDocument(
  a: App,
  token: string,
  type: string,
  body: Buffer,
  contentType = 'image/png',
) {
  const url = await a.http
    .post('/v1/me/onboarding/documents/upload-url')
    .set(bearer(token))
    .set('Idempotency-Key', uuidv7())
    .send({ type, contentType, sizeBytes: body.length })
    .expect(201);
  const put = await fetch(url.body.uploadUrl, {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType },
  });
  if (!put.ok) throw new Error(`upload falhou: ${put.status} ${await put.text()}`);
  return a.http
    .post('/v1/me/onboarding/documents')
    .set(bearer(token))
    .send({ documentId: url.body.documentId });
}

/** Verificações como o KYC simulado decide pelo penúltimo dígito do CPF (Onboarding §5.2). */
export function verificationsFor(taxId: string) {
  const digit = Number(taxId[9]);
  return [
    { type: 'TAX_ID_STATUS', status: digit === 9 ? 'FAILED' : 'PASSED', details: {} },
    { type: 'DOCUMENT_QUALITY', status: 'PASSED', details: {} },
    {
      type: 'FACE_MATCH',
      status: digit === 7 ? 'ATTENTION' : 'PASSED',
      score: digit === 7 ? 65 : 92,
      details: {},
    },
    { type: 'WATCHLIST', status: digit === 8 ? 'ATTENTION' : 'PASSED', details: {} },
    { type: 'LIVENESS', status: 'PASSED', score: 95, details: {} },
  ];
}

/** Envia um webhook assinado do KYC (RN-SIM-003). */
export function kycWebhook(a: App, event: string, body: object, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  return a.http
    .post('/webhooks/kyc-simulator')
    .set({
      'content-type': 'application/json',
      'x-webhook-event': event,
      ...signedHeaders(secret, a.clock.now().epochMillis, raw),
    })
    .send(raw);
}

/** Submete e responde o KYC com o resultado do CPF; devolve o status final. */
export async function submitAndDecide(a: App, applicant: Applicant): Promise<string> {
  await a.http
    .post('/v1/me/onboarding/submit')
    .set(bearer(applicant.token))
    .set('Idempotency-Key', uuidv7())
    .expect(202);
  const sub = a.kyc.submissions.at(-1)!;
  const verifications = verificationsFor(applicant.taxId);
  for (const v of verifications) {
    await kycWebhook(a, 'check.verification_completed', {
      check_id: sub.checkId,
      reference_id: sub.referenceId,
      verification: v,
    }).expect(204);
  }
  await kycWebhook(a, 'check.completed', {
    check_id: sub.checkId,
    reference_id: sub.referenceId,
    verifications,
  }).expect(204);
  return (await a.http.get('/v1/me/onboarding').set(bearer(applicant.token))).body.status;
}

export async function outbox(db: Kysely<unknown>, type?: string) {
  const { rows } = await sql<{ event_type: string; payload: Record<string, unknown> }>`
    SELECT event_type, payload FROM outbox_event ${type ? sql`WHERE event_type = ${type}` : sql``} ORDER BY seq`.execute(
    db,
  );
  return rows;
}

export const waitUntil = async (cond: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 50));
  }
};
