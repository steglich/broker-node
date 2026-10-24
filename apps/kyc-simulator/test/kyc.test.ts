// Testes de componente do provedor de KYC (Sistemas simulados §3, Onboarding §5): simulador em
// processo, Postgres e MinIO reais (URL pré-assinada de verdade) e um receptor de webhook.
import { generateCpf, seededRandom, type KycScenarioDigit } from '@broker/testing';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { png, startEnvironment } from './helpers.js';

type Env = Awaited<ReturnType<typeof startEnvironment>>;
let env: Env;
let front: string;
let selfie: string;
beforeAll(async () => {
  env = await startEnvironment();
  front = await env.upload('c1/front.png', png(1200, 900));
  selfie = await env.upload('c1/selfie.png', png(1080, 1080));
});
afterAll(() => env?.stop());

const submission = (taxId: string, documents?: Array<{ type: string; url: string }>) => ({
  reference_id: `cliente-${taxId}`,
  tax_id: taxId,
  full_name: 'Joana Teste',
  birth_date: '1990-05-17',
  documents: documents ?? [
    { type: 'ID_FRONT', url: front },
    { type: 'SELFIE', url: selfie },
  ],
});

const cpf = (digit: KycScenarioDigit, seed = digit) =>
  generateCpf({ penultimateDigit: digit, random: seededRandom(seed + 100) });
const byType = (verifications: Array<{ type: string }>) =>
  Object.fromEntries(verifications.map((v) => [v.type, v]));

describe('submissão e resultado assíncrono (§3, RN-ONB-021)', () => {
  it('responde 202 com check_id e entrega um webhook por verificação depois da latência', async () => {
    const sim = await env.simulator();
    const res = await request(sim.app)
      .post('/v1/checks')
      .send(submission(cpf(3)));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      check_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PROCESSING',
    });
    const id = res.body.check_id as string;

    expect(await sim.provider.runDue()).toBe(0); // ainda dentro da latência simulada
    expect((await request(sim.app).get(`/v1/checks/${id}`)).body.status).toBe('PROCESSING');
    expect(await sim.complete()).toBe(1);

    const events = env.received.map((r) => r.headers['x-webhook-event']);
    expect(events).toEqual([...Array(5).fill('check.verification_completed'), 'check.completed']);
    expect(env.received.every((r) => r.signatureOk)).toBe(true);
    expect(env.received.map((r) => r.body.verification?.type).slice(0, 5)).toEqual([
      'TAX_ID_STATUS',
      'DOCUMENT_QUALITY',
      'FACE_MATCH',
      'WATCHLIST',
      'LIVENESS',
    ]);
    expect(env.received[0]!.body).toMatchObject({
      check_id: id,
      reference_id: `cliente-${cpf(3)}`,
    });

    const done = (await request(sim.app).get(`/v1/checks/${id}`)).body;
    expect(done).toMatchObject({ status: 'COMPLETED', completed_at: '2026-03-02T13:00:02.000Z' });
    expect(byType(done.verifications)['DOCUMENT_QUALITY']).toMatchObject({
      status: 'PASSED',
      details: {
        documents: [
          { type: 'ID_FRONT', format: 'PNG', width: 1200, height: 900 },
          { type: 'SELFIE', format: 'PNG' },
        ],
      },
    });
  });
});

describe('regras pelo penúltimo dígito do CPF (Onboarding §5.2)', () => {
  async function verificationsFor(taxId: string) {
    const sim = await env.simulator();
    const id = (await request(sim.app).post('/v1/checks').send(submission(taxId))).body.check_id;
    await sim.complete();
    const completed = env.received.find((r) => r.headers['x-webhook-event'] === 'check.completed')!;
    expect(completed.body.check_id).toBe(id);
    return byType(completed.body.verifications) as Record<
      string,
      { status: string; score?: number; details: Record<string, unknown> }
    >;
  }

  it.each([0, 1, 2, 3, 4, 5, 6] as const)(
    'dígito %i: todas as verificações aprovadas',
    async (digit) => {
      const v = await verificationsFor(cpf(digit));
      expect(Object.values(v).map((x) => x.status)).toEqual([
        'PASSED',
        'PASSED',
        'PASSED',
        'PASSED',
        'PASSED',
      ]);
      expect(v['FACE_MATCH']!.score).toBeGreaterThanOrEqual(80);
    },
  );

  it('dígito 7: FACE_MATCH com score entre 50 e 79 (revisão manual, RN-ONB-020)', async () => {
    const v = await verificationsFor(cpf(7));
    expect(v['FACE_MATCH']!.status).toBe('ATTENTION');
    expect(v['FACE_MATCH']!.score).toBeGreaterThanOrEqual(50);
    expect(v['FACE_MATCH']!.score).toBeLessThanOrEqual(79);
    expect(v['TAX_ID_STATUS']!.status).toBe('PASSED');
  });

  it('dígito 8: ocorrência em WATCHLIST', async () => {
    const v = await verificationsFor(cpf(8));
    expect(v['WATCHLIST']).toMatchObject({ status: 'ATTENTION', details: { hit: true } });
    expect(v['FACE_MATCH']!.status).toBe('PASSED');
  });

  it('dígito 9: TAX_ID_STATUS irregular', async () => {
    const v = await verificationsFor(cpf(9));
    expect(v['TAX_ID_STATUS']).toMatchObject({
      status: 'FAILED',
      details: { situation: 'IRREGULAR' },
    });
  });
});

describe('documentos só por URL assinada, sem retenção (RN-KYCS-001)', () => {
  it('URL sem assinatura é recusada na submissão', async () => {
    const sim = await env.simulator();
    const res = await request(sim.app)
      .post('/v1/checks')
      .send(
        submission(cpf(1), [
          { type: 'ID_FRONT', url: 'http://storage.local/documents/c1/front.png' },
        ]),
      );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DOCUMENT_URL_NOT_SIGNED');
  });

  it('referência expirada: a leitura falha e nenhuma cópia local existe', async () => {
    const sim = await env.simulator();
    const shortLived = await env.upload('c2/front.png', png(1200, 900), 1);
    const id = (
      await request(sim.app)
        .post('/v1/checks')
        .send(submission(cpf(2), [{ type: 'ID_FRONT', url: shortLived }]))
    ).body.check_id;
    await new Promise((r) => setTimeout(r, 2_100)); // a validade da URL é no relógio real do storage
    await sim.complete();
    const v = byType((await request(sim.app).get(`/v1/checks/${id}`)).body.verifications);
    expect(v['DOCUMENT_QUALITY']).toMatchObject({
      status: 'FAILED',
      details: { document: 'ID_FRONT', reason: 'REFERENCE_UNAVAILABLE' },
    });

    // Nada do documento ficou: as referências saem junto com a conclusão e não há coluna binária.
    const row = (
      await sql<{
        document_refs: unknown;
      }>`SELECT document_refs FROM kyc_check WHERE id = ${id}`.execute(env.db)
    ).rows[0]!;
    expect(row.document_refs).toBeNull();
    const binary = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'bytea'`.execute(env.db);
    expect(binary.rows).toEqual([]);
  });

  it('resolução abaixo de 800×600 e formato não aceito reprovam DOCUMENT_QUALITY; PDF é aceito', async () => {
    const cases = [
      [await env.upload('c3/small.png', png(640, 480)), 'LOW_RESOLUTION'],
      [await env.upload('c3/doc.txt', Buffer.from('não é imagem')), 'UNSUPPORTED_FORMAT'],
      [await env.upload('c3/doc.pdf', Buffer.from('%PDF-1.7\n...')), null],
    ] as const;
    for (const [url, reason] of cases) {
      const sim = await env.simulator();
      const id = (
        await request(sim.app)
          .post('/v1/checks')
          .send(submission(cpf(4), [{ type: 'ID_FRONT', url }]))
      ).body.check_id;
      await sim.complete();
      const dq = byType((await request(sim.app).get(`/v1/checks/${id}`)).body.verifications)[
        'DOCUMENT_QUALITY'
      ];
      if (reason) expect(dq).toMatchObject({ status: 'FAILED', details: { reason } });
      else
        expect(dq).toMatchObject({ status: 'PASSED', details: { documents: [{ format: 'PDF' }] } });
    }
  });
});

describe('UI de inspeção (RN-SIM-005)', () => {
  it('forçar resultado pela UI vale para a próxima verificação, mesmo com dígito de aprovação', async () => {
    const sim = await env.simulator();
    await request(sim.app)
      .post('/ui/control/scenarios')
      .type('form')
      .send({ scenario: 'FORCE_WATCHLIST_HIT' });
    const forced = (
      await request(sim.app)
        .post('/v1/checks')
        .send(submission(cpf(0)))
    ).body.check_id;
    const normal = (
      await request(sim.app)
        .post('/v1/checks')
        .send(submission(cpf(0, 50)))
    ).body.check_id;
    await sim.complete();
    expect(
      byType((await request(sim.app).get(`/v1/checks/${forced}`)).body.verifications)['WATCHLIST']
        .status,
    ).toBe('ATTENTION');
    expect(
      byType((await request(sim.app).get(`/v1/checks/${normal}`)).body.verifications)['WATCHLIST']
        .status,
    ).toBe('PASSED');

    const ui = await request(sim.app).get('/ui');
    expect(ui.status).toBe(200);
    for (const text of [
      'Provedor de KYC simulado',
      forced,
      'WATCHLIST',
      'check.completed',
      'DELIVERED',
    ])
      expect(ui.text).toContain(text);
  });
});
