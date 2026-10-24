// Cenários forçáveis do PIX (RN-PIXS-003) e UI de inspeção (RN-SIM-005).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newCpf, startEnvironment, txid } from './helpers.js';

type Env = Awaited<ReturnType<typeof startEnvironment>>;
let env: Env;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(() => env?.stop());

const charge = { calendario: { expiracao: 600 }, valor: { original: '80.00' } };

async function payOne(app: Express.Application, n: number) {
  const client = (
    await request(app)
      .post('/contas')
      .send({ cpf: newCpf(n), nome: 'Ana Lima' })
  ).body;
  await request(app)
    .put(`/cob/${txid(n)}`)
    .send(charge);
  return (
    await request(app)
      .post(`/cob/${txid(n)}/pagar`)
      .send({ contaPagadora: client.id })
  ).body;
}

describe('cenários forçáveis (RN-PIXS-003)', () => {
  it('RN-PIXS-003: pagamento duplicado entrega o mesmo webhook (mesmo endToEndId) duas vezes', async () => {
    const { app, dispatcher } = await env.simulator();
    expect(
      (await request(app).post('/admin/scenarios').send({ scenario: 'DUPLICATE_PAYMENT_WEBHOOK' }))
        .status,
    ).toBe(201);
    const paid = await payOne(app, 1);
    expect(await dispatcher.runDue()).toBe(2);
    expect(env.received).toHaveLength(2);
    const [a, b] = env.received;
    expect(a!.body).toEqual(b!.body);
    expect(a!.body.pix[0].endToEndId).toBe(paid.endToEndId);
    expect([a!.headers['x-webhook-id'], b!.headers['x-webhook-id']]).toEqual([
      paid.endToEndId,
      paid.endToEndId,
    ]);
    expect(env.received.every((r) => r.signatureOk)).toBe(true);
    // Só o próximo pagamento: o cenário desarma sozinho.
    await payOne(app, 2);
    expect(await dispatcher.runDue()).toBe(1);
  });

  it('RN-PIXS-003: webhook atrasado só chega depois da expiração da cobrança', async () => {
    const { app, dispatcher, clock } = await env.simulator();
    await request(app).post('/admin/scenarios').send({ scenario: 'DELAYED_WEBHOOK' });
    await payOne(app, 3);
    expect(await dispatcher.runDue()).toBe(0);
    clock.advanceBy(600_000); // expira a cobrança
    expect((await request(app).get(`/cob/${txid(3)}`)).body.status).toBe('CONCLUIDA');
    expect(await dispatcher.runDue()).toBe(0);
    clock.advanceBy(60_000); // 1 min depois da expiração
    expect(await dispatcher.runDue()).toBe(1);
    expect(env.received[0]!.signatureOk).toBe(true);
  });

  it('RN-PIXS-003: chave inexistente no saque, mesmo para uma chave válida', async () => {
    const { app } = await env.simulator();
    const client = (
      await request(app)
        .post('/contas')
        .send({ cpf: newCpf(4), nome: 'Ana Lima' })
    ).body;
    await request(app).post('/admin/scenarios').send({ scenario: 'KEY_NOT_FOUND' });
    const res = await request(app)
      .post('/pix')
      .send({ idEnvio: 'k1', valor: '1.00', chave: client.titular.cpf });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CHAVE_INEXISTENTE');
    expect(
      (
        await request(app)
          .post('/pix')
          .send({ idEnvio: 'k2', valor: '1.00', chave: client.titular.cpf })
      ).status,
    ).toBe(201);
  });

  it('RN-PIXS-003: saldo insuficiente na conta da corretora', async () => {
    const { app } = await env.simulator();
    const client = (
      await request(app)
        .post('/contas')
        .send({ cpf: newCpf(5), nome: 'Ana Lima' })
    ).body;
    await request(app).post('/admin/scenarios').send({ scenario: 'INSUFFICIENT_BALANCE' });
    const res = await request(app)
      .post('/pix')
      .send({ idEnvio: 'b1', valor: '1.00', chave: client.titular.cpf });
    expect(res.body.code).toBe('SALDO_INSUFICIENTE');
    const broker = (await request(app).get('/contas')).body.contas.find(
      (c: { tipo: string }) => c.tipo === 'CORRETORA',
    );
    expect(broker.saldo).toBe('1000000.00');
  });

  it('RN-PIXS-003: indisponibilidade de 10 minutos', async () => {
    const { app, clock } = await env.simulator();
    await request(app).post('/admin/unavailability').send({ minutes: 10 });
    const down = await request(app)
      .put(`/cob/${txid(6)}`)
      .send(charge);
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('SIMULATED_UNAVAILABLE');
    clock.advanceBy(9 * 60_000 + 59_000);
    expect(
      (
        await request(app)
          .put(`/cob/${txid(6)}`)
          .send(charge)
      ).status,
    ).toBe(503);
    clock.advanceBy(1_000);
    expect(
      (
        await request(app)
          .put(`/cob/${txid(6)}`)
          .send(charge)
      ).status,
    ).toBe(201);
  });
});

describe('UI de inspeção (RN-SIM-005)', () => {
  it('forçar falha de saque pela UI: o próximo PIX enviado recebe falha definitiva', async () => {
    const { app } = await env.simulator();
    const client = (
      await request(app)
        .post('/contas')
        .send({ cpf: newCpf(7), nome: 'Ana Lima' })
    ).body;
    const form = await request(app)
      .post('/ui/control/scenarios')
      .type('form')
      .send({ scenario: 'SEND_REJECTED', action: 'arm' });
    expect(form.status).toBe(303);
    const res = await request(app)
      .post('/pix')
      .send({ idEnvio: 'u1', valor: '1.00', chave: client.titular.cpf });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PIX_REJEITADO');
  });

  it('lista contas, cobranças, PIX e webhooks, e paga a cobrança pelo formulário', async () => {
    const { app, dispatcher } = await env.simulator();
    const client = (
      await request(app)
        .post('/contas')
        .send({ cpf: newCpf(8), nome: 'Ana <b>Lima</b>' })
    ).body;
    await request(app)
      .put(`/cob/${txid(8)}`)
      .send(charge);
    const pay = await request(app)
      .post(`/ui/cob/${txid(8)}/pagar`)
      .type('form')
      .send({ contaPagadora: client.id });
    expect(pay.status).toBe(303);
    await dispatcher.runDue();

    const ui = await request(app).get('/ui');
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toMatch(/^text\/html/);
    for (const text of [
      'Banco Simulado (PIX)',
      'SIMULADO',
      txid(8),
      'CONCLUIDA',
      'pix.recebido',
      'DELIVERED',
      'Próximo envio: chave inexistente',
    ]) {
      expect(ui.text).toContain(text);
    }
    // Nome vindo da API é escapado.
    expect(ui.text).toContain('Ana &lt;b&gt;Lima&lt;/b&gt;');

    const again = await request(app)
      .post(`/ui/cob/${txid(8)}/pagar`)
      .type('form')
      .send({ contaPagadora: client.id });
    expect(again.headers['location']).toBe('/ui?erro=COBRANCA_JA_PAGA');
  });
});
