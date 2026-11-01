import { uuidv7 } from '@broker/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  bearer,
  clearOutbox,
  commands,
  engineAcks,
  inst,
  instrument,
  outbox,
  reset,
  startEnv,
  stopEnv,
  type App,
  type Env,
} from './helpers.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
}, 180_000);
afterAll(() => stopEnv(env));
beforeEach(async () => {
  await reset(env.db);
  a = await app(env);
});

const kill = (body: object, token = a.tokens.market) =>
  a.http.post('/v1/bo/smm/kill-switch').set(bearer(token)).send(body);
const approve = (id: string, token = a.tokens.admin) =>
  a.http.post(`/v1/bo/smm/change-requests/${id}/approve`).set(bearer(token)).send();

describe('kill switch (RN-SMM-030)', () => {
  it('global: desliga sem aprovação, cancela tudo e publica smm.status_changed', async () => {
    const one = await instrument(a, { phase: 'CONTINUOUS' });
    const two = await instrument(a);
    await engineAcks(a, one);
    await engineAcks(a, two);
    const total = (await inst(a, one)).liveOrders.length + (await inst(a, two)).liveOrders.length;
    await clearOutbox(env.db);

    const res = await kill({ enabled: false, justification: 'Calibração errada' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scope: 'GLOBAL', status: 'OFF' });
    const { cancels, newOrders } = await commands(env.db);
    expect(cancels).toHaveLength(total);
    expect(newOrders).toEqual([]);
    const [status] = await outbox(env.db, 'smm.status_changed');
    expect(status!.payload).toMatchObject({
      scope: 'GLOBAL',
      status: 'OFF',
      reason: 'Calibração errada',
      actorId: 'op-market',
      approvalRequestId: null,
    });

    // Desligado, a referência andar não faz cotar, e repetir o comando não publica de novo.
    await engineAcks(a, one);
    await clearOutbox(env.db);
    a.clock.advanceBy(120_000);
    await a.maker.tick();
    expect((await commands(env.db)).newOrders).toEqual([]);
    await kill({ enabled: false, justification: 'De novo' }).expect(200);
    expect(await outbox(env.db, 'smm.status_changed')).toEqual([]);
  });

  it('por instrumento: só as ofertas dele; o outro segue cotando', async () => {
    const one = await instrument(a, { phase: 'CONTINUOUS' });
    const two = await instrument(a);
    await engineAcks(a, one);
    await engineAcks(a, two);
    const expected = (await inst(a, one)).liveOrders.map((o) => o.orderId).sort();
    await clearOutbox(env.db);

    await kill({ enabled: false, instrumentId: one, justification: 'Só PETR4' }).expect(200);
    const { cancels } = await commands(env.db);
    expect(cancels.map((c) => c.orderId).sort()).toEqual(expected);
    expect((await inst(a, two)).enabled).toBe(true);
    const [status] = await outbox(env.db, 'smm.status_changed');
    expect(status!.partition_key).toBe(one);
  });

  it('religar exige aprovação de outra pessoa, com BO_ADMIN, e volta a cotar', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await kill({ enabled: false, justification: 'Parar' }).expect(200);
    await engineAcks(a, id);
    await clearOutbox(env.db);

    const proposal = await kill({ enabled: true, justification: 'Calibrado' });
    expect(proposal.status).toBe(202);
    expect(proposal.body).toMatchObject({ type: 'SMM_ENABLE', status: 'PENDING' });
    expect((await commands(env.db)).newOrders).toEqual([]);

    await approve(proposal.body.id, a.tokens.market).expect(403);
    await approve(proposal.body.id, a.tokens.market2).expect(403);

    const approved = await approve(proposal.body.id);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect((await commands(env.db)).newOrders.length).toBeGreaterThan(0);
    const [status] = await outbox(env.db, 'smm.status_changed');
    expect(status!.payload).toMatchObject({
      scope: 'GLOBAL',
      status: 'ON',
      approvalRequestId: proposal.body.id,
    });
  });

  it('não propõe religar quem já está ligado; aprovação vira STALE se o estado mudou', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    const already = await kill({ enabled: true, justification: 'Religar' });
    expect(already.status).toBe(422);
    expect(already.body.code).toBe('SMM_ALREADY_ON');

    await kill({ enabled: false, instrumentId: id, justification: 'Parar' }).expect(200);
    const first = await kill({ enabled: true, instrumentId: id, justification: 'Volta' }).expect(
      202,
    );
    const second = await kill({ enabled: true, instrumentId: id, justification: 'Volta' }).expect(
      202,
    );
    await approve(first.body.id).expect(200);
    const stale = await approve(second.body.id).expect(200);
    expect(stale.body.status).toBe('STALE');
  });

  it('só o backoffice de mercado aciona; cliente recebe 403', async () => {
    await kill({ enabled: false, justification: 'x' }, a.tokens.customer).expect(403);
    await kill({ enabled: false, justification: '   ' }).expect(422);
    await kill({ enabled: false, instrumentId: uuidv7(), justification: 'x' }).expect(404);
  });
});

describe('estado e parâmetros (Catálogo §10, Backoffice §3)', () => {
  it('painel: inventário, P&L, spread efetivo, ofertas e parâmetros atuais', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    const res = await a.http.get(`/v1/bo/smm/${id}`).set(bearer(a.tokens.market)).expect(200);
    expect(res.body).toMatchObject({
      instrumentId: id,
      symbol: 'PETR4',
      accountId: a.accountId,
      enabled: true,
      globalEnabled: true,
      initialStock: 200_000,
      parameters: { levels: 5 },
      metrics: { inventory: 0, realizedPnl: '0', bestBid: '38.48', bestAsk: '38.52' },
    });
    expect(res.body.liveOrders).toHaveLength(12);
    await a.http.get(`/v1/bo/smm/${uuidv7()}`).set(bearer(a.tokens.market)).expect(404);
  });

  it('parâmetros passam por aprovação, com vigência, e entram na recotação', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await clearOutbox(env.db);
    const proposal = await a.http
      .put(`/v1/bo/smm/${id}`)
      .set(bearer(a.tokens.market))
      .send({ params: { levels: 2 }, justification: 'Menos níveis' })
      .expect(202);
    expect((await commands(env.db)).order).toEqual([]);

    await approve(proposal.body.id).expect(200);
    const { cancels } = await commands(env.db);
    expect(cancels).toHaveLength(6);
    const state = await a.http.get(`/v1/bo/smm/${id}`).set(bearer(a.tokens.market)).expect(200);
    expect(state.body.parameters.levels).toBe(2);
  });

  it('o spread não se muda aqui: é do reference-data', async () => {
    const id = await instrument(a);
    await a.http
      .put(`/v1/bo/smm/${id}`)
      .set(bearer(a.tokens.market))
      .send({ params: { spreadBps: 1 }, justification: 'x' })
      .expect(400);
  });

  it('rejeitar, cancelar, listar e expirar seguem o maker-checker', async () => {
    const id = await instrument(a);
    await kill({ enabled: false, instrumentId: id, justification: 'Parar' }).expect(200);
    const one = await kill({ enabled: true, instrumentId: id, justification: 'A' }).expect(202);
    const two = await kill({ enabled: true, instrumentId: id, justification: 'B' }).expect(202);
    const three = await kill({ enabled: true, instrumentId: id, justification: 'C' }).expect(202);

    const rejected = await a.http
      .post(`/v1/bo/smm/change-requests/${one.body.id}/reject`)
      .set(bearer(a.tokens.admin))
      .send({ reason: 'Ainda não' })
      .expect(200);
    expect(rejected.body.status).toBe('REJECTED');

    await a.http
      .post(`/v1/bo/smm/change-requests/${two.body.id}/cancel`)
      .set(bearer(a.tokens.market2))
      .expect(403);
    const canceled = await a.http
      .post(`/v1/bo/smm/change-requests/${two.body.id}/cancel`)
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(canceled.body.status).toBe('CANCELED');

    const list = await a.http
      .get('/v1/bo/smm/change-requests?status=PENDING')
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([three.body.id]);

    a.clock.advanceBy(25 * 3_600_000);
    expect(await a.backoffice.expireDue()).toBe(1);
    const late = await approve(three.body.id);
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('REQUEST_NOT_PENDING');
  });
});
