// 19.1 api-gateway: token (JWKS e revogação), rate limit no Valkey, CORS, corpo, headers,
// correlação, 426 e roteamento por canal (RN-API §3, §6, §7).
import { uuidv7 } from '@broker/ids';
import { Authenticator, createLogger, RevocationList } from '@broker/service-kit';
import { testClock } from '@broker/testing';
import { startValkey, type StartedValkey } from '@broker/testing/containers';
import express from 'express';
import { Valkey } from 'iovalkey';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGateway, type GatewayDeps } from '../src/app.js';
import { classify, progressiveDelayMs, versionBelow } from '../src/edge.js';
import { ValkeyRateLimiter } from '../src/rate-limit.js';

const ISSUER = 'https://auth.broker.test';
const AUDIENCE = 'broker-api';
const WEB = { 'X-Client-Channel': 'WEB', 'X-Client-Version': '1.2.0' };

let valkeyC: StartedValkey;
let valkey: Valkey;
let key: { priv: CryptoKey; jwk: JWK };
let bff: Server;
let bffUrl: string;
/** O que o BFF falso recebeu por último. */
let seen: { method: string; url: string; headers: Record<string, unknown>; body: unknown }[] = [];
/** Status do login no BFF falso. */
let loginStatus = 401;

beforeAll(async () => {
  valkeyC = await startValkey();
  valkey = new Valkey({ host: valkeyC.host, port: valkeyC.port });
  const pair = await generateKeyPair('ES256', { extractable: true });
  key = {
    priv: pair.privateKey,
    jwk: { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' },
  };

  const fake = express();
  fake.use(express.json({ limit: '1mb' }));
  fake.all('/{*path}', (req, res) => {
    seen.push({ method: req.method, url: req.originalUrl, headers: req.headers, body: req.body });
    if (req.path === '/v1/auth/login') {
      res.status(loginStatus).json({ status: loginStatus === 200 ? 'AUTHENTICATED' : 'FAILED' });
      return;
    }
    res.setHeader('Set-Cookie', ['a=1; HttpOnly', 'b=2; HttpOnly']);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, path: req.originalUrl });
  });
  bff = await new Promise<Server>((resolve) => {
    const s = fake.listen(0, () => resolve(s));
  });
  bffUrl = `http://127.0.0.1:${(bff.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  bff?.close();
  await valkey?.quit();
  await valkeyC?.container.stop();
});

beforeEach(async () => {
  seen = [];
  loginStatus = 401;
  await valkey.flushall();
});

function gateway(over: Partial<GatewayDeps> = {}) {
  const clock = testClock('2026-10-27T14:00:00Z');
  const logger = createLogger({
    service: 'api-gateway',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const delays: number[] = [];
  const { service } = createGateway({
    config: {
      SERVICE_NAME: 'api-gateway',
      SERVICE_VERSION: '0',
      GIT_COMMIT: 'x',
      ENVIRONMENT: 'test',
      PORT: 0,
      LOG_LEVEL: 'fatal',
      SHUTDOWN_TIMEOUT_MS: 0,
    },
    clock,
    logger,
    authenticator: new Authenticator({
      jwks: createLocalJWKSet({ keys: [key.jwk] }),
      issuer: ISSUER,
      audience: AUDIENCE,
      clock,
      revocation: new RevocationList(valkey),
    }),
    limiter: new ValkeyRateLimiter(valkey),
    bffs: { WEB: bffUrl },
    minVersions: { WEB: '1.1.0', MOBILE: '2.0.0' },
    allowedOrigins: ['https://app.broker.test'],
    sleep: async (ms) => void delays.push(ms),
    ...over,
  });
  return { http: request(service.app), clock, delays };
}

async function token(
  clock: ReturnType<typeof testClock>,
  over: { realm?: string; sessionId?: string; sub?: string } = {},
) {
  const now = Math.floor(clock.now().epochMillis / 1000);
  return new SignJWT({
    realm: over.realm ?? 'customers',
    roles: [],
    scope: 'profile:read',
    session_id: over.sessionId ?? uuidv7(),
    account_id: uuidv7(),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setSubject(over.sub ?? uuidv7())
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .setJti(uuidv7())
    .sign(key.priv);
}

describe('regras da borda', () => {
  it('classificação, versão e atraso progressivo', () => {
    expect(classify('POST', '/v1/auth/login')).toMatchObject({ public: true, credentials: true });
    expect(classify('POST', '/v1/auth/token/refresh')).toMatchObject({
      public: true,
      credentials: false,
    });
    expect(classify('GET', '/v1/auth/session')).toMatchObject({ public: false, bucket: 'READ' });
    expect(classify('POST', '/v1/me/deposits')).toMatchObject({ public: false, bucket: 'COMMAND' });
    expect(classify('POST', '/v1/me/reports').report).toBe(true);
    expect(versionBelow('1.0.9', '1.1.0')).toBe(true);
    expect(versionBelow('1.10.0', '1.9.9')).toBe(false);
    expect(versionBelow('1.1.0', '1.1.0')).toBe(false);
    expect([0, 2, 3, 4, 10].map(progressiveDelayMs)).toEqual([0, 0, 250, 500, 8000]);
  });
});

describe('19.1 api-gateway', () => {
  it('RN-API §6: o 11º login do mesmo IP no minuto recebe 429 com Retry-After e RateLimit-*', async () => {
    const g = gateway();
    for (let i = 1; i <= 10; i++) {
      const r = await g.http
        .post('/v1/auth/login')
        .set(WEB)
        .send({ email: 'x@y.z', password: 'p' });
      expect(r.status).toBe(401);
      expect(r.headers['ratelimit-remaining']).toBe(String(10 - i));
    }
    const blocked = await g.http
      .post('/v1/auth/login')
      .set(WEB)
      .send({ email: 'x@y.z', password: 'p' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-limit']).toBe('10');
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    // Só 10 chegaram ao BFF; a janela desliza: um minuto depois, libera.
    expect(seen).toHaveLength(10);
    g.clock.advanceBy(60_001);
    expect((await g.http.post('/v1/auth/login').set(WEB).send({})).status).toBe(401);
    // Atraso progressivo a partir da 3ª falha seguida (RN-AUTH-002).
    expect(g.delays.slice(0, 3)).toEqual([250, 500, 1000]);
    expect(g.delays.at(-1)).toBe(8000);
    loginStatus = 200;
    await g.http.post('/v1/auth/login').set(WEB).send({}).expect(200);
    const before = g.delays.length;
    await g.http.post('/v1/auth/login').set(WEB).send({}).expect(200);
    expect(g.delays.length).toBe(before);
  });

  it('rotas autenticadas: sem token 401; sessão revogada 401 pela lista de revogação; válido passa', async () => {
    const g = gateway();
    await g.http.get('/v1/me/balances').set(WEB).expect(401);
    const sessionId = uuidv7();
    const t = await token(g.clock, { sessionId });
    const ok = await g.http
      .get('/v1/me/balances')
      .set(WEB)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    expect(ok.body.path).toBe('/v1/me/balances');
    await new RevocationList(valkey).revokeSession(sessionId, 600_000);
    const revoked = await g.http
      .get('/v1/me/balances')
      .set(WEB)
      .set('Authorization', `Bearer ${t}`);
    expect(revoked.status).toBe(401);
    expect(revoked.body.detail).toBe('Sessão encerrada.');
    expect(seen).toHaveLength(1);
  });

  it('web pelo cookie HttpOnly; token de backoffice no canal web é 403', async () => {
    const g = gateway();
    const t = await token(g.clock);
    await g.http.get('/v1/me/profile').set(WEB).set('Cookie', `__Host-broker_at=${t}`).expect(200);
    // O cookie só vale para o canal web.
    await g.http
      .get('/v1/me/profile')
      .set({ 'X-Client-Channel': 'MOBILE', 'X-Client-Version': '2.0.0' })
      .set('Cookie', `__Host-broker_at=${t}`)
      .expect(401);
    const bo = await token(g.clock, { realm: 'backoffice' });
    const r = await g.http.get('/v1/me/profile').set(WEB).set('Authorization', `Bearer ${bo}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('REALM_NOT_ALLOWED');
  });

  it('limite por usuário: 120 comandos/min e 10 relatórios/h', async () => {
    const g = gateway({ limits: { COMMAND: { limit: 3, windowMs: 60_000 } } });
    const sub = uuidv7();
    const t = await token(g.clock, { sub });
    const post = (path: string) =>
      g.http
        .post(path)
        .set(WEB)
        .set('Authorization', `Bearer ${t}`)
        .set('Idempotency-Key', uuidv7())
        .send({});
    for (let i = 0; i < 3; i++) await post('/v1/me/deposits').expect(200);
    expect((await post('/v1/me/deposits')).status).toBe(429);
    // Leitura tem o próprio balde.
    await g.http.get('/v1/me/balances').set(WEB).set('Authorization', `Bearer ${t}`).expect(200);

    const r = gateway({ limits: { REPORT: { limit: 2, windowMs: 3_600_000 } } });
    const t2 = await token(r.clock);
    const report = () =>
      r.http.post('/v1/me/reports').set(WEB).set('Authorization', `Bearer ${t2}`).send({});
    await report().expect(200);
    await report().expect(200);
    const third = await report();
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(3500);
  });

  it('correlação gerada e devolvida; traceparent propagado ou criado; identidade e headers repassados', async () => {
    const g = gateway();
    const t = await token(g.clock);
    const res = await g.http
      .get('/v1/me/balances?x=1')
      .set(WEB)
      .set('Authorization', `Bearer ${t}`)
      .expect(200);
    const correlation = res.headers['x-correlation-id'] as string;
    expect(correlation).toMatch(/^[0-9a-f-]{36}$/);
    const fwd = seen[0]!;
    expect(fwd.url).toBe('/v1/me/balances?x=1');
    expect(fwd.headers['x-correlation-id']).toBe(correlation);
    expect(fwd.headers['authorization']).toBe(`Bearer ${t}`);
    expect(fwd.headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(fwd.headers['x-forwarded-proto']).toBe('https');

    const trace = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await g.http
      .get('/v1/me/balances')
      .set(WEB)
      .set('Authorization', `Bearer ${t}`)
      .set('X-Correlation-Id', 'abc-123')
      .set('traceparent', trace)
      .expect('X-Correlation-Id', 'abc-123');
    expect(seen[1]!.headers['traceparent']).toBe(trace);
    expect(seen[1]!.headers['x-correlation-id']).toBe('abc-123');
    // Vários Set-Cookie do BFF chegam separados.
    expect(res.headers['set-cookie']).toEqual(['a=1; HttpOnly', 'b=2; HttpOnly']);
  });

  it('RN-API-041: headers de segurança em toda resposta, inclusive erro', async () => {
    const g = gateway();
    for (const res of [
      await g.http.get('/v1/me/balances').set(WEB),
      await g.http.post('/v1/auth/login').set(WEB).send({}),
    ]) {
      expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['permissions-policy']).toContain('camera=()');
    }
  });

  it('426 abaixo da versão mínima; 400 sem canal ou versão; canal sem BFF 503', async () => {
    const g = gateway();
    const old = await g.http
      .post('/v1/auth/login')
      .set({ 'X-Client-Channel': 'WEB', 'X-Client-Version': '1.0.3' })
      .send({});
    expect(old.status).toBe(426);
    expect(old.body).toMatchObject({ code: 'UPGRADE_REQUIRED', title: 'Atualize o aplicativo' });
    expect(old.body.detail).toMatch(/Atualize para a 1\.1\.0/);
    expect((await g.http.post('/v1/auth/login').send({})).body.code).toBe(
      'CLIENT_HEADERS_REQUIRED',
    );
    expect(
      (
        await g.http
          .post('/v1/auth/login')
          .set({ 'X-Client-Channel': 'TV', 'X-Client-Version': '1.0.0' })
          .send({})
      ).status,
    ).toBe(400);
    const mobile = await g.http
      .post('/v1/auth/login')
      .set({ 'X-Client-Channel': 'MOBILE', 'X-Client-Version': '2.1.0' })
      .send({});
    expect(mobile.status).toBe(503);
    expect(mobile.body.code).toBe('CHANNEL_UNAVAILABLE');
    expect(seen).toEqual([]);
  });

  it('RN-API-040: CORS só para as origens configuradas; comando de outra origem é 403', async () => {
    const g = gateway();
    const ok = await g.http
      .options('/v1/me/balances')
      .set('Origin', 'https://app.broker.test')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.broker.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
    const bad = await g.http
      .options('/v1/me/balances')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    expect(bad.headers['access-control-allow-methods']).toBeUndefined();
    const cross = await g.http
      .post('/v1/auth/login')
      .set(WEB)
      .set('Origin', 'https://evil.example')
      .send({});
    expect(cross.status).toBe(403);
    expect(cross.body.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('RN-API-042: corpo acima de 64 KB é 413, salvo a exceção configurada; corpo não JSON é 415', async () => {
    const g = gateway({ bodyLimits: [{ prefix: '/v1/me/big', bytes: 256 * 1024 }] });
    const t = await token(g.clock);
    const big = { data: 'x'.repeat(70 * 1024) };
    const tooLarge = await g.http
      .post('/v1/me/deposits')
      .set(WEB)
      .set('Authorization', `Bearer ${t}`)
      .send(big);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.code).toBe('PAYLOAD_TOO_LARGE');
    await g.http
      .post('/v1/me/big')
      .set(WEB)
      .set('Authorization', `Bearer ${t}`)
      .send(big)
      .expect(200);
    const text = await g.http
      .post('/v1/me/deposits')
      .set(WEB)
      .set('Authorization', `Bearer ${t}`)
      .set('Content-Type', 'text/plain')
      .send('oi');
    expect(text.status).toBe(415);
  });

  it('RN-API-001: HTTP vindo do proxy é redirecionado para HTTPS', async () => {
    const g = gateway();
    const res = await g.http
      .get('/v1/me/balances?a=1')
      .set('X-Forwarded-Proto', 'http')
      .set('Host', 'api.broker.test')
      .expect(308);
    expect(res.headers['location']).toBe('https://api.broker.test/v1/me/balances?a=1');
  });

  it('IP do cliente: o anotado pelo proxy confiável, não o que o cliente escreveu', async () => {
    const g = gateway({ trustedProxyHops: 1 });
    // O cliente tenta trocar de IP a cada requisição; o Traefik anota o real (10.0.0.7).
    for (let i = 0; i < 10; i++)
      await g.http
        .post('/v1/auth/login')
        .set(WEB)
        .set('X-Forwarded-For', `1.2.3.${i}, 10.0.0.7`)
        .send({});
    const r = await g.http
      .post('/v1/auth/login')
      .set(WEB)
      .set('X-Forwarded-For', '9.9.9.9, 10.0.0.7')
      .send({});
    expect(r.status).toBe(429);
    expect(seen[0]!.headers['x-forwarded-for']).toBe('10.0.0.7');
  });
});
