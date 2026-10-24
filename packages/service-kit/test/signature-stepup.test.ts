import { VirtualClock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Authenticator, SignatureVerifier } from '../src/index.js';
import { testService } from './helpers.js';

const ISSUER = 'https://auth.broker.test';
const AUDIENCE = 'broker-api';
const clock = new VirtualClock(Instant.parse('2026-10-16T13:00:00Z'));
const nowSec = () => Math.floor(clock.now().epochMillis / 1000);
let key: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
const revokedSessions = new Set<string>();
const revokedSignatures = new Set<string>();

const sign = (claims: Record<string, unknown>, typ: string, sub: string, jti: string, ttl = 600) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setJti(jti)
    .setIssuedAt(nowSec())
    .setExpirationTime(nowSec() + ttl)
    .sign(key);

const access = (sessionId: string, mfaAgoSec?: number) =>
  sign(
    {
      realm: 'customers',
      scope: 'orders:write',
      session_id: sessionId,
      ...(mfaAgoSec !== undefined ? { mfa_time: nowSec() - mfaAgoSec } : {}),
    },
    'at+jwt',
    'user-1',
    `at-${sessionId}`,
  );
const signature = (sessionId: string, scope: string, jti = `sig-${scope}-${sessionId}`) =>
  sign({ session_id: sessionId, sig_scope: scope }, 'sig+jwt', 'user-1', jti, 300);

function app() {
  const authenticator = new Authenticator({
    jwks,
    issuer: ISSUER,
    audience: AUDIENCE,
    clock,
    revocation: { isSessionRevoked: async (id) => revokedSessions.has(id) },
  });
  const signatureVerifier = new SignatureVerifier({
    jwks,
    issuer: ISSUER,
    audience: AUDIENCE,
    clock,
    revocation: { isSignatureRevoked: async (jti) => revokedSignatures.has(jti) },
  });
  const { service } = testService({ authenticator, signatureVerifier, clock });
  service.route({
    method: 'post',
    path: '/withdrawals',
    auth: {},
    idempotent: false,
    signature: 'WITHDRAWALS',
    handler: async () => ({ status: 201 }),
  });
  service.route({
    method: 'post',
    path: '/mfa/remove',
    auth: {},
    idempotent: false,
    stepUp: true,
    handler: async () => ({ status: 204 }),
  });
  return request(service.app);
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  key = pair.privateKey;
  const pub: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
  jwks = createLocalJWKSet({ keys: [pub] });
});

describe('lista de revogação no Authenticator (RN-AUTH-013)', () => {
  it('token de sessão revogada é recusado antes de expirar; token de assinatura não vale como access', async () => {
    const http = app();
    const token = await access('s-revoked');
    const sig = await signature('s-revoked', 'WITHDRAWALS');
    await http
      .post('/withdrawals')
      .auth(token, { type: 'bearer' })
      .set('X-Trading-Signature', sig)
      .expect(201);
    revokedSessions.add('s-revoked');
    await http
      .post('/withdrawals')
      .auth(token, { type: 'bearer' })
      .set('X-Trading-Signature', sig)
      .expect(401);
    await http
      .post('/withdrawals')
      .auth(await signature('s-x', 'ORDERS'), { type: 'bearer' })
      .expect(401);
  });
});

describe('rota com assinatura (RN-SIG-002/003)', () => {
  it('escopo, sessão e revogação do token de assinatura', async () => {
    const http = app();
    const token = await access('s-1');
    const call = (sig?: string) => {
      const r = http.post('/withdrawals').auth(token, { type: 'bearer' });
      return sig ? r.set('X-Trading-Signature', sig) : r;
    };
    expect((await call()).body.code).toBe('TRADING_SIGNATURE_REQUIRED');
    expect((await call(await signature('s-1', 'ORDERS'))).body.code).toBe(
      'TRADING_SIGNATURE_REQUIRED',
    );
    expect((await call(await signature('s-2', 'WITHDRAWALS'))).status).toBe(403);
    await call(await signature('s-1', 'WITHDRAWALS', 'jti-ok')).expect(201);
    revokedSignatures.add('jti-ok');
    expect((await call(await signature('s-1', 'WITHDRAWALS', 'jti-ok'))).status).toBe(403);
  });
});

describe('rota com step-up (RN-AUTHZ-003)', () => {
  it('MFA há 14 min passa; há 20 min ou nunca, 403 STEP_UP_REQUIRED', async () => {
    const http = app();
    await http
      .post('/mfa/remove')
      .auth(await access('s-a', 14 * 60), { type: 'bearer' })
      .expect(204);
    const old = await http
      .post('/mfa/remove')
      .auth(await access('s-b', 20 * 60), { type: 'bearer' });
    expect(old.status).toBe(403);
    expect(old.body.code).toBe('STEP_UP_REQUIRED');
    expect(
      (await http.post('/mfa/remove').auth(await access('s-c'), { type: 'bearer' })).body.code,
    ).toBe('STEP_UP_REQUIRED');
  });
});
