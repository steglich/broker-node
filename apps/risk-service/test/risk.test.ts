// Componente: projeção, holds, pré-trade e recuperação contra um PostgreSQL real.
import { uuidv7 } from '@broker/ids';
import { waitUntil } from '@broker/testing';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buyingPower } from '../src/domain/projection.js';
import {
  app,
  balance,
  bearer,
  buy,
  funded,
  journal,
  outbox,
  reset,
  sell,
  startEnv,
  stopEnv,
  trade,
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
afterEach(() => a.stop());

const power = (x: App, accountId: string) => buyingPower(x.memory.account(accountId)).toFixed(2);
const holdRow = async (id: string) =>
  (
    await sql<{ status: string; remaining_amount: { toFixed(n: number): string } }>`
      SELECT status, remaining_amount FROM hold WHERE id = ${id}`.execute(env.db)
  ).rows[0]!;
const INSTRUMENT = '019c0000-0000-7000-8000-000000000001';

describe('24.1 projeção (ADR-0003, RN-RSK-003)', () => {
  it('ADR-0003: o lançamento do negócio move o valor de U para P2 sem alterar o BP', async () => {
    const accountId = await funded(a, '10000.00');
    const tradeId = await trade(a, {
      accountId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '38.50',
      quantity: 100,
    });
    // Principal de 3.850,00 e custos estimados de 1,15 em U.
    expect(power(a, accountId)).toBe('6148.85');
    expect(a.memory.account(accountId).unbooked.toFixed(2)).toBe('-3851.15');

    const seq = await journal(a, { accountId, tradeId, amount: '-3850.00' });
    expect(power(a, accountId)).toBe('6148.85');
    const p = a.memory.account(accountId);
    expect(p.d2.toFixed(2)).toBe('6150.00');
    expect(p.unbooked.toFixed(2)).toBe('-1.15');

    // O saldo que vem depois do journal repete o mesmo valor: nada conta em dobro.
    await balance(a, accountId, { all: '10000.00', d2: '6150.00', seq });
    expect(power(a, accountId)).toBe('6148.85');
  });

  it('o lançamento que chega antes do negócio (outro tópico) também não conta em dobro', async () => {
    const accountId = await funded(a, '10000.00');
    const tradeId = uuidv7();
    await journal(a, { accountId, tradeId, amount: '-3850.00' });
    expect(power(a, accountId)).toBe('6150.00');
    await trade(a, {
      accountId,
      tradeId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '38.50',
      quantity: 100,
    });
    // Só os custos estimados entram: o principal já estava em P2.
    expect(power(a, accountId)).toBe('6148.85');
  });

  it('a nota lançada troca os custos estimados pelos efetivos', async () => {
    const accountId = await funded(a, '10000.00');
    const tradeId = await trade(a, {
      accountId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '38.50',
      quantity: 100,
    });
    await journal(a, { accountId, tradeId, amount: '-3850.00' });
    await journal(a, { accountId, tradeId: 'nota', amount: '-1.15', type: 'FEES' });
    const p = a.memory.account(accountId);
    expect(p.unbooked.toFixed(2)).toBe('0.00');
    expect(p.trades.size).toBe(0);
    expect(p.d2.toFixed(2)).toBe('6148.85');
  });

  it('RN-BP-003: venda do dia entra no BP na hora; comprada hoje pode ser vendida (RN-QD-003)', async () => {
    const accountId = await funded(a, '10000.00');
    await trade(a, {
      accountId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '10.00',
      quantity: 100,
    });
    const sale = await sell(a, {
      accountId,
      instrumentId: INSTRUMENT,
      quantity: 100,
      price: '11.00',
    });
    expect(sale).toMatchObject({ decision: 'APPROVED', classification: 'COVERED_SELL' });
    expect(a.memory.account(accountId).positions.get(INSTRUMENT)).toBe(100);
    await trade(a, {
      accountId,
      side: 'SELL',
      instrumentId: INSTRUMENT,
      price: '11.00',
      quantity: 100,
    });
    expect(a.memory.account(accountId).positions.has(INSTRUMENT)).toBe(false);
  });

  it('RN-SMM-022: a ponta do FMS não vira projeção', async () => {
    const accountId = await funded(a, '100.00');
    await trade(a, {
      accountId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '1.00',
      quantity: 1,
    });
    const { rows } = await sql<{ n: bigint }>`
      SELECT count(*) AS n FROM risk_trade`.execute(env.db);
    expect(rows[0]!.n).toBe(1n);
  });

  it('RN-BST-003: trade bust desfaz U e posição, sem devolver a ordem ao hold', async () => {
    const accountId = await funded(a, '10000.00');
    const tradeId = await trade(a, {
      accountId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '10.00',
      quantity: 100,
    });
    await a.store.transaction((tx) => a.projector.onTradeBusted(tx, { tradeId }));
    const p = a.memory.account(accountId);
    expect(p.unbooked.toFixed(2)).toBe('0.00');
    expect(p.positions.has(INSTRUMENT)).toBe(false);
    expect(power(a, accountId)).toBe('10000.00');
  });

  it('descarta saldo mais velho que a última sequência vista', async () => {
    const accountId = await funded(a, '100.00');
    await balance(a, accountId, { all: '500.00', seq: 5000 });
    await balance(a, accountId, { all: '1.00', seq: 4999 });
    expect(power(a, accountId)).toBe('500.00');
  });

  it('o preço de referência fica na memória e no banco, sem voltar para um seq menor', async () => {
    await a.store.transaction((tx) =>
      a.projector.onReferencePrice(tx, { instrumentId: INSTRUMENT, price: '38.5000', seq: 2 }),
    );
    await a.store.transaction((tx) =>
      a.projector.onReferencePrice(tx, { instrumentId: INSTRUMENT, price: '1.0000', seq: 1 }),
    );
    expect(a.memory.prices.get(INSTRUMENT)?.price.toFixed(2)).toBe('38.50');
  });
});

describe('24.1 recuperação (Cache e retenção §2, RNF-022)', () => {
  it('reinício: só volta a aprovar com a projeção reconstruída, igual à anterior', async () => {
    const accountId = await funded(a, '10000.00');
    const tradeId = await trade(a, {
      accountId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '10.00',
      quantity: 100,
    });
    await journal(a, { accountId, tradeId, amount: '-1000.00' });
    await trade(a, {
      accountId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '10.00',
      quantity: 50,
    });
    const open = await buy(a, { accountId, quantity: 10, price: '20.00' });
    const before = power(a, accountId);
    const positions = a.memory.account(accountId).positions.get(INSTRUMENT);
    const orderCount = a.memory.account(accountId).openOrders.size;
    await a.stop();

    const again = await app(env, { start: false });
    expect((await again.http.get('/health/ready')).status).toBe(503);
    const refused = await again.http
      .post('/v1/internal/risk/pre-trade')
      .set(bearer(again.tokens.oms))
      .send({
        requestId: uuidv7(),
        accountId,
        orderId: uuidv7(),
        instrumentId: INSTRUMENT,
        board: 'MAIN',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 1,
        referencePrice: '1.00',
        timeInForce: 'DAY',
        tradeIntent: 'NORMAL',
        operation: 'NEW',
      });
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('RISK_UNAVAILABLE');

    await again.start();
    await waitUntil(() => again.isReady());
    expect((await again.http.get('/health/ready')).status).toBe(200);
    expect(power(again, accountId)).toBe(before);
    const p = again.memory.account(accountId);
    expect(p.positions.get(INSTRUMENT)).toBe(positions);
    expect(p.openOrders.size).toBe(orderCount);
    expect(p.holds.has(open.holdId!)).toBe(true);
    expect(p.status).toBe('ACTIVE');
    a = again;
  });

  it('D14: líder antigo é cercado pela época e não grava hold depois da nova eleição', async () => {
    const accountId = await funded(a, '1000.00');
    await a.store.bumpEpoch();
    await expect(buy(a, { accountId, quantity: 1, price: '1.00' })).rejects.toThrow(
      'outra instância',
    );
    expect(a.decisions.isOpen()).toBe(false);
    expect(await outbox(env.db, 'risk.hold_created')).toHaveLength(0);
  });
});

describe('24.2 holds (RN-HLD-001..004/007)', () => {
  it('RN-HLD-004: compra a 10,00 que executa metade a 9,90 libera a proporção e o preço', async () => {
    const accountId = await funded(a, '10000.00');
    const orderId = uuidv7();
    const res = await buy(a, { accountId, orderId, quantity: 100, price: '10.00' });
    // 1.000,00 + (0,05 + 0,25) × 1,10 = 1.000,33.
    expect(res.decision).toBe('APPROVED');
    expect(power(a, accountId)).toBe('8999.67');

    await trade(a, {
      accountId,
      orderId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '9.90',
      quantity: 50,
    });
    const hold = await holdRow(res.holdId!);
    expect(hold.status).toBe('ACTIVE');
    expect(hold.remaining_amount.toFixed(2)).toBe('500.17');
    // U de 495,00 + 0,15 de custos (0,02 + 0,12 arredondados) mais o hold restante.
    const p = a.memory.account(accountId);
    expect(p.unbooked.toFixed(2)).toBe('-495.14');
    expect(power(a, accountId)).toBe('9004.69');
    expect((await outbox(env.db, 'risk.hold_adjusted'))[0]?.payload).toMatchObject({
      holdId: res.holdId,
      amount: '500.17',
      quantity: 50,
    });

    await trade(a, {
      accountId,
      orderId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '10.00',
      quantity: 50,
    });
    expect((await holdRow(res.holdId!)).status).toBe('CONSUMED');
    expect(await outbox(env.db, 'risk.hold_consumed')).toHaveLength(1);
    expect(a.memory.account(accountId).holds.size).toBe(0);
  });

  it('cancelamento libera a parte cancelada, comutativo com a última execução', async () => {
    const accountId = await funded(a, '10000.00');
    const orderId = uuidv7();
    const res = await buy(a, { accountId, orderId, quantity: 100, price: '10.00' });
    await a.store.transaction((tx) =>
      a.projector.onOrderClosed(tx, { orderId, accountId, canceledQuantity: 60 }, 'CANCELED'),
    );
    expect((await holdRow(res.holdId!)).remaining_amount.toFixed(2)).toBe('400.13');
    expect(a.memory.account(accountId).openOrders.has(orderId)).toBe(false);
    // A execução que estava a caminho chega depois do cancelamento: o hold fecha do mesmo jeito.
    await trade(a, {
      accountId,
      orderId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '10.00',
      quantity: 40,
    });
    expect((await holdRow(res.holdId!)).status).toBe('CONSUMED');
  });

  it('expiração libera o que restava; hold de venda volta para Q_disp', async () => {
    const accountId = await funded(a, '10000.00');
    await trade(a, {
      accountId,
      side: 'BUY',
      instrumentId: INSTRUMENT,
      price: '10.00',
      quantity: 100,
    });
    const orderId = uuidv7();
    const res = await sell(a, {
      accountId,
      orderId,
      instrumentId: INSTRUMENT,
      quantity: 100,
      price: '10.00',
    });
    expect(
      (await sell(a, { accountId, instrumentId: INSTRUMENT, quantity: 1, price: '10.00' }))
        .rejectCode,
    ).toBe('INSUFFICIENT_POSITION');
    await a.store.transaction((tx) =>
      a.projector.onOrderClosed(tx, { orderId, accountId, canceledQuantity: 100 }, 'EXPIRED'),
    );
    expect((await holdRow(res.holdId!)).status).toBe('RELEASED');
    expect(
      (await sell(a, { accountId, instrumentId: INSTRUMENT, quantity: 100, price: '10.00' }))
        .decision,
    ).toBe('APPROVED');
  });

  it('RN-FLX-001: order.rejected libera o hold de uma ordem que o OMS desistiu', async () => {
    const accountId = await funded(a, '10000.00');
    const orderId = uuidv7();
    const res = await buy(a, { accountId, orderId, quantity: 100, price: '10.00' });
    await a.store.transaction((tx) => a.projector.onOrderRejected(tx, { orderId, accountId }));
    expect((await holdRow(res.holdId!)).status).toBe('RELEASED');
    expect(power(a, accountId)).toBe('10000.00');
  });

  it('RN-HLD-007: reconciliação libera hold de ordem CANCELED e alerta, depois da carência', async () => {
    const accountId = await funded(a, '10000.00');
    const orderId = uuidv7();
    const res = await buy(a, { accountId, orderId, quantity: 100, price: '10.00' });
    await a.store.transaction((tx) =>
      a.projector.onOrderUpdated(tx, { orderId, accountId, status: 'CANCELED' }),
    );
    expect((await holdRow(res.holdId!)).status).toBe('ACTIVE');
    // Terminou agora: a execução ainda pode estar a caminho.
    expect(await a.decisions.reconcileOrphans()).toBe(0);

    a.clock.advanceBy(60_000);
    expect(await a.decisions.reconcileOrphans()).toBe(1);
    expect((await holdRow(res.holdId!)).status).toBe('RELEASED');
    expect(a.alerts).toMatchObject([
      { kind: 'ORPHAN_HOLD', referenceId: orderId, holdId: res.holdId },
    ]);
    expect(await outbox(env.db, 'risk.hold_released')).toHaveLength(1);
    expect(power(a, accountId)).toBe('10000.00');
    expect(await a.decisions.reconcileOrphans()).toBe(0);
  });

  it('RN-HLD-007: o laço de fundo reconcilia a cada 5 minutos', async () => {
    const accountId = await funded(a, '10000.00');
    const orderId = uuidv7();
    await buy(a, { accountId, orderId, quantity: 100, price: '10.00' });
    await a.store.transaction((tx) =>
      a.projector.onOrderUpdated(tx, { orderId, accountId, status: 'EXPIRED' }),
    );
    a.clock.advanceBy(4 * 60_000);
    await a.work();
    expect(a.alerts).toHaveLength(0);
    a.clock.advanceBy(60_000);
    await a.work();
    expect(a.alerts).toHaveLength(1);
  });

  it('RN-HLD-007: saque terminal com hold criado tarde também é órfão', async () => {
    const accountId = await funded(a, '1000.00');
    const id = uuidv7();
    await a.store.transaction((tx) =>
      a.projector.onWithdrawalClosed(tx, { withdrawalId: id, accountId }, 'FAILED'),
    );
    await a.decisions.createHold({ requestId: id, accountId, amount: '100.00', referenceId: id });
    a.clock.advanceBy(60_000);
    expect(await a.decisions.reconcileOrphans()).toBe(1);
    expect(power(a, accountId)).toBe('1000.00');
  });
});

describe('24.3 pré-trade (Risco §11)', () => {
  const order = (accountId: string, over: object = {}) => ({
    requestId: uuidv7(),
    accountId,
    orderId: uuidv7(),
    instrumentId: INSTRUMENT,
    board: 'MAIN',
    side: 'BUY',
    type: 'LIMIT',
    quantity: 100,
    referencePrice: '10.00',
    timeInForce: 'DAY',
    tradeIntent: 'NORMAL',
    operation: 'NEW',
    ...over,
  });

  it('aprovação: APPROVED com hold_id, hold gravado e risk.pretrade_approved na outbox', async () => {
    const accountId = await funded(a, '10000.00');
    const res = await a.http
      .post('/v1/internal/risk/pre-trade')
      .set(bearer(a.tokens.oms))
      .send(order(accountId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: 'APPROVED', classification: 'COVERED_BUY' });
    expect((await holdRow(res.body.holdId)).status).toBe('ACTIVE');
    expect(await outbox(env.db, 'risk.hold_created')).toHaveLength(1);
    expect((await outbox(env.db, 'risk.pretrade_approved'))[0]).toMatchObject({
      partition_key: accountId,
      payload: { holdId: res.body.holdId, classification: 'COVERED_BUY' },
    });
  });

  it('RN-PTC-002: recusa com os valores; risk.pretrade_rejected e nenhum hold', async () => {
    const accountId = await funded(a, '500.00');
    const res = await a.http
      .post('/v1/internal/risk/pre-trade')
      .set(bearer(a.tokens.oms))
      .send(order(accountId));
    expect(res.body).toMatchObject({
      decision: 'REJECTED',
      rejectCode: 'INSUFFICIENT_BUYING_POWER',
      figures: { required: '1000.33', available: '500.00' },
    });
    expect(await outbox(env.db, 'risk.hold_created')).toHaveLength(0);
    expect(await outbox(env.db, 'risk.pretrade_rejected')).toHaveLength(1);
  });

  it('RN-API: sem o escopo risk:pretrade, 403', async () => {
    const accountId = await funded(a, '500.00');
    const res = await a.http
      .post('/v1/internal/risk/pre-trade')
      .set(bearer(a.tokens.ledger))
      .send(order(accountId));
    expect(res.status).toBe(403);
  });

  it('Contratos §10.1: repetir o requestId devolve a mesma decisão e não reserva duas vezes', async () => {
    const accountId = await funded(a, '10000.00');
    const body = order(accountId);
    const send = () =>
      a.http.post('/v1/internal/risk/pre-trade').set(bearer(a.tokens.oms)).send(body);
    const [first, second] = await Promise.all([send(), send()]);
    expect(second.body).toEqual(first.body);
    expect(power(a, accountId)).toBe('8999.67');
    expect(await outbox(env.db, 'risk.hold_created')).toHaveLength(1);
    // A mesma ordem com outro pedido fica com a reserva que já tem.
    const again = await a.http
      .post('/v1/internal/risk/pre-trade')
      .set(bearer(a.tokens.oms))
      .send({ ...body, requestId: uuidv7() });
    expect(again.body.holdId).toBe(first.body.holdId);
    expect(power(a, accountId)).toBe('8999.67');
  });

  it('RN-ALT-004: alteração ajusta o hold pela diferença; recusada, a reserva antiga fica', async () => {
    const accountId = await funded(a, '2000.00');
    const orderId = uuidv7();
    const first = await buy(a, { accountId, orderId, quantity: 100, price: '10.00' });
    expect(power(a, accountId)).toBe('999.67');
    const bigger = await buy(a, {
      accountId,
      orderId,
      quantity: 150,
      price: '10.00',
      operation: 'REPLACE',
    });
    expect(bigger).toMatchObject({ decision: 'APPROVED', holdId: first.holdId });
    expect(power(a, accountId)).toBe('499.49');
    expect(await outbox(env.db, 'risk.hold_adjusted')).toHaveLength(1);

    const tooBig = await buy(a, {
      accountId,
      orderId,
      quantity: 500,
      price: '10.00',
      operation: 'REPLACE',
    });
    expect(tooBig.decision).toBe('REJECTED');
    expect(power(a, accountId)).toBe('499.49');
  });

  it('RN-DT-001: day trade sem alavancagem usa o BP_cash; acima dele, DAY_TRADE_LIMIT_EXCEEDED', async () => {
    const accountId = await funded(a, '500.00');
    const res = await buy(a, {
      accountId,
      quantity: 100,
      price: '10.00',
      tradeIntent: 'DAY_TRADE',
    });
    expect(res.rejectCode).toBe('DAY_TRADE_LIMIT_EXCEEDED');
  });

  it('Risco §10: a ordem 201 é recusada, e a ordem que terminou abre vaga', async () => {
    const accountId = await funded(a, '100000.00');
    const orders = Array.from({ length: 200 }, () => uuidv7());
    for (const orderId of orders) await buy(a, { accountId, orderId, quantity: 1, price: '1.00' });
    const over = await buy(a, { accountId, quantity: 1, price: '1.00' });
    expect(over).toMatchObject({
      decision: 'REJECTED',
      rejectCode: 'OPEN_ORDERS_LIMIT_EXCEEDED',
      figures: { required: '201', available: '200' },
    });
    await a.store.transaction((tx) =>
      a.projector.onOrderUpdated(tx, { orderId: orders[0]!, accountId, status: 'CANCELED' }),
    );
    expect((await buy(a, { accountId, quantity: 1, price: '1.00' })).decision).toBe('APPROVED');
  });

  it('conta bloqueada: ACCOUNT_NOT_ACTIVE', async () => {
    const accountId = await funded(a, '100000.00');
    await a.store.transaction((tx) => a.projector.onAccountStatus(tx, accountId, 'BLOCKED'));
    expect((await buy(a, { accountId, quantity: 1, price: '1.00' })).rejectCode).toBe(
      'ACCOUNT_NOT_ACTIVE',
    );
  });
});

describe('24.3 holds de saque (Contratos §10.2)', () => {
  const create = (x: App, accountId: string, amount: string, id = uuidv7()) =>
    x.http
      .post('/v1/internal/risk/holds')
      .set(bearer(x.tokens.ledger))
      .send({
        requestId: id,
        holdType: 'WITHDRAWAL',
        accountId,
        amount,
        reference: { type: 'WITHDRAWAL', id },
      });
  const release = (x: App, id: string, outcome: string) =>
    x.http
      .post(`/v1/internal/risk/holds/${id}/release`)
      .set(bearer(x.tokens.ledger))
      .send({ outcome });

  it('RN-LED-032: CANCELED devolve o valor ao BP; CONSUMED fecha; repetir não muda', async () => {
    const accountId = await funded(a, '1000.00');
    const id = uuidv7();
    const created = await create(a, accountId, '400.00', id);
    expect(created.body).toEqual({ decision: 'APPROVED', holdId: id });
    expect(power(a, accountId)).toBe('600.00');
    // Reenvio com a resposta perdida: a mesma reserva.
    expect((await create(a, accountId, '400.00', id)).body.decision).toBe('APPROVED');
    expect(power(a, accountId)).toBe('600.00');

    expect((await release(a, id, 'CANCELED')).body).toEqual({ holdId: id, status: 'RELEASED' });
    expect(power(a, accountId)).toBe('1000.00');
    expect((await release(a, id, 'CONSUMED')).body.status).toBe('RELEASED');
    expect(await outbox(env.db, 'risk.hold_released')).toHaveLength(1);

    const second = uuidv7();
    await create(a, accountId, '100.00', second);
    expect((await release(a, second, 'CONSUMED')).body.status).toBe('CONSUMED');
    expect(await outbox(env.db, 'risk.hold_consumed')).toHaveLength(1);
  });

  it('hold desconhecido não é erro: o ledger libera o que talvez não tenha sido criado', async () => {
    const id = uuidv7();
    const res = await release(a, id, 'CANCELED');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ holdId: id, status: 'UNKNOWN' });
  });

  it('saldo insuficiente: REJECTED com os valores', async () => {
    const accountId = await funded(a, '1000.00');
    expect((await create(a, accountId, '1000.01')).body).toMatchObject({
      decision: 'REJECTED',
      rejectCode: 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
      figures: { required: '1000.01', available: '1000.00' },
    });
  });

  it('sem o escopo risk:holds, 403', async () => {
    const accountId = await funded(a, '1000.00');
    const id = uuidv7();
    const res = await a.http
      .post('/v1/internal/risk/holds')
      .set(bearer(a.tokens.oms))
      .send({
        requestId: id,
        holdType: 'WITHDRAWAL',
        accountId,
        amount: '1.00',
        reference: { type: 'WITHDRAWAL', id },
      });
    expect(res.status).toBe(403);
  });

  it('RSK-030: compra e saque simultâneos de R$ 8.000 sobre R$ 10.000: só um passa', async () => {
    for (let round = 0; round < 10; round++) {
      const accountId = await funded(a, '10000.00');
      const [purchase, withdrawal] = await Promise.all([
        // 800 a 10,00 = 8.000,00 e mais os custos.
        buy(a, { accountId, quantity: 800, price: '10.00' }),
        a.decisions.createHold({
          requestId: uuidv7(),
          accountId,
          amount: '8000.00',
          referenceId: uuidv7(),
        }),
      ]);
      const approved = [purchase.decision, withdrawal.decision].filter((d) => d === 'APPROVED');
      expect(approved).toHaveLength(1);
      const refused =
        purchase.decision === 'REJECTED'
          ? purchase.rejectCode
          : (withdrawal as { rejectCode: string }).rejectCode;
      expect(['INSUFFICIENT_BUYING_POWER', 'INSUFFICIENT_WITHDRAWABLE_BALANCE']).toContain(refused);
      expect(buyingPower(a.memory.account(accountId)).greaterThanOrEqualTo(0)).toBe(true);
    }
  });

  it('RSK-030 com eventos no meio: negócio, depósito e pré-trade sobre a mesma conta não se perdem', async () => {
    const accountId = await funded(a, '10000.00');
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      work.push(
        trade(a, { accountId, side: 'SELL', instrumentId: INSTRUMENT, price: '1.00', quantity: 1 }),
      );
      work.push(buy(a, { accountId, quantity: 1, price: '1.00' }));
    }
    await Promise.all(work);
    const p = a.memory.account(accountId);
    expect(p.trades.size).toBe(20);
    expect(p.holds.size).toBe(20);
    const loaded = await a.store.loadAll();
    const stored = loaded.accounts.find((x) => x.accountId === accountId)!;
    expect(stored.trades.size).toBe(20);
    expect(stored.holds.size).toBe(20);
    expect(stored.unbooked.toFixed(2)).toBe(p.unbooked.toFixed(2));
  });
});

describe('risk.buying_power_changed (Risco §12)', () => {
  it('avisa no laço, com throttle, e só quando o valor mudou', async () => {
    const accountId = await funded(a, '1000.00');
    await a.work();
    expect((await outbox(env.db, 'risk.buying_power_changed'))[0]).toMatchObject({
      partition_key: accountId,
      payload: { accountId, cash: '1000.00', asOf: a.clock.now().toString() },
    });
    await balance(a, accountId, { all: '1000.00' });
    await a.work();
    expect(await outbox(env.db, 'risk.buying_power_changed')).toHaveLength(1);
    await buy(a, { accountId, quantity: 1, price: '1.00' });
    await buy(a, { accountId, quantity: 1, price: '1.00' });
    await a.work();
    const events = await outbox(env.db, 'risk.buying_power_changed');
    expect(events).toHaveLength(2);
    expect(events[1]!.payload['cash']).toBe('998.00');
  });
});
