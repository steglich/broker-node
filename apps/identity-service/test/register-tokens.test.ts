// 13.1 (modelo, realms, cadastro com política de senha) e 13.2 (PKCE, access token, JWKS, refresh).
import { authorize } from '@broker/service-kit';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { s256 } from '../src/domain/pkce.js';
import {
  app,
  bearer,
  CLIENTS,
  login,
  newCustomer,
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

describe('13.1 realms e cadastro (RN-AUTH-001)', () => {
  it('cadastra no realm customers, com e-mail, nome e CPF cifrados e o evento sem dado pessoal', async () => {
    const c = await register(a);
    const { rows } = await sql<{ realm: string; email_enc: string; tax_id_enc: string }>`
      SELECT realm, email_enc, tax_id_enc FROM "user" WHERE id = ${c.userId}`.execute(env.db);
    expect(rows[0]!.realm).toBe('customers');
    expect(rows[0]!.email_enc).not.toContain('@');
    expect(rows[0]!.tax_id_enc).not.toContain(c.taxId);
    const [hash] = await sql<{
      password_hash: string;
    }>`SELECT password_hash FROM credential WHERE user_id = ${c.userId}`
      .execute(env.db)
      .then((r) => r.rows);
    expect(hash!.password_hash).toMatch(/^\$argon2id\$v=19\$/);
    const events = await outbox(env.db, 'identity.user_registered');
    expect(events.at(-1)!.payload).toMatchObject({ userId: c.userId, realm: 'customers' });
    expect(JSON.stringify(events.at(-1)!.payload)).not.toContain(c.email);
  });

  it('senha com o próprio CPF é recusada no campo password', async () => {
    const c = newCustomer();
    const res = await a.http
      .post('/v1/customers/register')
      .send({ ...c, password: `minha-senha-${c.taxId}` })
      .expect(400);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ field: 'password', code: 'CONTAINS_TAX_ID' }),
    ]);
  });

  it('recusa senha comum, curta e e-mail repetido', async () => {
    const c = await register(a);
    expect(
      (
        await a.http
          .post('/v1/customers/register')
          .send({ ...newCustomer(), password: 'senha12345' })
      ).body.errors[0].code,
    ).toBe('COMMON_PASSWORD');
    expect(
      (await a.http.post('/v1/customers/register').send({ ...newCustomer(), password: 'curta' }))
        .body.errors[0].code,
    ).toBe('TOO_SHORT');
    await a.http
      .post('/v1/customers/register')
      .send({ ...newCustomer(), email: c.email.toUpperCase() })
      .expect(409);
  });

  it('o backoffice não tem cadastro self-service: 404', async () => {
    await a.http.post('/v1/backoffice/register').send(newCustomer()).expect(404);
  });

  it('login_attempt é append-only', async () => {
    await expect(sql`DELETE FROM login_attempt`.execute(env.db)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('13.2 Authorization Code + PKCE, access token e refresh (Autenticação §4)', () => {
  it('emite access token ES256 de 10 min com os claims completos, validado pela JWKS', async () => {
    const c = await register(a);
    const tokens = await login(a, c);
    expect(tokens.expires_in).toBe(600);
    expect(decodeProtectedHeader(tokens.access_token)).toMatchObject({
      alg: 'ES256',
      typ: 'at+jwt',
    });
    const claims = decodeJwt(tokens.access_token);
    expect(claims).toMatchObject({
      sub: c.userId,
      realm: 'customers',
      roles: [],
      scope: expect.stringContaining('orders:write') as unknown as string,
      amr: ['pwd'],
      iss: 'https://auth.broker.test',
      aud: 'broker-api',
    });
    expect(claims.session_id).toBeTruthy();
    expect(claims.jti).toBeTruthy();
    expect(claims.exp! - claims.iat!).toBe(600);
    // O "gateway" aceita pela JWKS publicada.
    const jwks = await a.http.get('/.well-known/jwks.json').expect(200);
    expect(jwks.body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(jwks.body.keys[0].d).toBeUndefined();
    const principal = await a.gateway.authenticate(`Bearer ${tokens.access_token}`);
    expect(principal.actor).toEqual({ type: 'USER', id: c.userId });
  });

  it('account_id entra no token depois de customer.created + account.opened (em qualquer ordem)', async () => {
    const c = await register(a);
    const customerId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    await a.store.transaction((tx) => a.accounts.onAccountOpened(tx, { accountId, customerId }));
    await a.store.transaction((tx) =>
      a.accounts.onCustomerCreated(tx, { customerId, userId: c.userId }),
    );
    expect(decodeJwt((await login(a, c)).access_token).account_id).toBe(accountId);
  });

  it('code_verifier errado, código repetido e redirect_uri diferente são recusados', async () => {
    const c = await register(a);
    const verifier = randomBytes(32).toString('base64url');
    const auth = await a.http
      .post('/v1/oauth/authorize')
      .send({
        client_id: CLIENTS.web.id,
        redirect_uri: CLIENTS.web.redirect,
        code_challenge: s256(verifier),
        code_challenge_method: 'S256',
        device_id: 'device-pkce-0001',
        email: c.email,
        password: c.password,
      })
      .expect(200);
    const exchange = (over: Record<string, string>) =>
      a.http
        .post('/v1/oauth/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code: auth.body.code,
          code_verifier: verifier,
          client_id: CLIENTS.web.id,
          redirect_uri: CLIENTS.web.redirect,
          ...over,
        });
    expect(
      (await exchange({ code_verifier: randomBytes(32).toString('base64url') })).body,
    ).toMatchObject({ error: 'invalid_grant' });
    expect((await exchange({ redirect_uri: 'https://evil.example/cb' })).status).toBe(400);
    const ok = await exchange({});
    expect(ok.status).toBe(200);
    // Repetir o código derruba a sessão que ele criou.
    expect((await exchange({})).body.error).toBe('invalid_grant');
    await expect(a.gateway.authenticate(`Bearer ${ok.body.access_token}`)).rejects.toThrow(
      /Sessão encerrada/,
    );
  });

  it('PKCE é obrigatório e só S256; redirect_uri precisa estar cadastrado', async () => {
    const base = {
      client_id: CLIENTS.web.id,
      redirect_uri: CLIENTS.web.redirect,
      device_id: 'device-xyz-0001',
      email: 'x@y.com',
      password: 'x',
    };
    expect(
      (
        await a.http
          .post('/v1/oauth/authorize')
          .send({ ...base, code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' })
      ).status,
    ).toBe(400);
    expect(
      (
        await a.http.post('/v1/oauth/authorize').send({
          ...base,
          redirect_uri: 'https://evil.example',
          code_challenge: 'a'.repeat(43),
          code_challenge_method: 'S256',
        })
      ).body.code,
    ).toBe('invalid_request');
  });

  it('refresh rotaciona; reusar um refresh já rotacionado revoga a família e encerra a sessão', async () => {
    const c = await register(a);
    const first = await login(a, c);
    const refresh = (token: string) =>
      a.http
        .post('/v1/oauth/token')
        .type('form')
        .send({ grant_type: 'refresh_token', refresh_token: token, client_id: CLIENTS.web.id });
    const second = (await refresh(first.refresh_token).expect(200)).body;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const sessionId = decodeJwt(second.access_token).session_id as string;

    // O atacante usa o refresh antigo: a sessão inteira cai, inclusive o refresh novo.
    expect((await refresh(first.refresh_token)).body.error).toBe('invalid_grant');
    expect((await refresh(second.refresh_token)).body.error).toBe('invalid_grant');
    await expect(a.gateway.authenticate(`Bearer ${second.access_token}`)).rejects.toThrow(
      /Sessão encerrada/,
    );
    const revoked = (await outbox(env.db, 'identity.session_revoked')).map((e) => e.payload);
    expect(revoked).toContainEqual({ userId: c.userId, sessionId, reason: 'REFRESH_REUSE' });
  });

  it('o refresh fica guardado só como hash', async () => {
    const c = await register(a);
    const tokens = await login(a, c);
    const { rows } =
      await sql`SELECT 1 FROM refresh_token WHERE token_hash = ${tokens.refresh_token}`.execute(
        env.db,
      );
    expect(rows).toEqual([]);
  });

  it('rotação da JWKS: tokens da chave anterior continuam válidos', async () => {
    const c = await register(a);
    const before = await login(a, c);
    const oldKid = decodeProtectedHeader(before.access_token).kid;
    await a.signer.rotate(a.clock.now());
    const after = await login(a, c);
    expect(decodeProtectedHeader(after.access_token).kid).not.toBe(oldKid);
    const kids = (await a.http.get('/.well-known/jwks.json')).body.keys.map(
      (k: { kid: string }) => k.kid,
    );
    expect(kids).toEqual(
      expect.arrayContaining([oldKid, decodeProtectedHeader(after.access_token).kid]),
    );
    await a.gateway.authenticate(`Bearer ${before.access_token}`);
  });

  it('client credentials: escopo mínimo; serviço sem o escopo é recusado com 403', async () => {
    const pricing = await a.accounts.registerServiceClient({
      clientId: 'oms-service',
      scopes: ['risk:pretrade'],
    });
    const other = await a.accounts.registerServiceClient({
      clientId: 'reporting-service',
      scopes: ['ledger:read'],
    });
    const token = async (id: string, secret: string, scope?: string) =>
      a.http
        .post('/v1/oauth/token')
        .auth(id, secret)
        .type('form')
        .send({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) });

    const ok = await token(pricing.clientId, pricing.clientSecret, 'risk:pretrade');
    expect(ok.status).toBe(200);
    expect(ok.body.refresh_token).toBeUndefined();
    expect((await token(pricing.clientId, 'errado')).body.error).toBe('invalid_client');
    expect((await token(other.clientId, other.clientSecret, 'risk:pretrade')).body.error).toBe(
      'invalid_scope',
    );

    // Como o risk-service verifica a rota de pré-trade (Autenticação §5.1).
    const preTrade = { scopes: ['risk:pretrade'], principal: 'service' as const };
    authorize(await a.gateway.authenticate(`Bearer ${ok.body.access_token}`), preTrade);
    const noScope = (await token(other.clientId, other.clientSecret)).body.access_token;
    const principal = await a.gateway.authenticate(`Bearer ${noScope}`);
    expect(() => authorize(principal, preTrade)).toThrow(
      expect.objectContaining({ status: 403 }) as unknown as Error,
    );
  });

  it('o token de assinatura não serve como access token', async () => {
    const c = await register(a);
    const tokens = await login(a, c);
    await a.http
      .put('/v1/me/trading-signature')
      .set(bearer(tokens.access_token))
      .send({ secret: '482913' })
      .expect(204);
    const sig = await a.http
      .post('/v1/me/trading-signature/verify')
      .set(bearer(tokens.access_token))
      .send({ secret: '482913', scope: 'ORDERS' })
      .expect(200);
    await expect(a.gateway.authenticate(`Bearer ${sig.body.signatureToken}`)).rejects.toThrow();
  });
});
