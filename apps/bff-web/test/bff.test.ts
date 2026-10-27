// 19.2 token handler, /v1/me com a conta do token, read-your-writes e asOf; 19.3 auditoria.
import { uuidv7 } from '@broker/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  jar,
  login,
  outbox,
  setCookies,
  startEnv,
  stopEnv,
  WEB,
  type App,
  type Env,
} from './helpers.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
}, 180_000);
afterAll(async () => {
  a?.upstream.server.close();
  await stopEnv(env);
});
beforeEach(async () => {
  a?.upstream.server.close();
  a = await app(env);
});

describe('19.2 token handler (RN-AUTH-010)', () => {
  it('login web: só cookies HttpOnly/Secure/SameSite=Strict e nenhum token no corpo; PKCE S256', async () => {
    const { res } = await login(a);
    expect(res.body).toEqual({
      status: 'AUTHENTICATED',
      expiresIn: 600,
      csrfToken: expect.any(String) as unknown as string,
    });
    const cookies = setCookies(res);
    for (const name of ['__Host-broker_at', '__Secure-broker_rt', '__Host-broker_device']) {
      const line = cookies.get(name)!;
      expect(line, name).toMatch(/; HttpOnly/);
      expect(line, name).toMatch(/; Secure/);
      expect(line, name).toMatch(/; SameSite=Strict/);
    }
    expect(cookies.get('__Secure-broker_rt')).toMatch(/Path=\/v1\/auth;/);
    // Nada de token no corpo.
    const access = jar(res).match(/__Host-broker_at=([^;]+)/)![1]!;
    expect(JSON.stringify(res.body)).not.toContain(access);
    expect(JSON.stringify(res.body)).not.toMatch(/rt-/);
    // O identity recebeu o desafio S256 (43 caracteres) e a troca conferiu o verifier.
    const authorize = a.upstream.last('/v1/oauth/authorize')!.body as Record<string, string>;
    expect(authorize).toMatchObject({ client_id: 'bff-web', code_challenge_method: 'S256' });
    expect(authorize['code_challenge']).toHaveLength(43);
    expect(authorize['device_id']).toMatch(/^[0-9a-f-]{36}$/);
    // Credencial errada: o 401 do identity, sem cookies de sessão.
    const bad = await a.http
      .post('/v1/auth/login')
      .set(WEB)
      .send({ email: 'x@y.z', password: 'errada' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('INVALID_CREDENTIALS');
    expect(setCookies(bad).has('__Host-broker_at')).toBe(false);
  });

  it('MFA: o desafio fica num cookie cifrado; o verify troca o código', async () => {
    const first = await a.http
      .post('/v1/auth/login')
      .set(WEB)
      .send({ email: 'mfa@exemplo.com', password: 'senha-certa' })
      .expect(200);
    expect(first.body).toEqual({
      status: 'MFA_REQUIRED',
      methods: ['TOTP'],
      expiresAt: '2026-10-27T14:05:00.000Z',
    });
    expect(setCookies(first).get('__Secure-broker_login')).toMatch(/HttpOnly/);
    expect(JSON.stringify(first.body)).not.toMatch(/mfaToken/);
    const wrong = await a.http
      .post('/v1/auth/mfa/verify')
      .set(WEB)
      .set('Cookie', jar(first))
      .send({ method: 'TOTP', code: '000000' });
    expect(wrong.status).toBe(401);
    const ok = await a.http
      .post('/v1/auth/mfa/verify')
      .set(WEB)
      .set('Cookie', jar(first))
      .send({ method: 'TOTP', code: '123456' })
      .expect(200);
    expect(ok.body.status).toBe('AUTHENTICATED');
    expect(setCookies(ok).get('__Secure-broker_login')).toMatch(/Max-Age=0/);
    // Sem o cookie (ou adulterado), o login expirou.
    const forged = await a.http
      .post('/v1/auth/mfa/verify')
      .set(WEB)
      .set('Cookie', '__Secure-broker_login=abc')
      .send({ method: 'TOTP', code: '123456' });
    expect(forged.body.code).toBe('LOGIN_EXPIRED');
  });

  it('comando com cookie válido e sem token anti-CSRF é 403; com ele, passa', async () => {
    const s = await login(a);
    const deposit = () =>
      a.http
        .post('/v1/me/deposits')
        .set(WEB)
        .set('Cookie', s.cookie)
        .set('Idempotency-Key', uuidv7())
        .send({ amount: '50.00' });
    const blocked = await deposit();
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('CSRF_TOKEN_INVALID');
    expect((await deposit().set('X-CSRF-Token', 'outro')).status).toBe(403);
    expect(a.upstream.last('/v1/me/deposits')).toBeUndefined();
    const ok = await deposit().set('X-CSRF-Token', s.csrf);
    expect(ok.status).toBe(201);
    // Leitura não precisa do anti-CSRF.
    await a.http.get('/v1/me/balances').set(WEB).set('Cookie', s.cookie).expect(200);
    // O anti-CSRF também sai da sessão (app recarregado).
    const session = await a.http
      .get('/v1/auth/session')
      .set(WEB)
      .set('Cookie', s.cookie)
      .expect(200);
    expect(session.body.csrfToken).toBe(s.csrf);
    expect(session.body.accountId).toBe(a.upstream.accountId);
  });

  it('renovação gira os cookies; refresh inválido limpa a sessão; logout revoga e limpa', async () => {
    const s = await login(a);
    const renewed = await a.http
      .post('/v1/auth/token/refresh')
      .set(WEB)
      .set('Cookie', s.cookie)
      .expect(200);
    expect(renewed.body.status).toBe('AUTHENTICATED');
    // A sessão é a mesma: o anti-CSRF não muda na renovação.
    expect(renewed.body.csrfToken).toBe(s.csrf);
    const rotated = jar(s.res, renewed);
    expect(rotated).not.toBe(s.cookie);
    // O refresh antigo já foi usado: reuso derruba.
    const reuse = await a.http.post('/v1/auth/token/refresh').set(WEB).set('Cookie', s.cookie);
    expect(reuse.status).toBe(401);
    expect(setCookies(reuse).get('__Host-broker_at')).toMatch(/Max-Age=0/);

    const out = await a.http.post('/v1/auth/logout').set(WEB).set('Cookie', rotated).expect(204);
    expect(a.upstream.revoked).toHaveLength(1);
    expect(a.upstream.revoked[0]).toMatch(/^rt-/);
    expect(setCookies(out).get('__Secure-broker_rt')).toMatch(/Max-Age=0/);
    await a.http.post('/v1/auth/token/refresh').set(WEB).expect(401);
  });

  it('assinatura eletrônica e step-up: tokens nos cookies, anexados ao comando certo', async () => {
    const s = await login(a);
    const h = { ...WEB, Cookie: s.cookie, 'X-CSRF-Token': s.csrf };
    const sig = await a.http
      .post('/v1/me/trading-signature/verify')
      .set(h)
      .send({ secret: '123456', scope: 'SETTINGS' })
      .expect(200);
    expect(sig.body).toEqual({ scope: 'SETTINGS', expiresAt: '2026-10-27T14:05:00.000Z' });
    const sigCookie = setCookies(sig).get('__Host-broker_sig_settings')!;
    expect(sigCookie).toMatch(/HttpOnly/);
    expect(sigCookie).toMatch(/Max-Age=300/);
    const cookie = jar(s.res, sig);
    await a.http
      .post('/v1/me/withdrawal-accounts')
      .set({ ...h, Cookie: cookie })
      .set('Idempotency-Key', uuidv7())
      .send({ pixKey: 'k@exemplo.com' })
      .expect(200);
    expect(a.upstream.last('/v1/me/withdrawal-accounts')!.headers['x-trading-signature']).toMatch(
      /^sig-SETTINGS-/,
    );
    // O de SETTINGS não vale para saque.
    await a.http
      .post('/v1/me/withdrawals')
      .set({ ...h, Cookie: cookie })
      .send({ amount: '1.00' });
    expect(a.upstream.last('/v1/me/withdrawals')!.headers['x-trading-signature']).toBeUndefined();

    const stepUp = await a.http
      .post('/v1/me/step-up')
      .set(h)
      .send({ method: 'TOTP', code: '123456' })
      .expect(200);
    expect(stepUp.body).toEqual({ status: 'STEPPED_UP', expiresIn: 600 });
    expect(setCookies(stepUp).get('__Host-broker_at')).toMatch(
      /^__Host-broker_at=stepped-up-token;/,
    );
  });
});

describe('19.2 rotas /v1/me (RN-API-043, RN-PAD-010/011)', () => {
  it('IDOR: accountId na consulta ou no corpo é descartado; o dono usa a conta do token', async () => {
    const s = await login(a);
    const other = uuidv7();
    const res = await a.http
      .post(`/v1/me/deposits?accountId=${other}`)
      .set({ ...WEB, Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Idempotency-Key': 'k-123456789' })
      .send({ amount: '10.00', accountId: other })
      .expect(201);
    const seen = a.upstream.last('/v1/me/deposits')!;
    expect(seen.body).toEqual({ amount: '10.00' });
    expect(seen.query).toEqual({});
    // Read-your-writes: a resposta é a do dono, com o estado resultante.
    expect(res.body).toMatchObject({ status: 'PENDING', amount: '10.00' });
    // Repassa o token do usuário e a Idempotency-Key.
    expect(seen.headers['authorization']).toMatch(/^Bearer /);
    expect(seen.headers['idempotency-key']).toBe('k-123456789');
  });

  it('painel inicial: perfil, saldo com asOf e não lidas, uma chamada por dono', async () => {
    const s = await login(a);
    a.upstream.seen = [];
    const res = await a.http.get('/v1/me').set(WEB).set('Cookie', s.cookie).expect(200);
    expect(res.body).toMatchObject({
      accountId: a.upstream.accountId,
      balances: { settled: '100.00', asOf: '2026-10-27T13:59:58.000Z' },
      unreadNotifications: 3,
      unavailable: [],
    });
    expect(a.upstream.seen.map((x) => x.path).sort()).toEqual([
      '/v1/me/balances',
      '/v1/me/notifications',
      '/v1/me/profile',
    ]);
    expect((await a.http.get('/v1/me/balances').set(WEB).set('Cookie', s.cookie)).body.asOf).toBe(
      '2026-10-27T13:59:58.000Z',
    );
  });

  it('sem token: 401; token inválido no cookie: 401', async () => {
    await a.http.get('/v1/me/balances').set(WEB).expect(401);
    await a.http.get('/v1/me/balances').set(WEB).set('Cookie', '__Host-broker_at=xyz').expect(401);
  });
});

describe('19.3 rotas da Fase 1 e auditoria', () => {
  it('leitura de dados pessoais publica audit.personal_data_accessed, sem os dados', async () => {
    const s = await login(a);
    await a.http
      .get('/v1/me/profile')
      .set(WEB)
      .set('Cookie', s.cookie)
      .set('User-Agent', 'teste/1.0')
      .expect(200);
    const events = await outbox(env.db, 'audit.personal_data_accessed');
    const e = events.at(-1)!;
    expect(e.payload).toMatchObject({
      resourceType: 'customer_profile',
      route: '/v1/me/profile',
      channel: 'WEB',
      userAgent: 'teste/1.0',
    });
    expect(e.headers['auditable']).toBe(true);
    expect(e.partition_key).toBe(e.payload['resourceId']);
    expect(JSON.stringify(e.payload)).not.toContain('Maria');
    // Leitura sem dado pessoal não audita.
    const before = events.length;
    await a.http.get('/v1/me/balances').set(WEB).set('Cookie', s.cookie).expect(200);
    expect(await outbox(env.db, 'audit.personal_data_accessed')).toHaveLength(before);
  });

  it('caminhos do canal → do dono: busca, ticker, cotações em lote e índices', async () => {
    const s = await login(a);
    const get = async (path: string) =>
      (await a.http.get(path).set(WEB).set('Cookie', s.cookie).expect(200)).body.echo as {
        path: string;
        query: Record<string, string>;
      };
    expect(await get('/v1/instruments?search=petr&limit=5')).toMatchObject({
      path: '/v1/instruments/search',
      query: { q: 'petr', limit: '5' },
    });
    expect(await get('/v1/instruments?tradable=true')).toMatchObject({
      path: '/v1/instruments',
      query: { tradable: 'true' },
    });
    expect((await get('/v1/instruments/PETR4F')).path).toBe('/v1/instruments/by-symbol/PETR4F');
    a.upstream.seen = [];
    expect(await get('/v1/market/quotes?symbols=PETR4,VALE3,ITUB4')).toMatchObject({
      path: '/v1/market-data/external-quotes',
      query: { symbols: 'PETR4,VALE3,ITUB4' },
    });
    expect(a.upstream.seen).toHaveLength(1);
    expect((await get('/v1/market/indexes')).query).toEqual({ symbols: '^BVSP' });
    expect((await get('/v1/market/calendar')).path).toBe('/v1/calendar');
  });

  it('cadastro e recuperação são públicos e vão ao identity', async () => {
    const r = await a.http.post('/v1/auth/register').set(WEB).send({ email: 'a@b.c' }).expect(200);
    expect(r.body.echo.path).toBe('/v1/customers/register');
    const p = await a.http
      .post('/v1/auth/password-reset')
      .set(WEB)
      .send({ email: 'a@b.c' })
      .expect(200);
    expect(p.body.echo.path).toBe('/v1/recovery');
  });
});
