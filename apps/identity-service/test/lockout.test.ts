// 13.3: atraso progressivo, bloqueio de 30 min na 10ª falha com e-mail, resposta igual para e-mail inexistente (RN-AUTH-002).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { s256 } from '../src/domain/pkce.js';
import {
  app,
  CLIENTS,
  login,
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

const attempt = (email: string, password: string) =>
  a.http.post('/v1/oauth/authorize').send({
    client_id: CLIENTS.web.id,
    redirect_uri: CLIENTS.web.redirect,
    code_challenge: s256(randomBytes(32).toString('base64url')),
    code_challenge_method: 'S256',
    device_id: 'device-lockout-01',
    email,
    password,
  });

/** Uma falha, esperando o atraso progressivo terminar antes (como um cliente educado). */
async function fail(email: string) {
  let res = await attempt(email, 'senha errada qualquer');
  while (
    res.status === 429 &&
    res.body.code === 'LOGIN_TEMPORARILY_LOCKED' &&
    Number(res.headers['retry-after']) <= 16
  ) {
    a.clock.advanceBy(Number(res.headers['retry-after']) * 1000);
    res = await attempt(email, 'senha errada qualquer');
  }
  return res;
}

const shape = (res: { status: number; body: Record<string, unknown> }) => ({
  status: res.status,
  code: res.body['code'],
  detail: res.body['detail'],
});

describe('13.3 bloqueio por tentativas (RN-AUTH-002)', () => {
  it('a 10ª falha bloqueia por 30 min e o titular recebe e-mail; e-mail inexistente responde igual', async () => {
    const c = await register(a);
    const ghost = `ninguem.${randomBytes(4).toString('hex')}@exemplo.com`;

    for (let i = 1; i <= 9; i++) {
      const real = await fail(c.email);
      const fake = await fail(ghost);
      expect(shape(real)).toEqual({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        detail: 'E-mail ou senha inválidos.',
      });
      expect(shape(fake)).toEqual(shape(real));
    }
    // Da 5ª em diante há atraso progressivo, também para o e-mail inexistente.
    const early = await attempt(c.email, 'outra');
    expect(early.status).toBe(429);
    expect(shape(await attempt(ghost, 'outra'))).toEqual(shape(early));

    expect(a.messenger.emails.filter((m) => m.to === c.email)).toEqual([]);
    expect(shape(await fail(c.email))).toMatchObject({ status: 401 });
    expect(shape(await fail(ghost))).toMatchObject({ status: 401 });

    // 10ª falha: bloqueado, até com a senha certa, e o e-mail foi enviado só ao titular real.
    const locked = await attempt(c.email, c.password);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBe(30 * 60);
    expect(shape(await attempt(ghost, 'x'))).toEqual(shape(locked));
    expect(a.messenger.emails.filter((m) => m.to === c.email)).toEqual([
      expect.objectContaining({ subject: 'Acesso bloqueado temporariamente' }),
    ]);
    expect(a.messenger.emails.some((m) => m.to === ghost)).toBe(false);
    const failed = (await outbox(env.db, 'identity.login_failed')).map((e) => e.payload);
    expect(failed.filter((p) => p['reason'] === 'LOCKED')).toHaveLength(2);

    // Depois de 30 minutos, a senha certa entra e o contador zera.
    a.clock.advanceBy(30 * 60_000);
    const tokens = await login(a, c);
    expect(tokens.access_token).toBeTruthy();
  });
});
