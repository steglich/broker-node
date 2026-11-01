// De ponta a ponta no barramento: cadastro, fase e preço chegam pelos consumidores, as ordens saem em
// engine.commands, as respostas do Motor voltam, e os eventos smm.* saem no tópico do serviço.
import { uuidv7 } from '@broker/ids';
import {
  connectStream,
  ensureSuperStream,
  PartitionedProducer,
  topicName,
} from '@broker/messaging';
import { testClock, waitUntil } from '@broker/testing';
import { startRabbitMq, type StartedRabbitMq } from '@broker/testing/containers';
import { sql } from 'kysely';
import { Offset } from 'rabbitmq-stream-js-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, bearer, DAY, inst, startEnv, stopEnv, type Env } from './helpers.js';

let env: Env;
let rabbit: StartedRabbitMq;
beforeAll(async () => {
  [env, rabbit] = await Promise.all([startEnv(), startRabbitMq()]);
}, 180_000);
afterAll(async () => {
  await stopEnv(env);
  await rabbit?.container.stop();
});

describe('barramento do market-maker-service', () => {
  it('cota pelo barramento, recebe o Motor de volta e o kill switch cancela tudo', async () => {
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-producers');
    const topics = ['reference', 'session', 'market-data', 'engine'];
    for (const ctx of topics)
      await ensureSuperStream(client, topicName('test', ctx), { partitions: 2 });
    const commandsTopic = topicName('test', 'engine', 'commands');
    await ensureSuperStream(client, commandsTopic, { partitions: 2 });
    await ensureSuperStream(client, topicName('test', 'scheduler'), { partitions: 1 });

    const clock = testClock({ date: DAY, time: '10:00' });
    const a = await app(env, { stream, clock, loopIntervalMs: 50 });
    await a.start();

    const received: { topic: string; type: string; payload: Record<string, unknown> }[] = [];
    const smmTopic = topicName('test', 'market-maker');
    for (const topic of [commandsTopic, smmTopic]) {
      for (const partition of await client.partitionsQuery({ superStream: topic }))
        await client.declareConsumer({ stream: partition, offset: Offset.first() }, (m) => {
          const e = JSON.parse((m.content as Buffer).toString()) as {
            eventType: string;
            payload: Record<string, unknown>;
          };
          received.push({ topic, type: e.eventType, payload: e.payload });
        });
    }
    const ofType = (type: string) => received.filter((r) => r.type === type);

    const send = async (
      topic: string,
      eventType: string,
      partitionKey: string,
      payload: object,
    ) => {
      const producer = await PartitionedProducer.create(client, topic, `test.${uuidv7()}`);
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

    const id = uuidv7();
    await send(topicName('test', 'reference'), 'instrument.updated', id, {
      instrumentId: id,
      symbol: 'PETR4',
      oddLotSymbol: 'PETR4F',
      isin: null,
      shortName: null,
      longName: null,
      assetType: 'STOCK',
      shareClass: 'PN',
      sector: null,
      subsector: null,
      currency: 'BRL',
      lotSize: 100,
      tickSize: '0.01',
      oddLotEnabled: true,
      shortSaleEnabled: true,
      dayTradeEnabled: true,
      collateralEligible: true,
      haircut: null,
      taxCategory: 'STOCK',
      status: 'ACTIVE',
      tradable: true,
      logoUrl: null,
      source: 'BRAPI',
      updatedAt: clock.now().toString(),
    });
    await send(commandsTopic, 'engine.band_update', id, {
      instrumentId: id,
      bandReferencePrice: '38.50',
      rejectionBandPct: '0.20',
      staticAuctionBandPct: '0.08',
      dynamicAuctionBandPct: '0.03',
      volatilityAuctionDurationS: 300,
      auctionRandomEndMaxS: 30,
    });
    await send(topicName('test', 'market-data'), 'market_data.reference_price_updated', id, {
      instrumentId: id,
      seq: 1,
      price: '38.5000',
      origin: 'BRAPI',
      anchorPrice: '38.5000',
      externalQuoteTime: clock.now().toString(),
      at: clock.now().toString(),
    });
    await send(topicName('test', 'session'), 'session.phase_changed', 'MARKET', {
      scope: 'MARKET',
      from: 'PRE_OPENING',
      to: 'CONTINUOUS',
      reason: 'SCHEDULE',
      effectiveAt: clock.now().toString(),
      expectedEndAt: null,
    });

    await waitUntil(async () => ofType('engine.new_order').length >= 12, { timeoutMs: 30_000 });
    await waitUntil(async () => ofType('smm.instrument_activated').length === 1, {
      timeoutMs: 30_000,
    });
    expect(received.find((r) => r.type === 'engine.new_order')!.topic).toBe(commandsTopic);
    expect(ofType('smm.instrument_activated')[0]!.topic).toBe(smmTopic);
    expect((await inst(a, id)).bandReference?.toFixed()).toBe('38.5');

    const first = ofType('engine.new_order')[0]!.payload as { orderId: string; quantity: number };
    await send(topicName('test', 'engine'), 'engine.order_booked', id, {
      instrumentId: id,
      board: 'MAIN',
      engineSeq: 1,
      inputSeq: 1,
      orderId: first.orderId,
      price: '38.48',
      remainingQuantity: first.quantity,
      prioritySeq: 1,
    });
    await waitUntil(
      async () =>
        (await inst(a, id)).liveOrders.find((o) => o.orderId === first.orderId)?.status ===
        'BOOKED',
      { timeoutMs: 30_000 },
    );

    await a.http
      .post('/v1/bo/smm/kill-switch')
      .set(bearer(a.tokens.market))
      .send({ enabled: false, justification: 'Teste do kill switch' })
      .expect(200);
    await waitUntil(async () => ofType('engine.cancel_order').length >= 12, { timeoutMs: 30_000 });
    await waitUntil(async () => ofType('smm.status_changed').length === 1, { timeoutMs: 30_000 });
    expect(ofType('smm.status_changed')[0]!.payload).toMatchObject({
      scope: 'GLOBAL',
      status: 'OFF',
    });

    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event WHERE published_at IS NULL`.execute(env.db);
    expect(Number(rows[0]!.n)).toBe(0);

    await a.stop();
    await client.close();
  });
});
