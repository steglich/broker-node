// Consumidores pelo RabbitMQ: cópia dos instrumentos (reference-data) e rotinas do agendador.
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, startEnv, stopEnv, type Env } from './helpers.js';

let env: Env;
let rabbit: StartedRabbitMq;
beforeAll(async () => {
  [env, rabbit] = await Promise.all([startEnv(), startRabbitMq()]);
}, 180_000);
afterAll(async () => {
  await stopEnv(env);
  await rabbit?.container.stop();
});

describe('consumidores do market-data-service', () => {
  it('instrument.created vira a cópia local; brapi_close_snapshot responde routine.completed', async () => {
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-producers');
    await ensureSuperStream(client, topicName('test', 'reference'), { partitions: 2 });
    await ensureSuperStream(client, topicName('test', 'scheduler'), { partitions: 1 });
    const a = await app(env, { stream, clock: testClock('2026-10-27T21:00:00Z') });
    await a.start();

    let seq = 0n;
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
        occurredAt: a.clock.now().toString(),
        partitionKey,
        correlationId: uuidv7(),
        actor: { type: 'SYSTEM', id: `${ctx}-service` },
        auditable: false,
        payload,
      };
      await producer.sendAll([
        {
          partitionKey,
          publishingId: ++seq,
          messageId: e.eventId,
          body: Buffer.from(JSON.stringify(e)),
        },
      ]);
    };

    const id = uuidv7();
    await send('reference', 'instrument.created', id, {
      instrumentId: id,
      symbol: 'PETR4',
      oddLotSymbol: 'PETR4F',
      isin: null,
      shortName: 'PETROBRAS PN',
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
      haircut: '0.30',
      taxCategory: 'STOCK',
      status: 'PENDING',
      tradable: false,
      logoUrl: null,
      source: 'BRAPI',
      updatedAt: a.clock.now().toString(),
    });
    await send('reference', 'instrument.tradability_changed', id, {
      instrumentId: id,
      symbol: 'PETR4',
      oddLotSymbol: 'PETR4F',
      lotSize: 100,
      tradable: true,
      approvalRequestId: uuidv7(),
    });
    await waitUntil(
      async () => (await a.store.transaction((tx) => tx.instrument(id)))?.tradable === true,
      { timeoutMs: 20_000 },
    );

    const executionId = uuidv7();
    await send('scheduler', 'routine.triggered', 'brapi_close_snapshot', {
      routineName: 'brapi_close_snapshot',
      businessDate: '2026-10-27',
      executionId,
      attempt: 1,
      scheduledFor: a.clock.now().toString(),
      catchUp: false,
    });
    const completed = async () =>
      (
        await sql<{ payload: { executionId: string; stats: Record<string, number> } }>`
          SELECT payload FROM outbox_event WHERE event_type = 'routine.completed'`.execute(env.db)
      ).rows;
    // O consumidor só grava o pedido; o líder executa no laço.
    await waitUntil(
      async () => {
        await a.jobs.runPending();
        return (await completed()).length === 1;
      },
      { timeoutMs: 20_000 },
    );
    expect((await completed())[0]!.payload).toMatchObject({ executionId, stats: { read: 2 } });

    await a.stop();
    await client.close();
  });
});
