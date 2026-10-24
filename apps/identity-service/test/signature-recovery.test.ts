// 13.5: assinatura eletrônica (escopo, validade, bloqueios 3/6), step-up por amr e recuperação de acesso.
import { createLogger, createService, requireStepUp } from '@broker/service-kit';
import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  app,
  bearer,
  enableTotp,
  login,
  nextTotpStep,
  outbox,
  register,
  startEnv,
  stopEnv,
  type App,
  type Env,
} from './helpers.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
  a = await app(env);
}, 180_000);
afterAll(() => stopEnv(env));

/** Um serviço do núcleo (OMS e ledger) com as verificações do service-kit (RN-SIG-002, RN-AUTHZ-003). */
function coreService() {
  const svc = createService({
    config: {
      SERVICE_NAME: 'core',
      SERVICE_VERSION: '0',
      GIT_COMMIT: 'x',
      ENVIRONMENT: 'test',
      PORT: 0,
      LOG_LEVEL: 'fatal',
      SHUTDOWN_TIMEOUT_MS: 0,
    },
    clock: a.clock,
    logger: createLogger({
      service: 'core',
      environment: 'test',
      version: '0',
      level: 'fatal',
      clock: a.clock,
      destination: new Writable({ write: (_c, _e, cb) => cb() }),
    }),
    authenticator: a.gateway,
    signatureVerifier: a.signatureVerifier,
  });
  svc.route({
    method: 'post',
    path: '/orders',
    auth: {},
    idempotent: false,
    signature: 'ORDERS',
    handler: async () => ({ status: 201 }),
  });
  // RN-SIG-005: cancelar ordem não exige assinatura.
  svc.route({
    method: 'post',
    path: '/orders/:id/cancel',
    auth: {},
    idempotent: false,
    handler: async () => ({ status: 202 }),
  });
  svc.route({
    method: 'post',
    path: '/withdrawals',
    auth: {},
    idempotent: false,
    signature: 'WITHDRAWALS',
    handler: async (req, ctx) => {
      // Saque acima de R$ 10 mil: step-up (MFA nos últimos 15 min) além da assinatura.
      if (Number((req.body as { amount: string }).amount) > 10_000)
        requireStepUp(ctx.mfaAt, a.clock.now());
      return { status: 201 };
    },
  });
  return request(svc.app);
}

const SECRET = '482913';

async function customerWithSignature(opts: { totp?: boolean } = {}) {
  const c = await register(a);
  let tokens = await login(a, c);
  let totpSecret: string | undefined;
  if (opts.totp) {
    totpSecret = await enableTotp(a, tokens.access_token);
    nextTotpStep(a);
    tokens = await login(a, c, { totpSecret });
  }
  await a.http
    .put('/v1/me/trading-signature')
    .set(bearer(tokens.access_token))
    .send({ secret: SECRET })
    .expect(204);
  return { ...c, tokens, totpSecret };
}

const sign = (access: string, scope: string, secret = SECRET, rememberInSession?: boolean) =>
  a.http
    .post('/v1/me/trading-signature/verify')
    .set(bearer(access))
    .send({ secret, scope, ...(rememberInSession !== undefined ? { rememberInSession } : {}) });

describe('13.5 assinatura eletrônica (RN-SIG-001..005)', () => {
  it('saque com token de escopo ORDERS → 403 TRADING_SIGNATURE_REQUIRED; cancelamento sem token é aceito', async () => {
    const c = await customerWithSignature();
    const core = coreService();
    const access = c.tokens.access_token;
    const orders = (await sign(access, 'ORDERS').expect(200)).body;
    expect(orders.scope).toBe('ORDERS');

    await core
      .post('/orders')
      .set(bearer(access))
      .set('X-Trading-Signature', orders.signatureToken)
      .expect(201);
    const withdrawal = await core
      .post('/withdrawals')
      .set(bearer(access))
      .set('X-Trading-Signature', orders.signatureToken)
      .send({ amount: '100.00' });
    expect(withdrawal.status).toBe(403);
    expect(withdrawal.body.code).toBe('TRADING_SIGNATURE_REQUIRED');
    expect((await core.post('/orders').set(bearer(access))).body.code).toBe(
      'TRADING_SIGNATURE_REQUIRED',
    );
    await core.post('/orders/o-1/cancel').set(bearer(access)).expect(202);

    const w = (await sign(access, 'WITHDRAWALS').expect(200)).body;
    await core
      .post('/withdrawals')
      .set(bearer(access))
      .set('X-Trading-Signature', w.signatureToken)
      .send({ amount: '100.00' })
      .expect(201);
    expect(
      (await outbox(env.db, 'identity.trading_signature_changed')).map((e) => e.payload['userId']),
    ).toContain(c.userId);
  });

  it('o token vale 5 min, é da sessão (outra sessão não usa) e "lembrar" estende só ordens até 8 h', async () => {
    const c = await customerWithSignature();
    const core = coreService();
    const other = await login(a, c, { deviceId: 'outro-aparelho-1' });
    const t = (await sign(c.tokens.access_token, 'WITHDRAWALS').expect(200)).body;
    await core
      .post('/withdrawals')
      .set(bearer(other.access_token))
      .set('X-Trading-Signature', t.signatureToken)
      .send({ amount: '1' })
      .expect(403);
    a.clock.advanceBy(5 * 60_000 + 1000);
    const fresh = (
      await a.http.post('/v1/oauth/token').type('form').send({
        grant_type: 'refresh_token',
        refresh_token: c.tokens.refresh_token,
        client_id: 'bff-web',
      })
    ).body;
    await core
      .post('/withdrawals')
      .set(bearer(fresh.access_token))
      .set('X-Trading-Signature', t.signatureToken)
      .send({ amount: '1' })
      .expect(403);

    const remembered = (await sign(fresh.access_token, 'ORDERS', SECRET, true).expect(200)).body;
    expect(Date.parse(remembered.expiresAt) - a.clock.now().epochMillis).toBe(8 * 3_600_000);
    const notForWithdrawals = (
      await sign(fresh.access_token, 'WITHDRAWALS', SECRET, true).expect(200)
    ).body;
    expect(Date.parse(notForWithdrawals.expiresAt) - a.clock.now().epochMillis).toBe(5 * 60_000);
  });

  it('3 erros bloqueiam por 30 min; o 6º bloqueia até redefinir com MFA', async () => {
    const c = await customerWithSignature({ totp: true });
    const access = () => c.tokens.access_token;
    for (let i = 0; i < 3; i++) expect((await sign(access(), 'ORDERS', '000000')).status).toBe(401);
    const soft = await sign(access(), 'ORDERS');
    expect(soft.status).toBe(423);
    expect(soft.body.code).toBe('SIGNATURE_LOCKED');

    a.clock.advanceBy(30 * 60_000);
    const renewed = (
      await a.http.post('/v1/oauth/token').type('form').send({
        grant_type: 'refresh_token',
        refresh_token: c.tokens.refresh_token,
        client_id: 'bff-web',
      })
    ).body;
    c.tokens = renewed;
    for (let i = 0; i < 3; i++) expect((await sign(access(), 'ORDERS', '000000')).status).toBe(401);
    const hard = await sign(access(), 'ORDERS');
    expect(hard.body.code).toBe('SIGNATURE_RESET_REQUIRED');
    a.clock.advanceBy(24 * 3_600_000);
    // (a sessão web caiu por inatividade; entra de novo, com MFA)
    nextTotpStep(a);
    const again = await login(a, c, { totpSecret: c.totpSecret! });
    expect((await sign(again.access_token, 'ORDERS')).body.code).toBe('SIGNATURE_RESET_REQUIRED');

    // Redefinir exige MFA recente: o login acabou de fazer MFA, então passa.
    await a.http
      .put('/v1/me/trading-signature')
      .set(bearer(again.access_token))
      .send({ secret: '739104' })
      .expect(204);
    await sign(again.access_token, 'ORDERS', '739104').expect(200);
  });

  it('redefinir sem MFA recente responde STEP_UP_REQUIRED; o segredo tem de 6 a 8 dígitos', async () => {
    const c = await customerWithSignature();
    const res = await a.http
      .put('/v1/me/trading-signature')
      .set(bearer(c.tokens.access_token))
      .send({ secret: '111222' });
    expect(res.body.code).toBe('STEP_UP_REQUIRED');
    const t = await login(a, await register(a));
    for (const secret of ['abc', '12345', '123456789']) {
      expect(
        (await a.http.put('/v1/me/trading-signature').set(bearer(t.access_token)).send({ secret }))
          .status,
      ).toBe(400);
    }
  });
});

describe('13.5 step-up (RN-AUTHZ-003)', () => {
  it('saque de R$ 15.000,00 com o último MFA há 20 minutos exige novo MFA', async () => {
    const c = await customerWithSignature({ totp: true });
    const core = coreService();
    a.clock.advanceBy(20 * 60_000);
    // A sessão web caiu por inatividade (30 min)? Não: 20 min. Renova o access token.
    const t = (
      await a.http
        .post('/v1/oauth/token')
        .type('form')
        .send({
          grant_type: 'refresh_token',
          refresh_token: c.tokens.refresh_token,
          client_id: 'bff-web',
        })
        .expect(200)
    ).body;
    const sig = (await sign(t.access_token, 'WITHDRAWALS').expect(200)).body;
    const big = await core
      .post('/withdrawals')
      .set(bearer(t.access_token))
      .set('X-Trading-Signature', sig.signatureToken)
      .send({ amount: '15000.00' });
    expect(big.status).toBe(403);
    expect(big.body.code).toBe('STEP_UP_REQUIRED');
    await core
      .post('/withdrawals')
      .set(bearer(t.access_token))
      .set('X-Trading-Signature', sig.signatureToken)
      .send({ amount: '5000.00' })
      .expect(201);

    const up = await a.http
      .post('/v1/me/step-up')
      .set(bearer(t.access_token))
      .send({ method: 'TOTP', code: a.otp(c.totpSecret!) })
      .expect(200);
    const sig2 = (await sign(up.body.access_token, 'WITHDRAWALS').expect(200)).body;
    await core
      .post('/withdrawals')
      .set(bearer(up.body.access_token))
      .set('X-Trading-Signature', sig2.signatureToken)
      .send({ amount: '15000.00' })
      .expect(201);
  });
});

describe('13.5 recuperação de acesso (RN-AUTH-004)', () => {
  it('link de 15 min + TOTP; revoga as sessões; 1 hora depois o saque é recusado pela assinatura bloqueada', async () => {
    const c = await customerWithSignature({ totp: true });
    const core = coreService();
    await a.http.post('/v1/recovery').send({ email: c.email }).expect(202);
    // E-mail inexistente: mesma resposta, nada enviado.
    const sent = a.messenger.emails.length;
    await a.http.post('/v1/recovery').send({ email: 'nao.existe@exemplo.com' }).expect(202);
    expect(a.messenger.emails).toHaveLength(sent);

    const token = a.messenger.lastLink(c.email);
    expect(
      (await a.http.post('/v1/recovery/methods').send({ token }).expect(200)).body.methods,
    ).toEqual(['TOTP']);
    nextTotpStep(a);
    await a.http
      .post('/v1/recovery/complete')
      .send({
        token,
        newPassword: 'outra frase longa e nova',
        method: 'TOTP',
        code: a.otp(c.totpSecret!),
      })
      .expect(204);
    // Link de uso único; sessões antigas caíram.
    expect((await a.http.post('/v1/recovery/methods').send({ token })).body.code).toBe(
      'INVALID_LINK',
    );
    await expect(a.gateway.authenticate(`Bearer ${c.tokens.access_token}`)).rejects.toThrow(
      /Sessão encerrada/,
    );
    expect(
      (await outbox(env.db, 'identity.password_changed')).map((e) => e.payload['userId']),
    ).toContain(c.userId);

    a.clock.advanceBy(60 * 60_000);
    nextTotpStep(a);
    const t = await login(
      a,
      { email: c.email, password: 'outra frase longa e nova' },
      { totpSecret: c.totpSecret! },
    );
    const blocked = await sign(t.access_token, 'WITHDRAWALS');
    expect(blocked.status).toBe(423);
    expect(blocked.body.code).toBe('SIGNATURE_BLOCKED');
    expect(
      (await core.post('/withdrawals').set(bearer(t.access_token)).send({ amount: '10.00' })).body
        .code,
    ).toBe('TRADING_SIGNATURE_REQUIRED');

    a.clock.advanceBy(23 * 3_600_000);
    nextTotpStep(a);
    const later = await login(
      a,
      { email: c.email, password: 'outra frase longa e nova' },
      { totpSecret: c.totpSecret! },
    );
    await sign(later.access_token, 'WITHDRAWALS').expect(200);
  });

  it('link expira em 15 minutos; com SMS de recuperação, o OTP chega pelo message-sink', async () => {
    const c = await register(a);
    const t = await login(a, c);
    await a.http
      .post('/v1/me/mfa/sms')
      .set(bearer(t.access_token))
      .send({ phone: '+5521999990000' })
      .expect(202);
    await a.http
      .post('/v1/me/mfa/sms/confirm')
      .set(bearer(t.access_token))
      .send({ code: a.messenger.lastCode('+5521999990000') })
      .expect(200);

    await a.http.post('/v1/recovery').send({ email: c.email }).expect(202);
    const expired = a.messenger.lastLink(c.email);
    a.clock.advanceBy(15 * 60_000 + 1);
    expect((await a.http.post('/v1/recovery/methods').send({ token: expired })).body.code).toBe(
      'INVALID_LINK',
    );

    await a.http.post('/v1/recovery').send({ email: c.email }).expect(202);
    const token = a.messenger.lastLink(c.email);
    await a.http.post('/v1/recovery/sms').send({ token }).expect(204);
    await a.http
      .post('/v1/recovery/complete')
      .send({
        token,
        newPassword: 'mais uma frase comprida',
        method: 'SMS',
        code: a.messenger.lastCode('+5521999990000'),
      })
      .expect(204);
    await login(a, { email: c.email, password: 'mais uma frase comprida' });
  });

  it('sem segundo fator, a recuperação não conclui', async () => {
    const c = await register(a);
    await a.http.post('/v1/recovery').send({ email: c.email }).expect(202);
    const res = await a.http.post('/v1/recovery/complete').send({
      token: a.messenger.lastLink(c.email),
      newPassword: 'frase nova bem comprida',
      method: 'TOTP',
      code: '123456',
    });
    expect(res.body.code).toBe('RECOVERY_SECOND_FACTOR_UNAVAILABLE');
  });
});
