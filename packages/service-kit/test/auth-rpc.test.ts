import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VirtualClock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Authenticator,
  HttpError,
  ownedBy,
  RpcClient,
  RpcClientError,
  ServiceTokenProvider,
} from '../src/index.js';
import { sleep, testService } from './helpers.js';

const ISSUER = 'https://identity.broker.localhost';
const AUDIENCE = 'broker-api';
const clock = new VirtualClock(Instant.parse('2026-10-16T13:00:00Z'));
let privateKey: CryptoKey;
let jwk: JWK;

async function token(
  claims: Record<string, unknown>,
  opts: { expiresIn?: number; key?: CryptoKey; issuer?: string } = {},
): Promise<string> {
  const now = Math.floor(clock.now().epochMillis / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expiresIn ?? 600))
    .sign(opts.key ?? privateKey);
}

const orders = [
  { id: 'o-1', accountId: 'acc-A', symbol: 'PETR4' },
  { id: 'o-2', accountId: 'acc-B', symbol: 'VALE3' },
];

function app() {
  const authenticator = new Authenticator({
    jwks: createLocalJWKSet({ keys: [jwk] }),
    issuer: ISSUER,
    audience: AUDIENCE,
    clock,
  });
  const { service } = testService({ authenticator });
  service.route({
    method: 'get',
    path: '/v1/me/orders/:id',
    auth: { scopes: ['orders:read'] },
    handler: async (req, ctx) => {
      // Autorização por propriedade no caso de uso (RN-BE-012): ordem alheia = inexistente.
      const order = ownedBy(
        orders.find((o) => o.id === (req.params as { id: string }).id),
        ctx.accountId,
      );
      return { body: order };
    },
  });
  service.route({
    method: 'post',
    path: '/internal/v1/pre-trade-checks',
    auth: { scopes: ['risk:pretrade'], principal: 'service' },
    idempotent: false,
    handler: async (_req, ctx) => ({ body: { decision: 'APPROVED', caller: ctx.actor } }),
  });
  service.route({
    method: 'post',
    path: '/backoffice/v1/adjustments',
    auth: { roles: ['FINANCE_OPERATOR'] },
    idempotent: false,
    handler: async () => ({ status: 201, body: { ok: true } }),
  });
  return service;
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
});

describe('autenticação e autorização (RN-AUTHZ-001/002)', () => {
  it('RN-AUTHZ-001: sem token → 401 com WWW-Authenticate; token inválido ou expirado → 401', async () => {
    const service = app();
    const none = await request(service.app).get('/v1/me/orders/o-1').expect(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect(none.body.code).toBe('UNAUTHENTICATED');

    const forged = await token(
      { sub: 'u-1', account_id: 'acc-A', scope: 'orders:read' },
      { key: (await generateKeyPair('ES256')).privateKey },
    );
    await request(service.app)
      .get('/v1/me/orders/o-1')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
    const otherIssuer = await token(
      { sub: 'u-1', scope: 'orders:read' },
      { issuer: 'https://evil' },
    );
    await request(service.app)
      .get('/v1/me/orders/o-1')
      .set('Authorization', `Bearer ${otherIssuer}`)
      .expect(401);

    // A validade é conferida no relógio do ambiente: avançar 11 min expira um token de 10 min.
    const valid = await token({ sub: 'u-1', account_id: 'acc-A', scope: 'orders:read' });
    await request(service.app)
      .get('/v1/me/orders/o-1')
      .set('Authorization', `Bearer ${valid}`)
      .expect(200);
    clock.advanceBy(11 * 60_000);
    await request(service.app)
      .get('/v1/me/orders/o-1')
      .set('Authorization', `Bearer ${valid}`)
      .expect(401);
  });

  it('RN-AUTHZ-002: ordem de outra conta responde 404, igual a uma inexistente', async () => {
    const service = app();
    const t = await token({
      sub: 'u-1',
      realm: 'customers',
      account_id: 'acc-A',
      scope: 'orders:read',
    });
    const mine = await request(service.app)
      .get('/v1/me/orders/o-1')
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(mine.body).toMatchObject({ id: 'o-1', accountId: 'acc-A' });
    const others = await request(service.app)
      .get('/v1/me/orders/o-2')
      .set('Authorization', `Bearer ${t}`)
      .expect(404);
    const missing = await request(service.app)
      .get('/v1/me/orders/o-999')
      .set('Authorization', `Bearer ${t}`)
      .expect(404);
    expect({ ...others.body, correlationId: '', instance: '' }).toEqual({
      ...missing.body,
      correlationId: '',
      instance: '',
    });
  });

  it('escopo ausente → 403 INSUFFICIENT_SCOPE; papel errado → 403', async () => {
    const service = app();
    const t = await token({ sub: 'u-1', account_id: 'acc-A', scope: 'portfolio:read' });
    const res = await request(service.app)
      .get('/v1/me/orders/o-1')
      .set('Authorization', `Bearer ${t}`)
      .expect(403);
    expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
    const operator = await token({ sub: 'op-1', realm: 'backoffice', roles: ['SUPPORT'] });
    await request(service.app)
      .post('/backoffice/v1/adjustments')
      .set('Authorization', `Bearer ${operator}`)
      .expect(403);
    const finance = await token({ sub: 'op-2', realm: 'backoffice', roles: ['FINANCE_OPERATOR'] });
    await request(service.app)
      .post('/backoffice/v1/adjustments')
      .set('Authorization', `Bearer ${finance}`)
      .expect(201);
  });

  it('RN-API-050: rota interna aceita só token de serviço com o escopo; usuário com o mesmo escopo é recusado', async () => {
    const service = app();
    const svc = await token({
      sub: 'oms-service',
      realm: 'services',
      client_id: 'oms-service',
      scope: 'risk:pretrade',
    });
    const ok = await request(service.app)
      .post('/internal/v1/pre-trade-checks')
      .set('Authorization', `Bearer ${svc}`)
      .expect(200);
    expect(ok.body.caller).toEqual({ type: 'SERVICE', id: 'oms-service' });
    const user = await token({ sub: 'u-1', account_id: 'acc-A', scope: 'risk:pretrade' });
    await request(service.app)
      .post('/internal/v1/pre-trade-checks')
      .set('Authorization', `Bearer ${user}`)
      .expect(403);
  });

  it('RN-AUTHZ-001: rota sem política de acesso nem chega a ser registrada', () => {
    const service = app();
    expect(() =>
      service.route({ method: 'get', path: '/x', handler: async () => ({}) } as never),
    ).toThrow(/sem política de acesso/);
  });
});

describe('token de serviço (client credentials)', () => {
  it('obtém o token com as credenciais e o reaproveita até perto de expirar', async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      calls++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        expect(req.headers.authorization).toBe(
          `Basic ${Buffer.from('oms-service:s3cr3t').toString('base64')}`,
        );
        expect(new URLSearchParams(body).get('scope')).toBe('risk:pretrade');
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ access_token: `tok-${calls}`, expires_in: 300, token_type: 'Bearer' }),
        );
      });
    }).listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/token`;
    const provider = new ServiceTokenProvider({
      tokenUrl: url,
      clientId: 'oms-service',
      clientSecret: 's3cr3t',
      scopes: ['risk:pretrade'],
      clock,
    });
    expect(await provider.token()).toBe('tok-1');
    expect(await provider.token()).toBe('tok-1');
    clock.advanceBy(280_000); // passou do limite de renovação (30 s antes de expirar)
    expect(await provider.token()).toBe('tok-2');
    server.close();
  });
});

describe('cliente RPC (RN-ARQ-002, D11)', () => {
  let server: Server;
  let base: string;
  let delayMs = 0;
  let hits = 0;
  const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      seenHeaders.push(req.headers);
      if (req.url === '/v1/bad-request') {
        res.statusCode = 422;
        res.end(JSON.stringify({ code: 'INVALID' }));
        return;
      }
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      }, delayMs);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const client = (overrides: Partial<ConstructorParameters<typeof RpcClient>[0]> = {}) =>
    new RpcClient({
      name: 'risk',
      baseUrl: base,
      timeoutMs: 100,
      retries: 2,
      breaker: { volumeThreshold: 3, resetTimeoutMs: 500 },
      ...overrides,
    });

  it('chamada normal com timeout explícito e correlação', async () => {
    delayMs = 0;
    const rpc = client();
    const res = await rpc.call<{ ok: boolean }>({ method: 'GET', path: '/v1/limits' });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    await rpc.close();
  });

  it('RN-ARQ-002: retentativa só em operação idempotente', async () => {
    delayMs = 300; // acima do timeout de 100 ms
    const rpc = client({ breaker: { volumeThreshold: 100 } });
    hits = 0;
    await expect(rpc.call({ method: 'POST', path: '/v1/holds', body: {} })).rejects.toMatchObject({
      status: 503,
      code: 'RISK_UNAVAILABLE',
    });
    expect(hits).toBe(1); // POST sem chave de idempotência: uma tentativa só
    hits = 0;
    await expect(
      rpc.call({ method: 'POST', path: '/v1/holds', body: {}, idempotencyKey: 'hold-1' }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(hits).toBe(3); // com chave: 1 + 2 retentativas
    expect(seenHeaders.at(-1)!['idempotency-key']).toBe('hold-1');
    await rpc.close();
  });

  it('spec: dependência lenta → o disjuntor abre e as chamadas seguintes falham rápido até a meia-abertura', async () => {
    delayMs = 300;
    const rpc = client({ retries: 0 });
    for (let i = 0; i < 3; i++)
      await expect(rpc.call({ method: 'GET', path: '/v1/limits' })).rejects.toMatchObject({
        code: 'RISK_UNAVAILABLE',
      });
    expect(rpc.breaker.opened).toBe(true);

    hits = 0;
    const started = performance.now();
    await expect(rpc.call({ method: 'GET', path: '/v1/limits' })).rejects.toMatchObject({
      status: 503,
      code: 'RISK_UNAVAILABLE',
    });
    expect(performance.now() - started).toBeLessThan(30); // falhou na hora, sem esperar os 100 ms
    expect(hits).toBe(0); // nem chegou à dependência

    // A dependência se recupera; depois do resetTimeout, a meia-abertura deixa uma chamada passar e fecha.
    delayMs = 0;
    await sleep(600);
    expect(rpc.breaker.halfOpen).toBe(true);
    await expect(rpc.call({ method: 'GET', path: '/v1/limits' })).resolves.toMatchObject({
      status: 200,
    });
    expect(rpc.breaker.closed).toBe(true);
    await rpc.close();
  });

  it('resposta 4xx é resultado (não abre o disjuntor nem é repetida)', async () => {
    const rpc = client({ breaker: { volumeThreshold: 1 } });
    hits = 0;
    for (let i = 0; i < 3; i++)
      await expect(rpc.call({ method: 'GET', path: '/v1/bad-request' })).rejects.toBeInstanceOf(
        RpcClientError,
      );
    expect(hits).toBe(3);
    expect(rpc.breaker.closed).toBe(true);
    await rpc.close();
  });
});
