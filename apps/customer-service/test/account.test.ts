// 14.5 suitability e termos; 14.6 status, restrição por saldo devedor e encerramento; 14.7 contas de saque e cadastro.
import { uuidv7 } from '@broker/ids';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  answersFor,
  app,
  backofficeToken,
  bearer,
  customerToken,
  onboardUntil,
  outbox,
  serviceToken,
  signatureToken,
  startEnv,
  stopEnv,
  submitAndDecide,
  type App,
  type Applicant,
  type Env,
} from './helpers.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
  a = await app(env);
}, 180_000);
afterAll(() => stopEnv(env));

type Customer = Applicant & { accountId: string; customerId: string };

async function customer(points = 32): Promise<Customer> {
  const x = await onboardUntil(a, 'TERMS', { points });
  expect(await submitAndDecide(a, x)).toBe('APPROVED');
  const profile = (await a.http.get('/v1/me/profile').set(bearer(x.token)).expect(200)).body;
  return { ...x, accountId: profile.account.accountId, customerId: profile.customerId };
}

const eligibility = async (accountId: string, operation: string) =>
  (
    await a.http
      .get(`/v1/internal/accounts/${accountId}/eligibility`)
      .query({ operation })
      .set(bearer(await serviceToken(a.clock, ['customer:eligibility'])))
      .expect(200)
  ).body as { allowed: boolean; code?: string; status: string };

const statusEvents = async (accountId: string) =>
  (await outbox(env.db, 'account.status_changed'))
    .filter((e) => e.payload['accountId'] === accountId)
    .map((e) => e.payload);

describe('14.5 suitability e termos (RN-SUI-*, RN-TER-*)', () => {
  it('32 pontos → AGGRESSIVE e suitability.assessed; refazer vale a mais recente', async () => {
    const c = await customer();
    const res = await a.http
      .post('/v1/me/suitability/assessments')
      .set(bearer(c.token))
      .send({ questionnaireVersion: 1, answers: answersFor(32) })
      .expect(201);
    expect(res.body).toMatchObject({ profile: 'AGGRESSIVE', score: 32, validUntil: '2028-01-05' });
    await a.http
      .post('/v1/me/suitability/assessments')
      .set(bearer(c.token))
      .send({ questionnaireVersion: 1, answers: answersFor(10) })
      .expect(201);
    const assessed = (await outbox(env.db, 'suitability.assessed'))
      .filter((e) => e.payload['customerId'] === c.customerId)
      .map((e) => e.payload['profile']);
    expect(assessed).toEqual(['AGGRESSIVE', 'AGGRESSIVE', 'CONSERVATIVE']);
    expect((await a.http.get('/v1/me/profile').set(bearer(c.token))).body.suitability.profile).toBe(
      'CONSERVATIVE',
    );
    // O questionário não mostra pesos; versão antiga é recusada.
    const q = (await a.http.get('/v1/suitability/questionnaire').set(bearer(c.token))).body;
    expect(JSON.stringify(q)).not.toContain('weight');
    expect(
      (
        await a.http
          .post('/v1/me/suitability/assessments')
          .set(bearer(c.token))
          .send({ questionnaireVersion: 0, answers: {} })
      ).status,
    ).toBe(400);
  });

  it('nova versão do contrato de intermediação: TERMS_PENDING até o novo aceite (com hash, IP e canal)', async () => {
    const c = await customer();
    expect(await eligibility(c.accountId, 'BUY')).toMatchObject({ allowed: true });
    await a.http
      .post('/v1/bo/terms/INTERMEDIATION_AGREEMENT/versions')
      .set(bearer(await backofficeToken(a.clock, ['BO_ADMIN'])))
      .send({
        title: 'Contrato de intermediação',
        content: 'Contrato de intermediação, versão 2, com cláusula nova.',
      })
      .expect(201);
    expect(await eligibility(c.accountId, 'BUY')).toMatchObject({
      allowed: false,
      code: 'TERMS_PENDING',
    });
    expect(await eligibility(c.accountId, 'LOGIN')).toMatchObject({ allowed: true });
    const pending = (await a.http.get('/v1/me/terms/pending').set(bearer(c.token))).body.terms.find(
      (t: { code: string }) => t.code === 'INTERMEDIATION_AGREEMENT',
    );
    expect(pending.version).toBe(2);
    await a.http
      .post(`/v1/me/terms/${pending.termsId}/accept`)
      .set(bearer(c.token))
      .set('User-Agent', 'app-web/1.0')
      .set('X-Client-Channel', 'WEB')
      .send({ version: 2 })
      .expect(204);
    expect(await eligibility(c.accountId, 'BUY')).toMatchObject({ allowed: true });
    const { rows } = await sql<{ channel: string; user_agent: string; content_hash: string }>`
      SELECT channel, user_agent, content_hash FROM terms_acceptance WHERE terms_id = ${pending.termsId}`.execute(
      env.db,
    );
    expect(rows[0]).toMatchObject({ channel: 'WEB', user_agent: 'app-web/1.0' });
    expect(rows[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('aviso 30 dias antes; vencido em 24 meses: suitability.expired e compra exige refazer', async () => {
    const b = await app(env);
    const prev = a;
    a = b;
    try {
      const c = await customer();
      b.clock.advanceBy((365 * 2 - 25) * 24 * 3_600_000);
      await b.runDaily();
      expect(
        (await outbox(env.db, 'suitability.expiring')).filter(
          (e) => e.payload['customerId'] === c.customerId,
        ),
      ).toHaveLength(1);
      b.clock.advanceBy(30 * 24 * 3_600_000);
      await b.runDaily();
      await b.runDaily();
      expect(
        (await outbox(env.db, 'suitability.expired')).filter(
          (e) => e.payload['customerId'] === c.customerId,
        ),
      ).toHaveLength(1);
      // O cadastro vence junto (também 24 meses): o cliente confirma os dados; o suitability segue vencido.
      await b.http
        .post('/v1/me/profile/confirm')
        .set(bearer(await customerToken(b.clock, c.userId)))
        .expect(200);
      expect(await eligibility(c.accountId, 'BUY')).toMatchObject({
        allowed: false,
        code: 'SUITABILITY_EXPIRED',
      });
      expect(await eligibility(c.accountId, 'SELL')).toMatchObject({ allowed: true });
    } finally {
      a = prev;
    }
  });
});

describe('14.6 status da conta (RN-ACC-010..012, RN-DEV-002/005)', () => {
  it('saldo devedor → RESTRICTED (não compra, ACCOUNT_NOT_ACTIVE); coberto → ACTIVE', async () => {
    const c = await customer();
    const ledger = { type: 'SYSTEM' as const, id: 'ledger-service' };
    await a.store.transaction((tx) =>
      a.accounts.setRestriction(tx, c.accountId, 'NEGATIVE_BALANCE', true, ledger),
    );
    expect(await eligibility(c.accountId, 'BUY')).toMatchObject({
      allowed: false,
      code: 'ACCOUNT_NOT_ACTIVE',
      status: 'RESTRICTED',
    });
    expect(await eligibility(c.accountId, 'WITHDRAW')).toMatchObject({ allowed: false });
    expect(await eligibility(c.accountId, 'SELL')).toMatchObject({ allowed: true });
    await a.store.transaction((tx) =>
      a.accounts.setRestriction(tx, c.accountId, 'NEGATIVE_BALANCE', false, ledger),
    );
    expect(await eligibility(c.accountId, 'BUY')).toMatchObject({
      allowed: true,
      status: 'ACTIVE',
    });
    expect(await statusEvents(c.accountId)).toEqual([
      {
        accountId: c.accountId,
        from: 'ACTIVE',
        to: 'RESTRICTED',
        reasonCode: 'NEGATIVE_BALANCE',
        restrictions: ['NEGATIVE_BALANCE'],
        actor: ledger,
      },
      {
        accountId: c.accountId,
        from: 'RESTRICTED',
        to: 'ACTIVE',
        reasonCode: 'NEGATIVE_BALANCE_CLEARED',
        restrictions: [],
        actor: ledger,
      },
    ]);
  });

  it('bloqueio pelo backoffice publica BLOCKED (o OMS cancela as ordens); desbloqueio só BO_ADMIN', async () => {
    const c = await customer();
    await a.http
      .post(`/v1/bo/accounts/${c.accountId}/block`)
      .set(bearer(await backofficeToken(a.clock, ['BO_SUPPORT'])))
      .send({ reasonCode: 'FRAUD_SUSPECTED' })
      .expect(403);
    await a.http
      .post(`/v1/bo/accounts/${c.accountId}/block`)
      .set(bearer(await backofficeToken(a.clock, ['BO_RISK'], 'risk-1')))
      .send({ reasonCode: 'FRAUD_SUSPECTED' })
      .expect(200);
    expect(await eligibility(c.accountId, 'DEPOSIT')).toMatchObject({
      allowed: false,
      status: 'BLOCKED',
    });
    expect((await statusEvents(c.accountId)).at(-1)).toMatchObject({
      to: 'BLOCKED',
      reasonCode: 'FRAUD_SUSPECTED',
      actor: { type: 'BACKOFFICE', id: 'risk-1' },
    });
    await a.http
      .post(`/v1/bo/accounts/${c.accountId}/unblock`)
      .set(bearer(await backofficeToken(a.clock, ['BO_RISK'])))
      .send({ reasonCode: 'FALSE_POSITIVE' })
      .expect(403);
    await a.http
      .post(`/v1/bo/accounts/${c.accountId}/unblock`)
      .set(bearer(await backofficeToken(a.clock, ['BO_ADMIN'])))
      .send({ reasonCode: 'FALSE_POSITIVE' })
      .expect(200);
    expect(await eligibility(c.accountId, 'BUY')).toMatchObject({ allowed: true });
  });

  it('encerramento com R$ 50,00 de saldo: lista a pendência e a conta continua ACTIVE; sem pendências, CLOSED', async () => {
    const c = await customer();
    a.closure.find((x) => x.source === 'LEDGER')!.pending = [
      {
        source: 'LEDGER',
        code: 'BALANCE_NOT_ZERO',
        message: 'Saldo de R$ 50,00: saque antes de encerrar.',
      },
    ];
    const res = await a.http.post('/v1/me/account/close').set(bearer(c.token));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'ACCOUNT_CLOSURE_PENDING',
      context: { pendencies: [{ source: 'LEDGER', code: 'BALANCE_NOT_ZERO' }] },
    });
    expect(await eligibility(c.accountId, 'BUY')).toMatchObject({ status: 'ACTIVE' });

    a.closure.find((x) => x.source === 'LEDGER')!.pending = [];
    expect(
      (await a.http.post('/v1/me/account/close').set(bearer(c.token)).expect(200)).body.status,
    ).toBe('CLOSED');
    expect((await statusEvents(c.accountId)).map((e) => e['to'])).toEqual(['CLOSING', 'CLOSED']);
  });

  it('sem um dos verificadores de pendência, o encerramento fica indisponível (não encerra às cegas)', async () => {
    const b = await app(env, { closureChecks: [] });
    const prev = a;
    a = b;
    try {
      const c = await customer();
      const res = await b.http.post('/v1/me/account/close').set(bearer(c.token));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CLOSURE_CHECK_UNAVAILABLE');
    } finally {
      a = prev;
    }
  });
});

describe('14.7 contas de saque (RN-ACC-020/021)', () => {
  it('chave de terceiro → BANK_ACCOUNT_NOT_ALLOWED; a própria entra com carência de 24 h; no máximo 3', async () => {
    const c = await customer();
    a.bank.keys.set('terceiro@exemplo.com', {
      type: 'EMAIL',
      cpf: '52998224725',
      name: 'José Silva',
    });
    for (const k of ['k1@exemplo.com', 'k2@exemplo.com', 'k3@exemplo.com', 'k4@exemplo.com'])
      a.bank.keys.set(k, { type: 'EMAIL', cpf: c.taxId, name: 'Maria Souza' });
    const mfa = await customerToken(a.clock, c.userId, { mfaAgoSec: 60 });
    const add = async (pixKey: string, token = mfa) =>
      a.http
        .post('/v1/me/withdrawal-accounts')
        .set(bearer(token))
        .set('X-Trading-Signature', await signatureToken(a.clock, c.userId, 'SETTINGS'))
        .set('Idempotency-Key', uuidv7())
        .send({ pixKey });

    const third = await add('terceiro@exemplo.com');
    expect(third.status).toBe(422);
    expect(third.body.code).toBe('BANK_ACCOUNT_NOT_ALLOWED');
    // Sem assinatura ou sem MFA recente, nem chega a consultar a chave.
    expect(
      (
        await a.http
          .post('/v1/me/withdrawal-accounts')
          .set(bearer(mfa))
          .set('Idempotency-Key', uuidv7())
          .send({ pixKey: 'k1@exemplo.com' })
      ).body.code,
    ).toBe('TRADING_SIGNATURE_REQUIRED');
    expect((await add('k1@exemplo.com', c.token)).body.code).toBe('STEP_UP_REQUIRED');

    const ok = await add('k1@exemplo.com');
    expect(ok.status).toBe(201);
    expect(Date.parse(ok.body.availableFrom) - a.clock.now().epochMillis).toBe(24 * 3_600_000);
    expect((await add('k1@exemplo.com')).status).toBe(409);
    await add('k2@exemplo.com').then((r) => expect(r.status).toBe(201));
    await add('k3@exemplo.com').then((r) => expect(r.status).toBe(201));
    expect((await add('k4@exemplo.com')).body.code).toBe('WITHDRAWAL_ACCOUNT_LIMIT');
    const list = (await a.http.get('/v1/me/withdrawal-accounts').set(bearer(c.token))).body
      .accounts;
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({
      available: false,
      pixKey: expect.stringMatching(/^\*+\.com$/) as unknown as string,
    });
  });

  it('consultas internas do ledger: titularidade pelo HMAC e destino do saque só para a própria conta', async () => {
    const c = await customer();
    const other = await customer();
    a.bank.keys.set('destino@exemplo.com', { type: 'EMAIL', cpf: c.taxId, name: 'Maria Souza' });
    const added = await a.http
      .post('/v1/me/withdrawal-accounts')
      .set(bearer(await customerToken(a.clock, c.userId, { mfaAgoSec: 60 })))
      .set('X-Trading-Signature', await signatureToken(a.clock, c.userId, 'SETTINGS'))
      .set('Idempotency-Key', uuidv7())
      .send({ pixKey: 'destino@exemplo.com' })
      .expect(201);

    const holder = await serviceToken(a.clock, ['customer:holder']);
    const match = (accountId: string, taxId: string) =>
      a.http
        .post(`/v1/internal/accounts/${accountId}/holder-match`)
        .set(bearer(holder))
        .send({ taxId });
    expect((await match(c.accountId, c.taxId).expect(200)).body).toEqual({ matches: true });
    expect((await match(c.accountId, other.taxId).expect(200)).body).toEqual({ matches: false });
    // Sem o escopo, nada (o escopo de elegibilidade não serve).
    expect(
      (
        await a.http
          .post(`/v1/internal/accounts/${c.accountId}/holder-match`)
          .set(bearer(await serviceToken(a.clock, ['customer:eligibility'])))
          .send({ taxId: c.taxId })
      ).status,
    ).toBe(403);

    const dest = await serviceToken(a.clock, ['customer:withdrawal-accounts']);
    const destination = (
      await a.http
        .get(`/v1/internal/accounts/${c.accountId}/withdrawal-accounts/${added.body.id}`)
        .set(bearer(dest))
        .expect(200)
    ).body;
    expect(destination).toMatchObject({
      id: added.body.id,
      status: 'ACTIVE',
      pixKey: 'destino@exemplo.com',
      available: false,
      holderTaxId: c.taxId,
    });
    await a.http
      .get(`/v1/internal/accounts/${other.accountId}/withdrawal-accounts/${added.body.id}`)
      .set(bearer(dest))
      .expect(404);
  });
});

describe('14.7 manutenção cadastral (RN-CAD-001..004)', () => {
  it('troca de nome: fica pendente de revisão; aprovada, o histórico registra a versão anterior', async () => {
    const c = await customer();
    const req = await a.http
      .post('/v1/me/profile/reviewed-changes')
      .set(bearer(c.token))
      .send({ kind: 'NAME', fullName: 'Maria Souza Lima' })
      .expect(202);
    expect(req.body.uploadUrl).toContain('X-Amz-Signature');
    expect((await a.http.get('/v1/me/profile').set(bearer(c.token))).body.fullName).toBe(
      'Maria Souza',
    );
    const queue = (
      await a.http
        .get('/v1/bo/profile-changes')
        .set(bearer(await backofficeToken(a.clock, ['BO_ONBOARDING'])))
    ).body.items;
    expect(queue.map((i: { changeId: string }) => i.changeId)).toContain(req.body.changeId);
    await a.http
      .post(`/v1/bo/profile-changes/${req.body.changeId}/approve`)
      .set(bearer(await backofficeToken(a.clock, ['BO_ONBOARDING'], 'op-7')))
      .expect(204);
    expect((await a.http.get('/v1/me/profile').set(bearer(c.token))).body.fullName).toBe(
      'Maria Souza Lima',
    );
    expect((await a.http.get('/v1/me/profile/history').set(bearer(c.token))).body.history).toEqual([
      expect.objectContaining({ field: 'fullName', actorId: 'op-7' }),
    ]);
    const { rows } = await sql<{
      old_value_enc: string;
    }>`SELECT old_value_enc FROM customer_change_history WHERE customer_id = ${c.customerId}`.execute(
      env.db,
    );
    expect(a.fields.open(rows[0]!.old_value_enc, 'customer_change_history.value')).toBe(
      'Maria Souza',
    );
    expect(
      (await outbox(env.db, 'customer.updated')).filter(
        (e) => e.payload['customerId'] === c.customerId,
      )[0]!.payload,
    ).toEqual({
      customerId: c.customerId,
      changedFields: ['fullName'],
    });
  });

  it('troca de celular: assinatura + código no celular antigo e no novo', async () => {
    const c = await customer();
    const sig = await signatureToken(a.clock, c.userId, 'SETTINGS');
    await a.http
      .post('/v1/me/profile/contact-changes')
      .set(bearer(c.token))
      .send({ kind: 'PHONE', phone: '+5521988887777' })
      .expect(403);
    const req = await a.http
      .post('/v1/me/profile/contact-changes')
      .set(bearer(c.token))
      .set('X-Trading-Signature', sig)
      .send({ kind: 'PHONE', phone: '+5521988887777' })
      .expect(202);
    const oldCode = a.messenger.lastSmsCode(c.phone);
    const newCode = a.messenger.lastSmsCode('+5521988887777');
    await a.http
      .post(`/v1/me/profile/contact-changes/${req.body.changeId}/confirm`)
      .set(bearer(c.token))
      .send({ oldCode: newCode, newCode: oldCode })
      .expect(400);
    await a.http
      .post(`/v1/me/profile/contact-changes/${req.body.changeId}/confirm`)
      .set(bearer(c.token))
      .send({ oldCode, newCode })
      .expect(204);
    expect((await a.http.get('/v1/me/profile').set(bearer(c.token))).body.phone).toBe(
      '+5521988887777',
    );
  });

  it('cadastro vencido há 24 meses → RESTRICTED; confirmar os dados volta a ACTIVE', async () => {
    const b = await app(env);
    const prev = a;
    a = b;
    try {
      const c = await customer();
      b.clock.advanceBy((365 * 2 + 2) * 24 * 3_600_000);
      await b.runDaily();
      expect(await eligibility(c.accountId, 'BUY')).toMatchObject({
        allowed: false,
        status: 'RESTRICTED',
      });
      const token = await customerToken(b.clock, c.userId);
      await b.http.post('/v1/me/profile/confirm').set(bearer(token)).expect(200);
      expect((await eligibility(c.accountId, 'DEPOSIT')).status).toBe('ACTIVE');
      expect((await statusEvents(c.accountId)).map((e) => e['reasonCode'])).toEqual([
        'REGISTRATION_EXPIRED',
        'REGISTRATION_EXPIRED_CLEARED',
      ]);
    } finally {
      a = prev;
    }
  });
});
