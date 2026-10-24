// Testes de componente do Banco Simulado (Sistemas simulados §2): simulador inteiro em processo,
// Postgres real, relógio virtual e um receptor de webhook no papel da corretora.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newCpf, startEnvironment, txid } from './helpers.js';

type Env = Awaited<ReturnType<typeof startEnvironment>>;
let env: Env;
beforeAll(async () => {
  env = await startEnvironment();
});
afterAll(() => env?.stop());

const charge = { calendario: { expiracao: 3600 }, valor: { original: '150.00' } };

async function openClient(app: Express.Application, seed: number, extra: object = {}) {
  const res = await request(app)
    .post('/contas')
    .send({ cpf: newCpf(seed), nome: 'Maria da Silva Souza', ...extra });
  return res.body as {
    id: string;
    titular: { cpf: string };
    saldo: string;
    chaves: { chave: string; tipo: string }[];
  };
}

describe('contas (§2.1)', () => {
  it('cliente aprovado ganha conta com o CPF, o saldo inicial do ambiente e as chaves CPF e aleatória', async () => {
    const { app } = await env.simulator({ environment: 'prod' });
    const cpf = newCpf(1);
    const res = await request(app).post('/contas').send({ cpf, nome: 'Maria da Silva Souza' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tipo: 'CLIENTE',
      titular: { cpf, nome: 'Maria da Silva Souza' },
      saldo: '10000.00',
      agencia: '0001',
    });
    expect(res.body.chaves.map((k: { tipo: string }) => k.tipo).sort()).toEqual(['CPF', 'EVP']);
    // Repetir a abertura devolve a mesma conta (o núcleo pode reenviar).
    const again = await request(app).post('/contas').send({ cpf, nome: 'Maria da Silva Souza' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(res.body.id);
  });

  it('no sandbox o saldo inicial padrão é R$ 100.000,00; a chamada pode escolher outro', async () => {
    const { app } = await env.simulator({ environment: 'sandbox' });
    expect((await openClient(app, 2)).saldo).toBe('100000.00');
    expect((await openClient(app, 3, { saldoInicial: '50.00' })).saldo).toBe('50.00');
  });

  it('a conta da corretora e as de terceiros já existem', async () => {
    const { app } = await env.simulator();
    const { contas } = (await request(app).get('/contas')).body;
    expect(contas.map((c: { tipo: string }) => c.tipo)).toEqual([
      'CORRETORA',
      'TERCEIRO',
      'TERCEIRO',
    ]);
    expect(contas[0]).toMatchObject({
      titular: { cnpj: '11222333000181', nome: 'Corretora Estudo' },
      saldo: '1000000.00',
    });
  });
});

describe('consulta de chave (§2.2)', () => {
  it('devolve o CPF do titular e o nome mascarado', async () => {
    const { app } = await env.simulator();
    const client = await openClient(app, 4);
    const evp = client.chaves.find((k) => k.tipo === 'EVP')!.chave;
    const res = await request(app).get(`/chaves/${evp}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chave: evp,
      tipo: 'EVP',
      titular: { cpf: client.titular.cpf, nomeMascarado: 'Maria S*** S***' },
    });
  });

  it('chave inexistente → 404 CHAVE_INEXISTENTE', async () => {
    const { app } = await env.simulator();
    const res = await request(app).get('/chaves/nao-existe@exemplo.com');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CHAVE_INEXISTENTE');
  });
});

describe('cobrança e pagamento (§2.2)', () => {
  it('cria a cobrança com payload copia-e-cola marcado como simulado; repetir é idempotente', async () => {
    const { app } = await env.simulator();
    const res = await request(app)
      .put(`/cob/${txid(1)}`)
      .send(charge);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      txid: txid(1),
      status: 'ATIVA',
      valor: { original: '150.00' },
      chave: '11222333000181',
      pix: [],
    });
    expect(res.body.pixCopiaECola).toMatch(/^000201/);
    expect(res.body.pixCopiaECola).toContain('br.sim.pix');
    expect(res.body.pixCopiaECola).toContain(`${txid(1)}6304`);
    expect(
      (
        await request(app)
          .put(`/cob/${txid(1)}`)
          .send(charge)
      ).status,
    ).toBe(200);
    const other = await request(app)
      .put(`/cob/${txid(1)}`)
      .send({ ...charge, valor: { original: '1.00' } });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('TXID_EM_USO');
  });

  it('pagamento por terceiro: o webhook assinado informa o CPF do pagador real', async () => {
    const { app, dispatcher } = await env.simulator();
    const debtor = await openClient(app, 5);
    const thirdParty = (await request(app).get('/contas')).body.contas.find(
      (c: { tipo: string }) => c.tipo === 'TERCEIRO',
    );
    await request(app)
      .put(`/cob/${txid(2)}`)
      .send({ ...charge, devedor: { cpf: debtor.titular.cpf, nome: 'Maria' } });

    const paid = await request(app)
      .post(`/cob/${txid(2)}/pagar`)
      .send({ contaPagadora: thirdParty.id });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({
      tipo: 'COBRANCA',
      status: 'CONCLUIDO',
      txid: txid(2),
      valor: '150.00',
      pagador: { cpf: thirdParty.titular.cpf },
    });
    // RN-PIXS-001: 32 caracteres com o prefixo de simulação.
    expect(paid.body.endToEndId).toMatch(/^ESIM\d{14}[a-z0-9]{14}$/);

    expect(await dispatcher.runDue()).toBe(1);
    expect(env.received).toHaveLength(1);
    const [hook] = env.received;
    expect(hook!.signatureOk).toBe(true);
    expect(hook!.headers['x-webhook-event']).toBe('pix.recebido');
    expect(hook!.body).toEqual({
      pix: [
        {
          endToEndId: paid.body.endToEndId,
          txid: txid(2),
          valor: '150.00',
          horario: '2026-03-02T13:00:00.000Z',
          pagador: thirdParty.titular,
        },
      ],
    });

    const accounts = (await request(app).get('/contas')).body.contas;
    expect(accounts.find((c: { id: string }) => c.id === thirdParty.id).saldo).toBe('9850.00');
    expect(accounts.find((c: { tipo: string }) => c.tipo === 'CORRETORA').saldo).toBe('1000150.00');
    expect((await request(app).get(`/cob/${txid(2)}`)).body).toMatchObject({
      status: 'CONCLUIDA',
      pix: [{ endToEndId: paid.body.endToEndId }],
    });
  });

  it('cobrança paga, expirada ou sem saldo é recusada', async () => {
    const { app, clock } = await env.simulator();
    const client = await openClient(app, 6, { saldoInicial: '200.00' });
    await request(app)
      .put(`/cob/${txid(3)}`)
      .send(charge);
    await request(app)
      .post(`/cob/${txid(3)}/pagar`)
      .send({ contaPagadora: client.id });
    const twice = await request(app)
      .post(`/cob/${txid(3)}/pagar`)
      .send({ contaPagadora: client.id });
    expect(twice.body.code).toBe('COBRANCA_JA_PAGA');

    await request(app)
      .put(`/cob/${txid(4)}`)
      .send(charge);
    const poor = await request(app)
      .post(`/cob/${txid(4)}/pagar`)
      .send({ contaPagadora: client.id });
    expect(poor.status).toBe(422);
    expect(poor.body.code).toBe('SALDO_INSUFICIENTE');

    clock.advanceBy(3600 * 1000);
    expect((await request(app).get(`/cob/${txid(4)}`)).body.status).toBe('REMOVIDA_POR_EXPIRACAO');
    expect(
      (
        await request(app)
          .post(`/cob/${txid(4)}/pagar`)
          .send({ contaPagadora: client.id })
      ).body.code,
    ).toBe('COBRANCA_EXPIRADA');
  });
});

describe('envio de PIX (saque, §2.2)', () => {
  it('debita a corretora, credita o titular da chave e repetir o idEnvio devolve o mesmo PIX', async () => {
    const { app } = await env.simulator();
    const client = await openClient(app, 7);
    const body = {
      idEnvio: 'saque1',
      valor: '300.00',
      chave: client.titular.cpf,
      cpfRecebedor: client.titular.cpf,
    };
    const sent = await request(app).post('/pix').send(body);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      tipo: 'ENVIO',
      status: 'CONCLUIDO',
      idEnvio: 'saque1',
      recebedor: { cpf: client.titular.cpf },
    });
    const again = await request(app).post('/pix').send(body);
    expect(again.status).toBe(200);
    expect(again.body.endToEndId).toBe(sent.body.endToEndId);
    expect((await request(app).get(`/contas/${client.id}`)).body.saldo).toBe('10300.00');
  });

  it('chave inexistente, titularidade divergente e saldo da corretora insuficiente são recusados e registrados', async () => {
    const { app } = await env.simulator();
    const client = await openClient(app, 8);
    const missing = await request(app)
      .post('/pix')
      .send({ idEnvio: 's2', valor: '1.00', chave: 'nao-existe' });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('CHAVE_INEXISTENTE');
    const otherOwner = await request(app)
      .post('/pix')
      .send({ idEnvio: 's3', valor: '1.00', chave: client.titular.cpf, cpfRecebedor: newCpf(99) });
    expect(otherOwner.body.code).toBe('TITULARIDADE_DIVERGENTE');
    const tooMuch = await request(app)
      .post('/pix')
      .send({ idEnvio: 's4', valor: '2000000.00', chave: client.titular.cpf });
    expect(tooMuch.body.code).toBe('SALDO_INSUFICIENTE');
    // A recusa também é idempotente e fica registrada para a reconciliação.
    expect(
      (await request(app).post('/pix').send({ idEnvio: 's2', valor: '1.00', chave: 'nao-existe' }))
        .body.code,
    ).toBe('CHAVE_INEXISTENTE');
    const failed = (await request(app).get(`/pix/${missing.body.context.endToEndId}`)).body;
    expect(failed).toMatchObject({ status: 'NAO_REALIZADO', motivo: 'CHAVE_INEXISTENTE' });
  });
});

describe('devolução (§2.2)', () => {
  it('devolve integralmente um PIX recebido; parcial é recusada; repetir com o mesmo id é idempotente', async () => {
    const { app } = await env.simulator();
    const client = await openClient(app, 9);
    await request(app)
      .put(`/cob/${txid(5)}`)
      .send(charge);
    const paid = (
      await request(app)
        .post(`/cob/${txid(5)}/pagar`)
        .send({ contaPagadora: client.id })
    ).body;

    const partial = await request(app)
      .put(`/pix/${paid.endToEndId}/devolucao/d1`)
      .send({ valor: '10.00' });
    expect(partial.body.code).toBe('VALOR_DEVOLUCAO_INVALIDO');
    const refund = await request(app)
      .put(`/pix/${paid.endToEndId}/devolucao/d1`)
      .send({ valor: '150.00' });
    expect(refund.status).toBe(201);
    expect(refund.body).toMatchObject({ id: 'd1', valor: '150.00', status: 'DEVOLVIDO' });
    expect(
      (await request(app).put(`/pix/${paid.endToEndId}/devolucao/d1`).send({ valor: '150.00' }))
        .status,
    ).toBe(200);
    expect(
      (await request(app).put(`/pix/${paid.endToEndId}/devolucao/d2`).send({ valor: '150.00' }))
        .body.code,
    ).toBe('PIX_JA_DEVOLVIDO');

    expect((await request(app).get(`/contas/${client.id}`)).body.saldo).toBe('10000.00');
    expect((await request(app).get(`/pix/${paid.endToEndId}`)).body.devolucoes).toEqual([
      refund.body,
    ]);
  });

  it('um envio da corretora não é devolvível', async () => {
    const { app } = await env.simulator();
    const client = await openClient(app, 10);
    const sent = (
      await request(app)
        .post('/pix')
        .send({ idEnvio: 's5', valor: '1.00', chave: client.titular.cpf })
    ).body;
    expect(
      (await request(app).put(`/pix/${sent.endToEndId}/devolucao/d1`).send({ valor: '1.00' })).body
        .code,
    ).toBe('PIX_NAO_DEVOLVIVEL');
  });
});

describe('consulta de transação (§2.2, RN-PIXS-002)', () => {
  it('por endToEndId, por txid e por período', async () => {
    const { app, clock } = await env.simulator();
    const client = await openClient(app, 11);
    await request(app)
      .put(`/cob/${txid(6)}`)
      .send(charge);
    const paid = (
      await request(app)
        .post(`/cob/${txid(6)}/pagar`)
        .send({ contaPagadora: client.id })
    ).body;
    clock.advanceBy(86_400_000);
    await request(app)
      .post('/pix')
      .send({ idEnvio: 's6', valor: '5.00', chave: client.titular.cpf });

    expect((await request(app).get(`/pix/${paid.endToEndId}`)).body.txid).toBe(txid(6));
    expect(
      (
        await request(app)
          .get('/pix')
          .query({ txid: txid(6) })
      ).body.pix.map((p: { endToEndId: string }) => p.endToEndId),
    ).toEqual([paid.endToEndId]);
    const day1 = (
      await request(app)
        .get('/pix')
        .query({ inicio: '2026-03-02T00:00:00Z', fim: '2026-03-03T00:00:00Z' })
    ).body.pix;
    expect(day1).toHaveLength(1);
    expect((await request(app).get('/pix/ESIM00000000000000000000000000zz')).status).toBe(404);
  });
});

describe('comportamento configurável (RN-SIM-002)', () => {
  it('erro transitório atinge a API, mas não a UI de inspeção', async () => {
    const { app, control } = await env.simulator();
    control.behavior = { ...control.behavior, transientErrorRate: 1 };
    expect((await request(app).get('/contas')).status).toBe(503);
    expect((await request(app).get('/ui')).status).toBe(200);
  });
});
