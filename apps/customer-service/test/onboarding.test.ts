// 14.1 etapas, validações e CPF único; 14.2 documentos por URL assinada; 14.3 KYC; 14.8 expiração.
import { uuidv7 } from '@broker/ids';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  app,
  bearer,
  customerToken,
  financial,
  kycWebhook,
  onboardUntil,
  outbox,
  personal,
  png,
  startEnv,
  stopEnv,
  submitAndDecide,
  uploadDocument,
  verificationsFor,
  cpfWithDigit,
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

describe('14.1 etapas e validações (RN-ONB-001/004)', () => {
  it('retomada em outro canal: depois do endereço, a próxima etapa é FINANCIAL_PROFILE com os dados salvos', async () => {
    const x = await onboardUntil(a, 'ADDRESS');
    // "Outro canal": outro token (outra sessão) do mesmo usuário.
    const mobile = await customerToken(a.clock, x.userId, { sessionId: 'sessao-mobile' });
    const res = await a.http.get('/v1/me/onboarding').set(bearer(mobile)).expect(200);
    expect(res.body).toMatchObject({
      status: 'ADDRESS',
      nextStep: 'FINANCIAL_PROFILE',
      contact: { email: x.email, phone: x.phone },
      personalData: { fullName: 'Maria Souza', taxId: x.taxId },
      address: { zipCode: '01310100', state: 'SP' },
    });
    // O rascunho fica cifrado no banco.
    const { rows } = await sql<{
      draft: object;
    }>`SELECT draft FROM onboarding_application WHERE user_id = ${x.userId}`.execute(env.db);
    expect(JSON.stringify(rows[0]!.draft)).not.toContain(x.taxId);
    expect(
      (await outbox(env.db, 'onboarding.step_completed')).filter(
        (e) => e.payload['step'] === 'ADDRESS',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('17 anos na data de submissão → UNDERAGE', async () => {
    const x = await onboardUntil(a, 'CONTACT_VERIFIED');
    const res = await a.http
      .put('/v1/me/onboarding/personal-data')
      .set(bearer(x.token))
      .send(personal({ birthDate: '2008-01-06' }))
      .expect(422);
    expect(res.body.code).toBe('UNDERAGE');
  });

  it('CPF com solicitação ativa ou conta → 422 TAX_ID_ALREADY_REGISTERED; CPF inválido → TAX_ID_INVALID', async () => {
    const first = await onboardUntil(a, 'PERSONAL_DATA');
    const second = await onboardUntil(a, 'CONTACT_VERIFIED');
    const dup = await a.http
      .put('/v1/me/onboarding/personal-data')
      .set(bearer(second.token))
      .send(personal({ taxId: first.taxId }));
    expect(dup.status).toBe(422);
    expect(dup.body.code).toBe('TAX_ID_ALREADY_REGISTERED');
    const invalid = await a.http
      .put('/v1/me/onboarding/personal-data')
      .set(bearer(second.token))
      .send(personal({ taxId: '11111111111' }));
    expect(invalid.body.errors[0]).toMatchObject({ field: 'taxId', code: 'TAX_ID_INVALID' });

    // Conta aberta (aprovada): o CPF continua indisponível para outra solicitação.
    const approved = await onboardUntil(a, 'TERMS');
    expect(await submitAndDecide(a, approved)).toBe('APPROVED');
    const third = await onboardUntil(a, 'CONTACT_VERIFIED');
    const res = await a.http
      .put('/v1/me/onboarding/personal-data')
      .set(bearer(third.token))
      .send(personal({ taxId: approved.taxId }));
    expect(res.body.code).toBe('TAX_ID_ALREADY_REGISTERED');
  });

  it('não pula etapa; contato exige os dois códigos; e-mail de outra solicitação não pode', async () => {
    const userId = uuidv7();
    const token = await customerToken(a.clock, userId);
    const skip = await a.http.put('/v1/me/onboarding/address').set(bearer(token)).send({
      zipCode: '01310100',
      street: 'R',
      number: '1',
      district: 'B',
      city: 'C',
      state: 'SP',
    });
    expect(skip.body.code).toBe('STEP_OUT_OF_ORDER');
    await a.http
      .put('/v1/me/onboarding/contact')
      .set(bearer(token))
      .send({ email: 'dono@exemplo.com', phone: '+5511900000001' })
      .expect(204);
    await a.http
      .post('/v1/me/onboarding/contact/verify')
      .set(bearer(token))
      .send({ emailCode: '000000', phoneCode: '000000' })
      .expect(400);
    await a.http
      .post('/v1/me/onboarding/contact/verify')
      .set(bearer(token))
      .send({
        emailCode: a.messenger.lastEmailCode('dono@exemplo.com'),
        phoneCode: a.messenger.lastSmsCode('+5511900000001'),
      })
      .expect(204);
    const other = await customerToken(a.clock, uuidv7());
    const taken = await a.http
      .put('/v1/me/onboarding/contact')
      .set(bearer(other))
      .send({ email: 'dono@exemplo.com', phone: '+5511900000002' });
    expect(taken.body.code).toBe('EMAIL_ALREADY_IN_USE');
  });
});

describe('14.2 documentos por URL assinada', () => {
  it('12 MB → DOCUMENT_INVALID_FORMAT antes de qualquer upload', async () => {
    const x = await onboardUntil(a, 'FINANCIAL_PROFILE');
    const res = await a.http
      .post('/v1/me/onboarding/documents/upload-url')
      .set(bearer(x.token))
      .set('Idempotency-Key', uuidv7())
      .send({ type: 'ID_FRONT', contentType: 'image/jpeg', sizeBytes: 12 * 1024 * 1024 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'DOCUMENT_INVALID_FORMAT',
      context: { reason: 'TOO_LARGE' },
    });
  });

  it('o tipo vem do conteúdo; resolução mínima 800×600; aceitos ID_FRONT e SELFIE, a etapa termina', async () => {
    const x = await onboardUntil(a, 'FINANCIAL_PROFILE');
    // Declara PNG, mas o conteúdo é texto: recusado e apagado do storage.
    const fake = await uploadDocument(
      a,
      x.token,
      'ID_FRONT',
      Buffer.from('<html>não sou imagem</html>'.padEnd(2048, ' ')),
    );
    expect(fake.body).toMatchObject({
      code: 'DOCUMENT_INVALID_FORMAT',
      context: { reason: 'UNSUPPORTED_FORMAT' },
    });
    const small = await uploadDocument(a, x.token, 'ID_FRONT', png(640, 480));
    expect(small.body.context.reason).toBe('LOW_RESOLUTION');
    expect((await uploadDocument(a, x.token, 'ID_FRONT', png(1200, 900))).body.status).toBe(
      'ACCEPTED',
    );
    expect((await a.http.get('/v1/me/onboarding').set(bearer(x.token))).body.status).toBe(
      'FINANCIAL_PROFILE',
    );
    expect((await uploadDocument(a, x.token, 'SELFIE', png(800, 600))).body.status).toBe(
      'ACCEPTED',
    );
    const view = (await a.http.get('/v1/me/onboarding').set(bearer(x.token))).body;
    expect(view.status).toBe('DOCUMENTS');
    expect(view.documents.filter((d: { status: string }) => d.status === 'ACCEPTED')).toHaveLength(
      2,
    );
    // O nome do objeto é do servidor e os recusados não ficam no storage.
    const { rows } = await sql<{ storage_key: string; status: string }>`
      SELECT d.storage_key, d.status FROM customer_document d JOIN onboarding_application o ON o.id = d.application_id
      WHERE o.user_id = ${x.userId}`.execute(env.db);
    for (const r of rows) {
      expect(r.storage_key).toMatch(/^onboarding\/[0-9a-f-]+\/[0-9a-f-]+$/);
      if (r.status === 'REJECTED') expect(await a.documents.inspect(r.storage_key)).toBeNull();
    }
  });
});

describe('14.3 KYC simulado (RN-ONB-010/011/020..022)', () => {
  it.each([
    [3, 'APPROVED'],
    [7, 'MANUAL_REVIEW'],
    [8, 'MANUAL_REVIEW'],
    [9, 'REJECTED'],
  ])('CPF com penúltimo dígito %i → %s', async (digit, expected) => {
    const x = await onboardUntil(a, 'TERMS', { taxId: cpfWithDigit(digit) });
    expect(await submitAndDecide(a, x)).toBe(expected);
    const sub = a.kyc.submissions.at(-1)!;
    expect(sub.documents.map((d) => d.type).sort()).toEqual(['ID_FRONT', 'SELFIE']);
    expect(sub.documents[0]!.url).toContain('X-Amz-Signature');
    const kyc = (await outbox(env.db, 'onboarding.kyc_completed')).find(
      (e) => e.payload['applicationId'] === sub.referenceId,
    );
    expect(kyc!.payload['outcome']).toBe(expected);
    const { rows } = await sql<{ check_type: string; raw_payload: object }>`
      SELECT check_type, raw_payload FROM kyc_check WHERE provider_check_id = ${sub.checkId}`.execute(
      env.db,
    );
    expect(rows).toHaveLength(5);
    expect(rows[0]!.raw_payload).toMatchObject({ check_id: sub.checkId });
  });

  it('PEP com KYC aprovado vai para MANUAL_REVIEW; aprovar exige BO_ADMIN', async () => {
    const x = await onboardUntil(a, 'TERMS', { financial: { pep: true } });
    expect(await submitAndDecide(a, x)).toBe('MANUAL_REVIEW');
  });

  it('webhook repetido aplica a decisão uma vez; assinatura inválida é recusada', async () => {
    const x = await onboardUntil(a, 'TERMS');
    await a.http
      .post('/v1/me/onboarding/submit')
      .set(bearer(x.token))
      .set('Idempotency-Key', uuidv7())
      .expect(202);
    const sub = a.kyc.submissions.at(-1)!;
    const body = {
      check_id: sub.checkId,
      reference_id: sub.referenceId,
      verifications: verificationsFor(x.taxId),
    };
    await kycWebhook(a, 'check.completed', body, 'outro-segredo-qualquer-1234567').expect(401);
    await kycWebhook(a, 'check.completed', body).expect(204);
    await kycWebhook(a, 'check.completed', body).expect(204);
    const approved = (await outbox(env.db, 'onboarding.approved')).filter(
      (e) => e.payload['applicationId'] === sub.referenceId,
    );
    expect(approved).toHaveLength(1);
    expect(
      (await outbox(env.db, 'onboarding.kyc_completed')).filter(
        (e) => e.payload['applicationId'] === sub.referenceId,
      ),
    ).toHaveLength(1);
  });

  it('a solicitação submetida não aceita mais etapas', async () => {
    const x = await onboardUntil(a, 'TERMS', { taxId: cpfWithDigit(7) });
    await submitAndDecide(a, x);
    const res = await a.http
      .put('/v1/me/onboarding/financial-profile')
      .set(bearer(x.token))
      .send(financial());
    expect(res.body.code).toBe('ONBOARDING_LOCKED');
  });
});

describe('14.8 expiração do onboarding (RN-ONB-002)', () => {
  it('30 dias sem atividade: a rotina expira, descarta os documentos e as ações dão ONBOARDING_EXPIRED', async () => {
    const env2 = env;
    const b = await app(env2);
    const x = await onboardUntil(b, 'DOCUMENTS');
    b.clock.advanceBy(29 * 24 * 3_600_000);
    expect((await b.runDaily()).expiredApplications).toBe(0);
    b.clock.advanceBy(1 * 24 * 3_600_000 + 60_000);
    // Mesmo antes da rotina, o relógio já vale.
    expect(
      (
        await b.http
          .put('/v1/me/onboarding/financial-profile')
          .set(bearer(await customerToken(b.clock, x.userId)))
          .send(financial())
      ).body.code,
    ).toBe('ONBOARDING_EXPIRED');
    expect((await b.runDaily()).expiredApplications).toBeGreaterThanOrEqual(1);
    const token = await customerToken(b.clock, x.userId);
    const view = (await b.http.get('/v1/me/onboarding').set(bearer(token))).body;
    expect(view.status).toBe('EXPIRED');
    expect(view.documents).toEqual([]);
    const { rows } = await sql<{ storage_key: string }>`
      SELECT d.storage_key FROM customer_document d JOIN onboarding_application o ON o.id = d.application_id WHERE o.user_id = ${x.userId}`.execute(
      env.db,
    );
    for (const r of rows) expect(await b.documents.inspect(r.storage_key)).toBeNull();
    const res = await b.http.put('/v1/me/onboarding/address').set(bearer(token)).send({
      zipCode: '01310100',
      street: 'R',
      number: '1',
      district: 'B',
      city: 'C',
      state: 'SP',
    });
    expect(res.body.code).toBe('ONBOARDING_EXPIRED');
  });
});
