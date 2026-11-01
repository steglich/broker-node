// De ponta a ponta no barramento: rotina → fase em session.events, PhaseChange em engine.commands e
// routine.completed de volta; cópia do cadastro e resposta do Motor pelos consumidores.
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
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, brt, DAY, market, startEnv, stopEnv, type Env } from './helpers.js';

let env: Env;
let rabbit: StartedRabbitMq;
beforeAll(async () => {
  [env, rabbit] = await Promise.all([startEnv(), startRabbitMq()]);
}, 180_000);
afterAll(async () => {
  await stopEnv(env);
  await rabbit?.container.stop();
});

describe('barramento do trading-session-service', () => {
  it('rotina vira fase e comando no tópico certo; cadastro e Motor chegam pelos consumidores', async () => {
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-producers');
    for (const ctx of ['reference', 'market-data', 'engine'])
      await ensureSuperStream(client, topicName('test', ctx), { partitions: 2 });
    await ensureSuperStream(client, topicName('test', 'scheduler'), { partitions: 1 });

    const clock = testClock({ date: DAY, time: '09:44' });
    const a = await app(env, { stream, clock, loopIntervalMs: 50 });
    await a.start();

    const received = new Map<string, Record<string, unknown>[]>();
    const subscribe = async (topic: string) => {
      const partitions = await client.partitionsQuery({ superStream: topic });
      for (const partition of partitions)
        await client.declareConsumer({ stream: partition, offset: Offset.first() }, (m) => {
          const e = JSON.parse((m.content as Buffer).toString()) as {
            eventType: string;
            payload: Record<string, unknown>;
          };
          received.set(`${topic}:${e.eventType}`, [
            ...(received.get(`${topic}:${e.eventType}`) ?? []),
            e.payload,
          ]);
        });
    };
    const sessionTopic = topicName('test', 'session');
    const commandsTopic = topicName('test', 'engine', 'commands');
    await subscribe(sessionTopic);
    await subscribe(commandsTopic);

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
        source: `${ctx}-service`,
        environment: 'test',
        occurredAt: clock.now().toString(),
        partitionKey,
        correlationId: uuidv7(),
        actor: { type: 'SYSTEM', id: `${ctx}-service` },
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

    const instrumentId = uuidv7();
    await send('reference', 'instrument.tradability_changed', instrumentId, {
      instrumentId,
      symbol: 'PETR4',
      oddLotSymbol: 'PETR4F',
      lotSize: 100,
      tradable: true,
      approvalRequestId: uuidv7(),
    });
    await waitUntil(async () => {
      const i = await a.store.transaction((tx) => tx.instrument(instrumentId));
      return i?.tradable === true;
    });

    clock.advanceTo(brt(DAY, '09:45'));
    const executionId = uuidv7();
    await send('scheduler', 'routine.triggered', 'pre_opening', {
      routineName: 'pre_opening',
      businessDate: DAY,
      executionId,
      attempt: 1,
      scheduledFor: clock.now().toString(),
      catchUp: false,
    });

    await waitUntil(async () => (await market(a)).phase === 'PRE_OPENING');
    await waitUntil(() =>
      (received.get(`${commandsTopic}:engine.phase_change`) ?? []).some(
        (c) => c['phase'] === 'PRE_OPENING',
      ),
    );
    await waitUntil(() => received.has(`${sessionTopic}:routine.completed`));
    expect(received.get(`${sessionTopic}:session.phase_changed`)).toEqual([
      expect.objectContaining({ scope: 'MARKET', to: 'PRE_OPENING', reason: 'SCHEDULE' }),
    ]);
    expect(received.get(`${sessionTopic}:routine.completed`)![0]).toMatchObject({
      routineName: 'pre_opening',
      executionId,
    });
    // Comandos só em engine.commands, eventos só em session.events.
    expect(received.has(`${sessionTopic}:engine.phase_change`)).toBe(false);
    expect(received.has(`${commandsTopic}:session.phase_changed`)).toBe(false);

    const auctionId = (await a.store.transaction((tx) => tx.liveAuctions(instrumentId)))[0]!.id;
    await send('engine', 'engine.auction_indicative', instrumentId, {
      instrumentId,
      board: 'MAIN',
      engineSeq: 1,
      inputSeq: 1,
      auctionId,
      theoreticalPrice: '32.10',
      theoreticalQuantity: 500,
      imbalanceSide: null,
      imbalanceQuantity: 0,
    });
    await waitUntil(async () => {
      const { rows } = await sql<{ theoretical_quantity: bigint | null }>`
        SELECT theoretical_quantity FROM auction WHERE id = ${auctionId}`.execute(env.db);
      return rows[0]?.theoretical_quantity !== null;
    });

    await a.stop();
    await client.close();
  });
});
