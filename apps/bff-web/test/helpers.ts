import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest, type DatabaseConfig } from '@broker/persistence';
import { Authenticator, createLogger } from '@broker/service-kit';
import { testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import express from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import request from 'supertest';
import { createBffWeb } from '../src/app.js';
import { migrations } from '../src/migrations.js';

export const ISSUER = 'https://auth.broker.test';
export const AUDIENCE = 'broker-api';
export const WEB = { 'X-Client-Channel': 'WEB', 'X-Client-Version': '1.0.0' };

export interface Env {
  pg: StartedPostgres;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  owner: Kysely<unknown>;
}

export async function startEnv(): Promise<Env> {
  const pg = await startPostgres(['bff_web']);
  const owner = createDatabase(databaseConfig(pg, 'bff_web', 'migrator'));
  await migrateToLatest(owner, migrations);
  const database = databaseConfig(pg, 'bff_web', 'app');
  return { pg, db: createDatabase(database), database, owner };
}

export async function stopEnv(env: Env | undefined) {
  await env?.db.destroy();
  await env?.owner.destroy();
  await env?.pg.container.stop();
}

export interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/**
 * Identity e serviços falsos num só servidor: o identity confere o PKCE de verdade (S256) e emite
 * access tokens assinados; os demais ecoam o que receberam.
 */
export class FakeUpstreams {
  seen: Seen[] = [];
  revoked: string[] = [];
  private codes = new Map<string, { challenge: string; userId: string }>();
  private refresh = new Map<string, { userId: string; sessionId: string }>();
  private mfa = new Map<string, string>();
  server!: Server;
  url!: string;
  readonly accountId = uuidv7();

  constructor(
    private readonly sign: (claims: {
      sub: string;
      sessionId: string;
      accountId: string;
      mfa?: boolean;
    }) => Promise<string>,
  ) {}

  async start() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      this.seen.push({
        method: req.method,
        path: req.path,
        query: req.query as Record<string, string>,
        headers: req.headers,
        body: req.body,
      });
      next();
    });
    app.post('/v1/oauth/authorize', (req, res) => {
      const b = req.body as Record<string, string>;
      if (b['password'] !== 'senha-certa') {
        res.status(401).json({
          type: 'about:blank',
          status: 401,
          code: 'INVALID_CREDENTIALS',
          title: 'Credenciais inválidas',
        });
        return;
      }
      const userId = uuidv7();
      if (b['email']?.startsWith('mfa')) {
        const mfaToken = randomBytes(16).toString('hex');
        this.mfa.set(mfaToken, `${userId}|${b['code_challenge']}`);
        res.json({
          status: 'MFA_REQUIRED',
          mfaToken,
          methods: ['TOTP'],
          expiresAt: '2026-10-27T14:05:00.000Z',
        });
        return;
      }
      res.json({
        status: 'AUTHORIZED',
        code: this.issueCode(b['code_challenge']!, userId),
        redirectUri: b['redirect_uri'],
      });
    });
    app.post('/v1/oauth/authorize/mfa', (req, res) => {
      const b = req.body as Record<string, string>;
      const pending = this.mfa.get(b['mfa_token']!);
      if (!pending || b['code'] !== '123456') {
        res.status(401).json({
          type: 'about:blank',
          status: 401,
          code: 'INVALID_MFA',
          title: 'Código inválido',
        });
        return;
      }
      const [userId, challenge] = pending.split('|');
      res.json({
        status: 'AUTHORIZED',
        code: this.issueCode(challenge!, userId!),
        redirectUri: 'x',
      });
    });
    app.post('/v1/oauth/token', async (req, res) => {
      const b = req.body as Record<string, string>;
      if (b['grant_type'] === 'authorization_code') {
        const code = this.codes.get(b['code']!);
        const ok =
          code &&
          b['client_id'] === 'bff-web' &&
          createHash('sha256')
            .update(b['code_verifier'] ?? '')
            .digest('base64url') === code.challenge;
        if (!ok) return void res.status(400).json({ error: 'invalid_grant' });
        this.codes.delete(b['code']!);
        res.json(await this.tokens(code.userId, uuidv7()));
        return;
      }
      if (b['grant_type'] === 'refresh_token') {
        const r = this.refresh.get(b['refresh_token']!);
        if (!r) return void res.status(400).json({ error: 'invalid_grant' });
        this.refresh.delete(b['refresh_token']!);
        res.json(await this.tokens(r.userId, r.sessionId));
        return;
      }
      res.status(400).json({ error: 'unsupported_grant_type' });
    });
    app.post('/v1/oauth/revoke', (req, res) => {
      this.revoked.push((req.body as { token: string }).token);
      res.status(200).json({});
    });
    app.post('/v1/me/step-up', async (_req, res) => {
      res.json({
        access_token: 'stepped-up-token',
        token_type: 'Bearer',
        expires_in: 600,
        scope: 'x',
      });
    });
    app.post('/v1/me/trading-signature/verify', (req, res) => {
      const b = req.body as { secret: string; scope: string };
      if (b.secret !== '123456') {
        res.status(401).json({
          type: 'about:blank',
          status: 401,
          code: 'INVALID_SIGNATURE',
          title: 'Assinatura inválida',
        });
        return;
      }
      res.json({
        signatureToken: `sig-${b.scope}-${uuidv7()}`,
        scope: b.scope,
        expiresAt: '2026-10-27T14:05:00.000Z',
      });
    });
    app.get('/v1/me/profile', (_req, res) =>
      res.json({ customerId: uuidv7(), fullName: 'Maria Souza' }),
    );
    app.get('/v1/me/balances', (_req, res) =>
      res.json({ accountId: this.accountId, settled: '100.00', asOf: '2026-10-27T13:59:58.000Z' }),
    );
    app.get('/v1/me/notifications', (_req, res) => res.json({ items: [], unreadCount: 3 }));
    app.post('/v1/me/deposits', (req, res) =>
      res
        .status(201)
        .json({ id: uuidv7(), status: 'PENDING', amount: (req.body as { amount: string }).amount }),
    );
    app.all('/{*path}', (req, res) =>
      res.json({
        echo: { method: req.method, path: req.path, query: req.query, body: req.body ?? null },
      }),
    );
    this.server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  last(path: string) {
    return [...this.seen].reverse().find((s) => s.path === path);
  }

  private issueCode(challenge: string, userId: string) {
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, { challenge, userId });
    return code;
  }

  private async tokens(userId: string, sessionId: string) {
    const refresh = `rt-${randomBytes(12).toString('hex')}`;
    this.refresh.set(refresh, { userId, sessionId });
    return {
      access_token: await this.sign({ sub: userId, sessionId, accountId: this.accountId }),
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'profile:read',
      refresh_token: refresh,
    };
  }
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

export async function app(env: Env) {
  const clock = testClock('2026-10-27T14:00:00Z');
  const now = () => Math.floor(clock.now().epochMillis / 1000);
  const key = await signingKey();
  const sign = (c: { sub: string; sessionId: string; accountId: string }) =>
    new SignJWT({
      realm: 'customers',
      roles: [],
      scope: 'profile:read',
      session_id: c.sessionId,
      account_id: c.accountId,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
      .setSubject(c.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now())
      .setExpirationTime(now() + 600)
      .setJti(uuidv7())
      .sign(key.key);
  const upstream = new FakeUpstreams(sign);
  await upstream.start();
  const a = await createBffWeb({
    config: {
      SERVICE_NAME: 'bff-web',
      SERVICE_VERSION: '0',
      GIT_COMMIT: 'x',
      ENVIRONMENT: 'test',
      PORT: 0,
      LOG_LEVEL: 'fatal',
      SHUTDOWN_TIMEOUT_MS: 0,
    },
    clock,
    logger: createLogger({
      service: 'bff-web',
      environment: 'test',
      version: '0',
      level: 'fatal',
      clock,
      destination: new Writable({ write: (_c, _e, cb) => cb() }),
    }),
    db: env.db,
    database: env.database,
    newId: uuidv7,
    authenticator: new Authenticator({
      jwks: createLocalJWKSet({ keys: [key.jwk] }),
      issuer: ISSUER,
      audience: AUDIENCE,
      clock,
    }),
    upstreams: {
      identity: upstream.url,
      customer: upstream.url,
      ledger: upstream.url,
      referenceData: upstream.url,
      marketData: upstream.url,
      notification: upstream.url,
    },
    clientId: 'bff-web',
    redirectUri: 'https://app.broker.test/auth/callback',
    csrfSecret: randomBytes(32),
    loginKey: randomBytes(32),
  });
  return { ...a, http: request(a.service.app), upstream, clock, sign };
}

/** `Set-Cookie` da resposta como mapa nome → linha completa. */
export function setCookies(res: { headers: Record<string, unknown> }): Map<string, string> {
  const raw = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  return new Map(raw.map((c) => [c.slice(0, c.indexOf('=')), c]));
}

/** Os cookies como o navegador os mandaria de volta (só nome=valor, sem os apagados). */
export function jar(...responses: { headers: Record<string, unknown> }[]): string {
  const values = new Map<string, string>();
  for (const res of responses)
    for (const [name, line] of setCookies(res)) {
      const value = line.slice(name.length + 1, line.indexOf(';'));
      if (/Max-Age=0/.test(line)) values.delete(name);
      else values.set(name, value);
    }
  return [...values].map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function login(a: App, email = 'maria@exemplo.com') {
  const res = await a.http
    .post('/v1/auth/login')
    .set(WEB)
    .send({ email, password: 'senha-certa' })
    .expect(200);
  return { res, cookie: jar(res), csrf: res.body.csrfToken as string };
}

export async function outbox(db: Kysely<unknown>, type: string) {
  const { rows } = await sql<{
    payload: Record<string, unknown>;
    partition_key: string;
    headers: Record<string, unknown>;
  }>`
    SELECT payload, partition_key, headers FROM outbox_event WHERE event_type = ${type} ORDER BY seq`.execute(
    db,
  );
  return rows;
}
