// 13.4: TOTP, WebAuthn e SMS; sessões e dispositivos; inatividade por canal; revogação no Valkey vista pelo gateway.
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  app,
  bearer,
  CLIENTS,
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
import { randomBytes } from 'node:crypto';
import { s256 } from '../src/domain/pkce.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
  a = await app(env);
}, 180_000);
afterAll(() => stopEnv(env));

const refresh = (token: string, client = CLIENTS.web.id) =>
  a.http
    .post('/v1/oauth/token')
    .type('form')
    .send({ grant_type: 'refresh_token', refresh_token: token, client_id: client });

describe('13.4 MFA (RN-AUTH-003)', () => {
  it('TOTP: ativação publica identity.mfa_enabled; o login passa a exigir o código; código repetido é recusado', async () => {
    const c = await register(a);
    const first = await login(a, c);
    const secret = await enableTotp(a, first.access_token);
    expect(
      (await outbox(env.db, 'identity.mfa_enabled')).map((e) => e.payload['userId']),
    ).toContain(c.userId);

    nextTotpStep(a);
    const tokens = await login(a, c, { totpSecret: secret });
    const claims = decodeJwt(tokens.access_token);
    expect(claims.amr).toEqual(['pwd', 'otp', 'mfa']);
    expect(claims.mfa_time).toBe(Math.floor(a.clock.now().epochMillis / 1000));

    // O mesmo código (mesmo passo de 30 s) não serve para um segundo login.
    const verifier = randomBytes(32).toString('base64url');
    const auth = await a.http.post('/v1/oauth/authorize').send({
      client_id: CLIENTS.web.id,
      redirect_uri: CLIENTS.web.redirect,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      device_id: 'device-principal-01',
      email: c.email,
      password: c.password,
    });
    expect(auth.body.status).toBe('MFA_REQUIRED');
    const replay = await a.http
      .post('/v1/oauth/authorize/mfa')
      .send({ mfa_token: auth.body.mfaToken, method: 'TOTP', code: a.otp(secret) });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('INVALID_MFA');
  });

  it('WebAuthn: cadastro e login com a chave', async () => {
    const c = await register(a);
    const t = await login(a, c);
    const opts = await a.http
      .post('/v1/me/mfa/webauthn/options')
      .set(bearer(t.access_token))
      .expect(200);
    await a.http
      .post('/v1/me/mfa/webauthn')
      .set(bearer(t.access_token))
      .send({
        factorId: opts.body.factorId,
        response: { id: 'cred-1', challenge: opts.body.options.challenge },
      })
      .expect(200);

    const verifier = randomBytes(32).toString('base64url');
    const auth = await a.http.post('/v1/oauth/authorize').send({
      client_id: CLIENTS.web.id,
      redirect_uri: CLIENTS.web.redirect,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      device_id: 'device-principal-01',
      email: c.email,
      password: c.password,
    });
    expect(auth.body).toMatchObject({ status: 'MFA_REQUIRED', methods: ['WEBAUTHN'] });
    const challenge = await a.http
      .post('/v1/oauth/authorize/mfa/webauthn-options')
      .send({ mfa_token: auth.body.mfaToken })
      .expect(200);
    const done = await a.http
      .post('/v1/oauth/authorize/mfa')
      .send({
        mfa_token: auth.body.mfaToken,
        method: 'WEBAUTHN',
        response: { id: 'cred-1', challenge: challenge.body.options.challenge },
      })
      .expect(200);
    expect(done.body.status).toBe('AUTHORIZED');
  });

  it('SMS: telefone de recuperação confirmado por OTP, sem virar fator de login', async () => {
    const c = await register(a);
    const t = await login(a, c);
    await a.http
      .post('/v1/me/mfa/sms')
      .set(bearer(t.access_token))
      .send({ phone: '+5511987654321' })
      .expect(202);
    await a.http
      .post('/v1/me/mfa/sms/confirm')
      .set(bearer(t.access_token))
      .send({ code: '000000' })
      .expect(401);
    await a.http
      .post('/v1/me/mfa/sms/confirm')
      .set(bearer(t.access_token))
      .send({ code: a.messenger.lastCode('+5511987654321') })
      .expect(200);
    expect((await a.http.get('/v1/me/mfa').set(bearer(t.access_token))).body.factors).toMatchObject(
      [{ type: 'SMS' }],
    );
    // Fator fraco: o login continua sem etapa de MFA.
    expect((await login(a, c)).access_token).toBeTruthy();
  });

  it('desativar MFA exige MFA nos últimos 15 minutos; o step-up renova o mfa_time (RN-AUTHZ-003)', async () => {
    const c = await register(a);
    const secret = await enableTotp(a, (await login(a, c)).access_token);
    nextTotpStep(a);
    const t = await login(a, c, { totpSecret: secret });
    const [factor] = (await a.http.get('/v1/me/mfa').set(bearer(t.access_token))).body.factors;
    a.clock.advanceBy(16 * 60_000);
    const access = (await refresh(t.refresh_token).expect(200)).body.access_token as string;
    const stale = await a.http.delete(`/v1/me/mfa/${factor.id}`).set(bearer(access));
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe('STEP_UP_REQUIRED');

    const up = await a.http
      .post('/v1/me/step-up')
      .set(bearer(access))
      .send({ method: 'TOTP', code: a.otp(secret) })
      .expect(200);
    expect(decodeJwt(up.body.access_token).mfa_time).toBe(
      Math.floor(a.clock.now().epochMillis / 1000),
    );
    await a.http.delete(`/v1/me/mfa/${factor.id}`).set(bearer(up.body.access_token)).expect(204);
  });
});

describe('13.4 sessões e dispositivos (RN-AUTH-013)', () => {
  it('login em dispositivo novo publica identity.new_device_detected (o primeiro login, não)', async () => {
    const c = await register(a);
    await login(a, c, { deviceId: 'notebook-de-casa' });
    await login(a, c, { deviceId: 'notebook-de-casa' });
    expect(
      (await outbox(env.db, 'identity.new_device_detected')).filter(
        (e) => e.payload['userId'] === c.userId,
      ),
    ).toEqual([]);
    const t = await login(a, c, { deviceId: 'celular-novo-123' });
    const detected = (await outbox(env.db, 'identity.new_device_detected')).filter(
      (e) => e.payload['userId'] === c.userId,
    );
    expect(detected).toHaveLength(1);
    expect(
      (await a.http.get('/v1/me/devices').set(bearer(t.access_token))).body.devices,
    ).toHaveLength(2);
  });

  it('revogar outra sessão: os tokens dela deixam de valer no gateway e sai identity.session_revoked', async () => {
    const c = await register(a);
    const phone = await login(a, c, { deviceId: 'celular-0000001' });
    const laptop = await login(a, c, { deviceId: 'notebook-000001' });
    const list = await a.http.get('/v1/me/sessions').set(bearer(laptop.access_token)).expect(200);
    expect(list.body.sessions).toHaveLength(2);
    const phoneSession = decodeJwt(phone.access_token).session_id as string;
    expect(list.body.sessions.find((s: { id: string }) => s.id === phoneSession).current).toBe(
      false,
    );

    await a.gateway.authenticate(`Bearer ${phone.access_token}`);
    await a.http
      .delete(`/v1/me/sessions/${phoneSession}`)
      .set(bearer(laptop.access_token))
      .expect(204);
    // O access token ainda não expirou (10 min), mas a lista de revogação do Valkey o derruba.
    await expect(a.gateway.authenticate(`Bearer ${phone.access_token}`)).rejects.toThrow(
      /Sessão encerrada/,
    );
    expect(await a.revocation.isSessionRevoked(phoneSession)).toBe(true);
    expect((await refresh(phone.refresh_token)).body.error).toBe('invalid_grant');
    await a.gateway.authenticate(`Bearer ${laptop.access_token}`);
    expect((await outbox(env.db, 'identity.session_revoked')).map((e) => e.payload)).toContainEqual(
      {
        userId: c.userId,
        sessionId: phoneSession,
        reason: 'USER',
      },
    );
    // Sessão de outro usuário: 404, igual a inexistente.
    const other = await register(a);
    const otherTokens = await login(a, other);
    await a.http
      .delete(`/v1/me/sessions/${decodeJwt(laptop.access_token).session_id}`)
      .set(bearer(otherTokens.access_token))
      .expect(404);
  });
});

describe('13.4 inatividade por canal (RN-AUTH-012)', () => {
  it('web: 31 minutos sem atividade e a renovação é recusada', async () => {
    const c = await register(a);
    const t = await login(a, c);
    a.clock.advanceBy(29 * 60_000);
    const renewed = (await refresh(t.refresh_token).expect(200)).body;
    a.clock.advanceBy(31 * 60_000);
    const idle = await refresh(renewed.refresh_token);
    expect(idle.body).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Sessão expirada por inatividade.',
    });
  });

  it('desktop: 2 h por padrão, configurável até 8 h', async () => {
    const c = await register(a);
    const t = await login(a, c, { client: 'desktop' });
    a.clock.advanceBy(119 * 60_000);
    const r1 = (await refresh(t.refresh_token, CLIENTS.desktop.id).expect(200)).body;
    await a.http
      .put('/v1/me/settings/desktop-idle')
      .set(bearer(r1.access_token))
      .send({ minutes: 600 })
      .expect(400);
    await a.http
      .put('/v1/me/settings/desktop-idle')
      .set(bearer(r1.access_token))
      .send({ minutes: 480 })
      .expect(204);
    a.clock.advanceBy(7 * 60 * 60_000);
    const r2 = (await refresh(r1.refresh_token, CLIENTS.desktop.id).expect(200)).body;
    a.clock.advanceBy(8 * 60 * 60_000 + 60_000);
    expect((await refresh(r2.refresh_token, CLIENTS.desktop.id)).body.error).toBe('invalid_grant');
  });
});
