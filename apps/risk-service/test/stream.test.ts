// De ponta a ponta no barramento: os eventos dos outros serviços alimentam a projeção, e `readiness`
// só volta depois de alcançar o que já estava nos tópicos.
import { uuidv7 } from '@broker/ids';
import {
  connectStream,
  ensureSuperStream,
  PartitionedProducer,
  topicName,
} from '@broker/messaging';
import { testClock, waitUntil } from '@broker/testing';
import { startRabbitMq, type StartedRabbitMq } from '@broker/testing/containers';
import { Offset } from 'rabbitmq-stream-js-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyingPower } from '../src/domain/projection.js';
import { app, buy, DAY, startEnv, stopEnv, type Env } from './helpers.js';

let env: Env;
let rabbit: StartedRabbitMq;
beforeAll(async () => {
  [env, rabbit] = await Promise.all([startEnv(), startRabbitMq()]);
}, 180_000);
afterAll(async () => {
  await stopEnv(env);
  await rabbit?.container.stop();
});

describe('barramento do risk-service', () => {
  it('projeta os eventos, publica os holds e reconstrói só depois de alcançar os tópicos', async () => {
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-producers');
    for (const ctx of ['ledger', 'engine', 'oms', 'customer', 'market-data', 'risk'])
      await ensureSuperStream(client, topicName('test', ctx), { partitions: 2 });
    await ensureSuperStream(client, topicName('test', 'scheduler'), { partitions: 1 });

    const clock = testClock({ date: DAY, time: '10:00' });
    const send = async (ctx: string, eventType: string, partitionKey: string, payload: object) => {
      const producer = await PartitionedProducer.create(
        client,
        topicName('test', ctx),
        `test.${uuidv7()}`,
      );
      const e = {
        eventId: uuidv7(),
        eventType,
        eventVersion: 1,
        source: 'test',
        environment: 'test',
        occurredAt: clock.now().toString(),
        partitionKey,
        correlationId: uuidv7(),
        actor: { type: 'SYSTEM', id: 'test' },
        auditable: false,
        payload,
      };
      await producer.sendAll([
        {
          partitionKey,
          publishingId: 1n,
          messageId: e.eventId,
          body: Buffer.from(JSON.stringify(e)),
          applicationProperties: { eventType, eventVersion: 1 },
        },
      ]);
    };

    const accountId = uuidv7();
    const instrumentId = uuidv7();
    const fms = uuidv7();

    // Tudo já estava nos tópicos antes de o serviço subir: é a reconstrução de um Risco novo.
    await send('customer', 'account.opened', accountId, {
      accountId,
      customerId: uuidv7(),
      accountNumber: '12345-6',
      openedAt: clock.now().toString(),
    });
    await send('ledger', 'ledger.balance_changed', accountId, {
      accountId,
      settled: '10000.00',
      projected: { d0: '10000.00', d1: '10000.00', d2: '10000.00' },
      projectedTotal: '10000.00',
      withdrawable: '10000.00',
      lastSequence: 1,
      asOf: clock.now().toString(),
    });

    const a = await app(env, { stream, clock, start: false });
    expect((await a.http.get('/health/ready')).status).toBe(503);
    await a.start();
    await waitUntil(() => a.isReady(), { timeoutMs: 60_000 });
    const power = () => buyingPower(a.memory.account(accountId)).toFixed(2);
    expect((await a.http.get('/health/ready')).status).toBe(200);
    expect(power()).toBe('10000.00');
    expect(a.memory.account(accountId).status).toBe('ACTIVE');

    const orderId = uuidv7();
    const decision = await buy(a, {
      accountId,
      orderId,
      instrumentId,
      quantity: 100,
      price: '10.00',
    });
    expect(decision.decision).toBe('APPROVED');
    expect(power()).toBe('8999.67');

    // Negócio do Motor com a ponta do FMS: reduz o hold e entra em U.
    const tradeId = uuidv7();
    await send('engine', 'engine.trade_executed', instrumentId, {
      instrumentId,
      board: 'MAIN',
      engineSeq: 1,
      inputSeq: 1,
      tradeId,
      price: '10.00',
      quantity: 100,
      buyOrderId: orderId,
      sellOrderId: uuidv7(),
      buyAccountId: accountId,
      sellAccountId: fms,
      buyParticipantType: 'CUSTOMER',
      sellParticipantType: 'MARKET_MAKER',
      aggressorSide: 'BUY',
      executedAt: clock.now().toString(),
      tradingDate: DAY,
    });
    await waitUntil(() => a.memory.account(accountId).trades.size === 1);
    expect(a.memory.account(accountId).holds.size).toBe(0);
    expect(a.memory.account(accountId).positions.get(instrumentId)).toBe(100);
    expect(power()).toBe('8999.70');

    // O lançamento do Clearing passa pelo ledger: U → P2 sem mexer no BP (ADR-0003).
    await send('ledger', 'ledger.journal_posted', accountId, {
      journalId: uuidv7(),
      type: 'TRADE',
      referenceType: 'TRADE',
      referenceId: tradeId,
      bookingDate: DAY,
      entries: [
        {
          accountCode: 'CUST_CASH',
          ownerId: accountId,
          amount: '-1000.00',
          valueDate: DAY,
          status: 'PENDING',
          sequence: 2,
        },
        {
          accountCode: 'CLEARING_HOUSE',
          ownerId: null,
          amount: '1000.00',
          valueDate: DAY,
          status: 'PENDING',
          sequence: 1,
        },
      ],
    });
    await waitUntil(() => a.memory.account(accountId).d2.toFixed(2) === '9000.00');
    expect(power()).toBe('8999.70');

    // Ordem de venda pelo OMS: o estado vira uma referência e o cancelamento libera.
    const sale = uuidv7();
    await send('oms', 'order.updated', accountId, {
      orderId: sale,
      accountId,
      instrumentId,
      side: 'SELL',
      status: 'NEW',
      quantity: 100,
      filledQuantity: 0,
      remainingQuantity: 100,
      canceledQuantity: 0,
      version: 1,
    });
    await waitUntil(() => a.memory.account(accountId).openOrders.has(sale));
    await send('oms', 'order.canceled', accountId, {
      orderId: sale,
      accountId,
      canceledQuantity: 100,
      reason: 'CLIENT',
    });
    await waitUntil(() => !a.memory.account(accountId).openOrders.has(sale));

    await send('market-data', 'market_data.reference_price_updated', instrumentId, {
      instrumentId,
      seq: 1,
      price: '10.5000',
      origin: 'BRAPI',
      anchorPrice: '10.5000',
      externalQuoteTime: null,
      at: clock.now().toString(),
    });
    await waitUntil(() => a.memory.prices.has(instrumentId));

    // Os holds saem no tópico do Risco, por conta.
    const received: { type: string; key: string }[] = [];
    const riskTopic = topicName('test', 'risk');
    for (const partition of await client.partitionsQuery({ superStream: riskTopic }))
      await client.declareConsumer({ stream: partition, offset: Offset.first() }, (m) => {
        const e = JSON.parse((m.content as Buffer).toString()) as {
          eventType: string;
          partitionKey: string;
        };
        received.push({ type: e.eventType, key: e.partitionKey });
      });
    await waitUntil(() => received.some((r) => r.type === 'risk.hold_consumed'), {
      timeoutMs: 30_000,
    });
    expect(received.map((r) => r.type)).toEqual(
      expect.arrayContaining(['risk.hold_created', 'risk.pretrade_approved', 'risk.hold_consumed']),
    );
    expect(new Set(received.map((r) => r.key))).toEqual(new Set([accountId]));

    // Reinício: retoma do offset salvo e não reaplica o negócio.
    await a.stop();
    const again = await app(env, { stream, clock, start: false });
    await again.start();
    await waitUntil(() => again.isReady(), { timeoutMs: 60_000 });
    expect(buyingPower(again.memory.account(accountId)).toFixed(2)).toBe('8999.70');
    expect(again.memory.account(accountId).positions.get(instrumentId)).toBe(100);
    await again.stop();
    await client.close();
  });
});
