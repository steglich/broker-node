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
import {
  Authenticator,
  createLogger,
  RevocationList,
  SignatureVerifier,
} from '@broker/service-kit';
import { generateCpf, testClock } from '@broker/testing';
import {
  databaseConfig,
  startPostgres,
  startValkey,
  type StartedPostgres,
  type StartedValkey,
} from '@broker/testing/containers';
import { Valkey } from 'iovalkey';
import { sql, type Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import request from 'supertest';
import { Argon2Hasher, FieldProtectionAdapter, nodeRandomness } from '../src/adapters/crypto.js';
import { JoseTokenSigner } from '../src/adapters/token-signer.js';
import { OtplibTotp } from '../src/adapters/totp.js';
import { createIdentityService, type IdentityServiceDeps } from '../src/app.js';
import { CTX } from '../src/application/context.js';
import type { Messenger, WebAuthnPort } from '../src/application/ports.js';
import { s256 } from '../src/domain/pkce.js';
import { migrations } from '../src/migrations.js';

export const ISSUER = 'https://auth.broker.test';
export const AUDIENCE = 'broker-api';

export interface Env {
  pg: StartedPostgres;
  valkeyContainer: StartedValkey;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  valkey: Valkey;
  /** Chave-mestra e chave do HMAC do ambiente (como os Docker secrets). */
  keys: { master: Buffer; index: Buffer };
}

export async function startEnv(): Promise<Env> {
  const [pg, valkeyContainer] = await Promise.all([startPostgres(['identity']), startValkey()]);
  const migrator = createDatabase(databaseConfig(pg, 'identity', 'migrator'));
  await migrateToLatest(migrator, migrations);
  await migrator.destroy();
  const database = databaseConfig(pg, 'identity', 'app');
  return {
    pg,
    valkeyContainer,
    db: createDatabase(database),
    database,
    valkey: new Valkey({ host: valkeyContainer.host, port: valkeyContainer.port }),
    keys: { master: randomBytes(32), index: randomBytes(32) },
  };
}

export async function stopEnv(env: Env | undefined): Promise<void> {
  await env?.db.destroy();
  env?.valkey.disconnect();
  await Promise.all([env?.pg.container.stop(), env?.valkeyContainer.container.stop()]);
}

/** E-mails e SMS capturados (no ar: Mailpit e message-sink). */
export class FakeMessenger implements Messenger {
  emails: { to: string; subject: string; text: string }[] = [];
  texts: { to: string; text: string }[] = [];
  async email(to: string, subject: string, text: string) {
    this.emails.push({ to, subject, text });
  }
  async sms(to: string, text: string) {
    this.texts.push({ to, text });
  }
  lastLink(to: string): string {
    const mail = [...this.emails].reverse().find((m) => m.to === to);
    const token = /token=([\w-]+)/.exec(mail?.text ?? '')?.[1];
    if (!token) throw new Error(`nenhum link enviado para ${to}`);
    return token;
  }
  lastCode(to: string): string {
    const msg = [...this.texts].reverse().find((m) => m.to === to);
    const code = /(\d{6})/.exec(msg?.text ?? '')?.[1];
    if (!code) throw new Error(`nenhum código enviado para ${to}`);
    return code;
  }
}

/**
 * Autenticador WebAuthn falso: a "assinatura" é o próprio desafio. Os testes exercitam o fluxo
 * (desafio guardado, credencial certa, contador); a criptografia é da @simplewebauthn/server.
 */
export class FakeWebAuthn implements WebAuthnPort {
  private n = 0;
  async registrationOptions() {
    const challenge = `reg-${++this.n}`;
    return { options: { challenge }, challenge };
  }
  async verifyRegistration(response: unknown, challenge: string) {
    const r = response as { id: string; challenge: string };
    return r.challenge === challenge
      ? { credentialId: r.id, publicKey: 'pk', signCount: 0, transports: ['internal'] }
      : null;
  }
  async authenticationOptions() {
    const challenge = `auth-${++this.n}`;
    return { options: { challenge }, challenge };
  }
  async verifyAuthentication(response: unknown, challenge: string, cred: { signCount: number }) {
    return (response as { challenge: string }).challenge === challenge
      ? { signCount: cred.signCount + 1 }
      : null;
  }
}

const silent = () => new Writable({ write: (_c, _e, cb) => cb() });

export type App = Awaited<ReturnType<typeof app>>;

export async function app(
  env: Env,
  overrides: Partial<IdentityServiceDeps> & { clock?: VirtualClock } = {},
) {
  const clock = overrides.clock ?? testClock();
  const logger = createLogger({
    service: 'identity-service',
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
  const signer = new JoseTokenSigner(env.db, fields, uuidv7, clock, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  const revocation = new RevocationList(env.valkey);
  const jwks = signer.keyResolver();
  const messenger = new FakeMessenger();
  const webauthn = new FakeWebAuthn();
  const totp = new OtplibTotp();
  const authenticator = new Authenticator({
    jwks,
    issuer: ISSUER,
    audience: AUDIENCE,
    clock,
    revocation,
  });
  const a = await createIdentityService({
    config: {
      SERVICE_NAME: 'identity-service',
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
    // Custo baixo nos testes; o padrão do serviço é o da OWASP.
    hasher: new Argon2Hasher({ memory: 1024, passes: 1, parallelism: 1 }),
    fields,
    random: nodeRandomness,
    signer,
    revocation,
    totp,
    webauthn,
    messenger,
    links: { recovery: 'https://app.test/recuperar', invitation: 'https://bo.test/convite' },
    authenticator,
    ...overrides,
  });
  return {
    ...a,
    clock,
    fields,
    signer,
    revocation,
    messenger,
    webauthn,
    totp,
    http: request(a.service.app),
    /** O "gateway": valida o access token pela JWKS e pela lista de revogação. */
    gateway: authenticator,
    signatureVerifier: new SignatureVerifier({
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
      clock,
      revocation,
    }),
    /** Código TOTP atual do segredo. */
    otp: (secret: string) => totp.generate(secret, clock.now()),
    async totpSecretOf(userId: string): Promise<string> {
      const { rows } = await sql<{ secret_enc: string }>`
        SELECT secret_enc FROM mfa_factor WHERE user_id = ${userId} AND type = 'TOTP' AND status = 'ACTIVE'`.execute(
        env.db,
      );
      return fields.open(rows[0]!.secret_enc, CTX.totp);
    },
  };
}

export const PASSWORD = 'cavalo correto bateria grampo';

let seq = 0;
export function newCustomer(
  over: Partial<{ email: string; password: string; fullName: string; taxId: string }> = {},
) {
  seq++;
  return {
    email: `cliente${seq}.${uuidv7().slice(-6)}@exemplo.com`,
    password: PASSWORD,
    fullName: 'Maria Souza',
    taxId: generateCpf(),
    ...over,
  };
}

export async function register(a: App, over: Parameters<typeof newCustomer>[0] = {}) {
  const c = newCustomer(over);
  const res = await a.http.post('/v1/customers/register').send(c).expect(201);
  return { ...c, userId: res.body.userId as string };
}

export const CLIENTS = {
  web: { id: 'bff-web', redirect: 'https://app.broker.localhost/auth/callback' },
  desktop: { id: 'desktop-app', redirect: 'http://127.0.0.1/callback' },
  mobile: { id: 'mobile-app', redirect: 'br.broker.app:/callback' },
  backoffice: {
    id: 'bff-backoffice',
    redirect: 'https://backoffice.broker.localhost/auth/callback',
  },
} as const;

export interface LoginOptions {
  client?: keyof typeof CLIENTS;
  deviceId?: string;
  totpSecret?: string;
}

/** Fluxo completo: authorize (+ MFA) → código → token, com PKCE. */
export async function login(
  a: App,
  who: { email: string; password: string },
  opts: LoginOptions = {},
) {
  const client = CLIENTS[opts.client ?? 'web'];
  const verifier = randomBytes(32).toString('base64url');
  const first = await a.http.post('/v1/oauth/authorize').send({
    client_id: client.id,
    redirect_uri: client.redirect,
    code_challenge: s256(verifier),
    code_challenge_method: 'S256',
    device_id: opts.deviceId ?? 'device-principal-01',
    email: who.email,
    password: who.password,
  });
  if (first.status !== 200)
    throw new Error(`authorize ${first.status}: ${JSON.stringify(first.body)}`);
  let code = first.body.code as string | undefined;
  if (first.body.status === 'MFA_REQUIRED') {
    if (!opts.totpSecret) throw new Error('MFA exigido e o teste não passou o segredo TOTP');
    const mfa = await a.http
      .post('/v1/oauth/authorize/mfa')
      .send({ mfa_token: first.body.mfaToken, method: 'TOTP', code: a.otp(opts.totpSecret) })
      .expect(200);
    code = mfa.body.code;
  }
  const tokens = await a.http
    .post('/v1/oauth/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.id,
      redirect_uri: client.redirect,
    })
    .expect(200);
  return tokens.body as {
    access_token: string;
    refresh_token: string;
    scope: string;
    expires_in: number;
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function outbox(db: Kysely<unknown>, type?: string) {
  const { rows } = await sql<{ event_type: string; payload: Record<string, unknown> }>`
    SELECT event_type, payload FROM outbox_event ${type ? sql`WHERE event_type = ${type}` : sql``} ORDER BY seq`.execute(
    db,
  );
  return rows;
}

/** Ativa o TOTP do usuário logado; devolve o segredo. */
export async function enableTotp(a: App, accessToken: string): Promise<string> {
  const start = await a.http.post('/v1/me/mfa/totp').set(bearer(accessToken)).expect(201);
  await a.http
    .post('/v1/me/mfa/totp/confirm')
    .set(bearer(accessToken))
    .send({ code: a.otp(start.body.secret) })
    .expect(200);
  return start.body.secret as string;
}

/** Avança 31 s: o próximo código TOTP é de outro passo (o mesmo código não vale duas vezes). */
export const nextTotpStep = (a: App) => a.clock.advanceBy(31_000);
