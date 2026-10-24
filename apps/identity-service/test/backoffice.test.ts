// 13.6: RBAC do backoffice com segregação, MFA forte obrigatório, client credentials e account.status_changed.
import { uuidv7 } from '@broker/ids';
import {
  connectStream,
  ensureSuperStream,
  PartitionedProducer,
  topicName,
} from '@broker/messaging';
import { startRabbitMq, type StartedRabbitMq } from '@broker/testing/containers';
import { decodeJwt } from 'jose';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  app,
  bearer,
  CLIENTS,
  login,
  nextTotpStep,
  register,
  startEnv,
  stopEnv,
  type App,
  type Env,
} from './helpers.js';

let env: Env;
let rabbit: StartedRabbitMq;
let a: App;
beforeAll(async () => {
  [env, rabbit] = await Promise.all([startEnv(), startRabbitMq()]);
  a = await app(env);
}, 180_000);
afterAll(async () => {
  await stopEnv(env);
  await rabbit?.container.stop();
});

/** Aceita o convite (senha + TOTP) e devolve o segredo do autenticador. */
async function acceptInvitation(email: string): Promise<string> {
  const token = a.messenger.lastLink(email);
  const start = await a.http.post('/v1/backoffice/invitations/start').send({ token }).expect(200);
  expect(start.body.uri).toMatch(/^otpauth:\/\/totp\//);
  await a.http
    .post('/v1/backoffice/invitations/complete')
    .send({ token, password: 'frase do operador bem longa', totpCode: a.otp(start.body.secret) })
    .expect(204);
  return start.body.secret as string;
}

async function adminSession() {
  const email = `admin.${uuidv7().slice(-6)}@broker.test`;
  const bootstrap = await a.accounts.bootstrapAdmin(email, 'Admin Inicial');
  expect(bootstrap?.link).toContain('token=');
  const secret = await acceptInvitation(email);
  nextTotpStep(a);
  const tokens = await login(
    a,
    { email, password: 'frase do operador bem longa' },
    { client: 'backoffice', totpSecret: secret },
  );
  return { email, secret, tokens };
}

describe('13.6 backoffice (RN-BO-001/002)', () => {
  it('convite com TOTP obrigatório; login sempre com MFA; o token traz os papéis', async () => {
    const admin = await adminSession();
    const claims = decodeJwt(admin.tokens.access_token);
    expect(claims).toMatchObject({ realm: 'backoffice', roles: ['BO_ADMIN'] });
    expect(claims.amr).toContain('otp');
    expect(await a.accounts.bootstrapAdmin(admin.email, 'De novo')).toBeNull();

    // Antes de concluir o convite, a conta não entra (nem com a senha que ainda não existe).
    const email = `operador.${uuidv7().slice(-6)}@broker.test`;
    await a.http
      .post('/v1/backoffice/users')
      .set(bearer(admin.tokens.access_token))
      .send({ email, fullName: 'Op Financeiro', roles: ['BO_FINANCE', 'BO_RISK'] })
      .expect(201);
    const secret = await acceptInvitation(email);
    nextTotpStep(a);
    const op = await login(
      a,
      { email, password: 'frase do operador bem longa' },
      { client: 'backoffice', totpSecret: secret },
    );
    expect(decodeJwt(op.access_token).roles).toEqual(['BO_FINANCE', 'BO_RISK']);
    // O backoffice não autoriza código sem MFA: o desafio é obrigatório.
    await expect(
      login(a, { email, password: 'frase do operador bem longa' }, { client: 'backoffice' }),
    ).rejects.toThrow(/MFA exigido/);
  });

  it('BO_AUDITOR não acumula outro papel: atribuir BO_FINANCE a um auditor é recusado', async () => {
    const admin = await adminSession();
    const email = `auditor.${uuidv7().slice(-6)}@broker.test`;
    const created = await a.http
      .post('/v1/backoffice/users')
      .set(bearer(admin.tokens.access_token))
      .send({ email, fullName: 'Auditora', roles: ['BO_AUDITOR'] })
      .expect(201);
    const res = await a.http
      .put(`/v1/backoffice/users/${created.body.userId}/roles`)
      .set(bearer(admin.tokens.access_token))
      .send({ roles: ['BO_AUDITOR', 'BO_FINANCE'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SEGREGATION_OF_DUTIES');
    expect(
      (
        await a.http
          .post('/v1/backoffice/users')
          .set(bearer(admin.tokens.access_token))
          .send({
            email: `x.${uuidv7().slice(-6)}@broker.test`,
            fullName: 'Xavier',
            roles: ['BO_ADMIN', 'BO_AUDITOR'],
          })
      ).status,
    ).toBe(422);
    const { rows } =
      await sql`SELECT role FROM user_role WHERE user_id = ${created.body.userId}`.execute(env.db);
    expect(rows).toEqual([{ role: 'BO_AUDITOR' }]);
  });

  it('só BO_ADMIN administra; um cliente recebe 403', async () => {
    const c = await register(a);
    const t = await login(a, c);
    const res = await a.http
      .post('/v1/backoffice/users')
      .set(bearer(t.access_token))
      .send({ email: 'a@b.com', fullName: 'A', roles: ['BO_RISK'] });
    expect(res.status).toBe(403);
    await a.http.post('/v1/admin/signing-keys/rotate').set(bearer(t.access_token)).expect(403);
  });

  it('sessão do backoffice: 15 min de inatividade', async () => {
    const admin = await adminSession();
    a.clock.advanceBy(16 * 60_000);
    const res = await a.http.post('/v1/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: admin.tokens.refresh_token,
      client_id: CLIENTS.backoffice.id,
    });
    expect(res.body.error).toBe('invalid_grant');
  });

  it('client credentials pela API de administração', async () => {
    const admin = await adminSession();
    const res = await a.http
      .post('/v1/admin/clients')
      .set(bearer(admin.tokens.access_token))
      .send({ clientId: 'pix-receiver', scopes: ['ledger:deposit'] })
      .expect(201);
    const token = await a.http
      .post('/v1/oauth/token')
      .auth(res.body.clientId, res.body.clientSecret)
      .type('form')
      .send({ grant_type: 'client_credentials' })
      .expect(200);
    expect(decodeJwt(token.body.access_token)).toMatchObject({
      realm: 'services',
      scope: 'ledger:deposit',
      client_id: 'pix-receiver',
    });
  });
});

describe('13.6 account.status_changed (RN-AUTH-014)', () => {
  it('BLOCKED pelo barramento revoga os tokens de assinatura ativos do titular', async () => {
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-customer');
    const topic = topicName('test', 'customer');
    await ensureSuperStream(client, topic, { partitions: 2 });
    const live = await app(env, { stream, consumeCustomerEvents: true, clock: a.clock });
    await live.start();

    const c = await register(live);
    const customerId = uuidv7();
    const accountId = uuidv7();
    let t = await login(live, c);
    await live.http
      .put('/v1/me/trading-signature')
      .set(bearer(t.access_token))
      .send({ secret: '650321' })
      .expect(204);

    const producer = await PartitionedProducer.create(client, topic, `test.${uuidv7()}`);
    let publishingId = 0n;
    const send = async (
      eventType: string,
      partitionKey: string,
      payload: Record<string, unknown>,
    ) => {
      const e = {
        eventId: uuidv7(),
        eventType,
        eventVersion: 1,
        source: 'customer-service',
        environment: 'test',
        occurredAt: live.clock.now().toString(),
        partitionKey,
        correlationId: uuidv7(),
        actor: { type: 'SYSTEM', id: 'customer-service' },
        auditable: eventType === 'account.status_changed',
        payload,
      };
      await producer.sendAll([
        {
          partitionKey,
          publishingId: ++publishingId,
          messageId: e.eventId,
          body: Buffer.from(JSON.stringify(e)),
        },
      ]);
    };
    // A conta chega antes do cliente (tópico com partições diferentes): o identity junta os dois.
    await send('account.opened', accountId, {
      accountId,
      customerId,
      accountNumber: '000123-4',
      openedAt: live.clock.now().toString(),
    });
    await send('customer.created', customerId, {
      customerId,
      userId: c.userId,
      displayName: 'Maria',
      declaredNetWorth: '100000.00',
      pep: false,
    });
    const waitFor = async (cond: () => Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 50));
    };
    await waitFor(
      async () =>
        (
          await sql<{
            account_id: string | null;
          }>`SELECT account_id FROM "user" WHERE id = ${c.userId}`.execute(env.db)
        ).rows[0]?.account_id === accountId,
    );
    t = await login(live, c);
    expect(decodeJwt(t.access_token).account_id).toBe(accountId);

    const sig = (
      await live.http
        .post('/v1/me/trading-signature/verify')
        .set(bearer(t.access_token))
        .send({ secret: '650321', scope: 'ORDERS' })
        .expect(200)
    ).body;
    const expected = {
      scope: 'ORDERS' as const,
      userId: c.userId,
      sessionId: decodeJwt(t.access_token).session_id as string,
    };
    await live.signatureVerifier.verify(sig.signatureToken, expected);

    await send('account.status_changed', accountId, {
      accountId,
      from: 'ACTIVE',
      to: 'BLOCKED',
      reasonCode: 'FRAUD_SUSPECTED',
      actor: { type: 'BACKOFFICE', id: 'op-1' },
    });
    await waitFor(
      async () =>
        (
          await sql`SELECT 1 FROM signature_token WHERE user_id = ${c.userId} AND revoked_at IS NOT NULL`.execute(
            env.db,
          )
        ).rows.length > 0,
    );
    await expect(live.signatureVerifier.verify(sig.signatureToken, expected)).rejects.toMatchObject(
      { code: 'TRADING_SIGNATURE_REQUIRED' },
    );

    await live.stop();
    await client.close();
  });
});
