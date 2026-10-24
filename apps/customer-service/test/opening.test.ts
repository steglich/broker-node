// 14.4 saga de abertura (aprovação → conta NNNNNNN-D → eventos) com retomada; 14.8 conta no Banco Simulado.
import { uuidv7 } from '@broker/ids';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidAccountNumber } from '../src/domain/account.js';
import {
  app,
  backofficeToken,
  bearer,
  cpfWithDigit,
  kycWebhook,
  onboardUntil,
  outbox,
  startEnv,
  stopEnv,
  submitAndDecide,
  verificationsFor,
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

const accountsOf = async (userId: string) =>
  (
    await sql<{ account_number: string; bank_account_id: string | null; status: string }>`
      SELECT a.account_number, a.bank_account_id, a.status FROM investment_account a JOIN customer c ON c.id = a.customer_id
      WHERE c.user_id = ${userId}`.execute(env.db)
  ).rows;

describe('14.4 saga de abertura de conta', () => {
  it('KYC aprovado → cliente, conta NNNNNNN-D, eventos e conta no Banco Simulado, uma vez cada', async () => {
    const x = await onboardUntil(a, 'TERMS', { points: 32 });
    expect(await submitAndDecide(a, x)).toBe('APPROVED');
    const [account] = await accountsOf(x.userId);
    expect(account).toMatchObject({ status: 'ACTIVE' });
    expect(isValidAccountNumber(account!.account_number)).toBe(true);
    expect(account!.bank_account_id).toBeTruthy();
    expect(a.bank.accounts.filter((b) => b.taxId === x.taxId)).toHaveLength(1);

    const customerId = (
      await sql<{ id: string }>`SELECT id FROM customer WHERE user_id = ${x.userId}`.execute(env.db)
    ).rows[0]!.id;
    const mine = (await outbox(env.db)).filter((e) =>
      JSON.stringify(e.payload).includes(customerId),
    );
    expect(mine.map((e) => e.event_type)).toEqual([
      'onboarding.approved',
      'customer.created',
      'account.opened',
      'suitability.assessed',
    ]);
    expect(mine[1]!.payload).toMatchObject({
      userId: x.userId,
      displayName: 'Maria',
      declaredNetWorth: '150000.00',
      pep: false,
    });
    expect(mine[3]!.payload).toMatchObject({
      profile: 'AGGRESSIVE',
      score: 32,
      questionnaireVersion: 1,
    });
    expect(JSON.stringify(mine)).not.toContain(x.taxId);
  });

  it('reinício depois da aprovação e antes da conta: a retomada cria a conta uma única vez', async () => {
    // Instância que "cai" logo depois de gravar a aprovação: a saga nem começa.
    const crashing = await app(env, { clock: a.clock });
    (crashing.sagas as unknown as { start: () => Promise<never> }).start = async () => {
      throw new Error('processo morreu');
    };
    const x = await onboardUntil(crashing, 'TERMS');
    expect(await submitAndDecide(crashing, x)).toBe('APPROVED');
    expect(await accountsOf(x.userId)).toEqual([]);

    // A instância nova sobe e retoma; rodar de novo (outra réplica, outro ciclo) não duplica.
    const restarted = await app(env, { clock: a.clock });
    await restarted.resumeOpenings();
    await restarted.resumeOpenings();
    await a.resumeOpenings();
    expect(await accountsOf(x.userId)).toHaveLength(1);
    const customerId = (
      await sql<{ id: string }>`SELECT id FROM customer WHERE user_id = ${x.userId}`.execute(env.db)
    ).rows[0]!.id;
    expect(
      (await outbox(env.db, 'account.opened')).filter(
        (e) => e.payload['customerId'] === customerId,
      ),
    ).toHaveLength(1);
    const appId = (
      await sql<{
        id: string;
      }>`SELECT id FROM onboarding_application WHERE user_id = ${x.userId}`.execute(env.db)
    ).rows[0]!.id;
    expect(
      (await outbox(env.db, 'onboarding.approved')).filter(
        (e) => e.payload['applicationId'] === appId,
      ),
    ).toHaveLength(1);
  });

  it('Banco Simulado fora do ar: o passo é repetido; a conta de investimento não duplica', async () => {
    const b = await app(env, { clock: a.clock });
    b.bank.failNextOpen = 2;
    const x = await onboardUntil(b, 'TERMS');
    expect(await submitAndDecide(b, x)).toBe('APPROVED');
    const [account] = await accountsOf(x.userId);
    expect(account!.bank_account_id).toBeTruthy();
    expect(await accountsOf(x.userId)).toHaveLength(1);
    expect(b.bank.accounts).toHaveLength(1);
  });
});

describe('revisão manual (backoffice)', () => {
  it('PEP: BO_ONBOARDING não aprova (403); BO_ADMIN aprova e a conta é aberta', async () => {
    const x = await onboardUntil(a, 'TERMS', { financial: { pep: true } });
    expect(await submitAndDecide(a, x)).toBe('MANUAL_REVIEW');
    const appId = (
      await sql<{
        id: string;
      }>`SELECT id FROM onboarding_application WHERE user_id = ${x.userId}`.execute(env.db)
    ).rows[0]!.id;
    const queue = await a.http
      .get('/v1/bo/onboarding/queue')
      .set(bearer(await backofficeToken(a.clock, ['BO_ONBOARDING'])))
      .expect(200);
    expect(queue.body.items.map((i: { applicationId: string }) => i.applicationId)).toContain(
      appId,
    );
    const denied = await a.http
      .post(`/v1/bo/onboarding/${appId}/approve`)
      .set(bearer(await backofficeToken(a.clock, ['BO_ONBOARDING'])))
      .send({ reason: 'documentação conferida' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PEP_APPROVAL_REQUIRES_ADMIN');
    await a.http
      .post(`/v1/bo/onboarding/${appId}/approve`)
      .set(bearer(await backofficeToken(a.clock, ['BO_ADMIN'], 'admin-1')))
      .send({ reason: 'PEP aprovado pela diretoria' })
      .expect(200);
    expect(await accountsOf(x.userId)).toHaveLength(1);
    expect(
      (await outbox(env.db, 'onboarding.approved')).find(
        (e) => e.payload['applicationId'] === appId,
      )!.payload,
    ).toMatchObject({
      decidedBy: 'admin-1',
    });
  });

  it('pedir correção devolve ao cliente, que corrige e submete de novo', async () => {
    const x = await onboardUntil(a, 'TERMS', { taxId: cpfWithDigit(7) });
    expect(await submitAndDecide(a, x)).toBe('MANUAL_REVIEW');
    const appId = (
      await sql<{
        id: string;
      }>`SELECT id FROM onboarding_application WHERE user_id = ${x.userId}`.execute(env.db)
    ).rows[0]!.id;
    await a.http
      .post(`/v1/bo/onboarding/${appId}/request-changes`)
      .set(bearer(await backofficeToken(a.clock, ['BO_ONBOARDING'])))
      .send({ reason: 'selfie desfocada' })
      .expect(200);
    const view = (await a.http.get('/v1/me/onboarding').set(bearer(x.token))).body;
    expect(view).toMatchObject({
      status: 'PENDING_CUSTOMER',
      nextStep: 'SUBMIT',
      decisionReason: 'selfie desfocada',
    });
    await a.http
      .post('/v1/me/onboarding/submit')
      .set(bearer(x.token))
      .set('Idempotency-Key', uuidv7())
      .expect(202);
    const sub = a.kyc.submissions.at(-1)!;
    // Na nova análise, a selfie passou.
    const verifications = verificationsFor(cpfWithDigit(3));
    await kycWebhook(a, 'check.completed', {
      check_id: sub.checkId,
      reference_id: sub.referenceId,
      verifications,
    }).expect(204);
    expect((await a.http.get('/v1/me/onboarding').set(bearer(x.token))).body.status).toBe(
      'APPROVED',
    );
  });
});
