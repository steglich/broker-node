// Consumidores pelo RabbitMQ: catálogo, renomeação, cotação e defasagem (market-data) e a rotina
// diária.
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
import { REFERENCE_DAILY_ROUTINE } from '../src/app.js';
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

describe('consumidores do reference-data-service', () => {
  it('catalog_synced (repetido) cria uma vez; rename abre tarefa; a rotina diária conclui', async () => {
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-producers');
    await ensureSuperStream(client, topicName('test', 'market-data'), { partitions: 2 });
    await ensureSuperStream(client, topicName('test', 'scheduler'), { partitions: 1 });
    const a = await app(env, { stream, clock: testClock('2026-01-05T13:00:00Z') });
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

    const catalog = {
      newSymbols: [
        { symbol: 'PETR4', shortName: 'PETROBRAS PN' },
        { symbol: 'KNRI11', assetType: 'REIT' },
      ],
      inactiveSymbols: [],
      syncedAt: a.clock.now().toString(),
    };
    await send('market-data', 'market_data.catalog_synced', 'catalog', catalog);
    await send('market-data', 'market_data.catalog_synced', 'catalog', catalog);
    const count = async () =>
      Number(
        (await sql<{ n: string }>`SELECT count(*) AS n FROM instrument`.execute(env.db)).rows[0]!.n,
      );
    // Partições diferentes: a renomeação só acha o ticker depois do catálogo.
    await waitUntil(async () => (await count()) === 2, { timeoutMs: 20_000 });
    await send('market-data', 'market_data.symbol_rename_detected', 'PETR4', {
      oldSymbol: 'PETR4',
      newSymbol: 'PETZ4',
      effectiveDate: '2026-01-12',
    });
    const tasks = async () =>
      Number(
        (await sql<{ n: string }>`SELECT count(*) AS n FROM backoffice_task`.execute(env.db))
          .rows[0]!.n,
      );
    await waitUntil(async () => (await tasks()) === 1, { timeoutMs: 20_000 });
    expect(await count()).toBe(2);
    const knri = (
      await sql<{ lot_size: number; tradable: boolean; source: string }>`
      SELECT lot_size, tradable, source FROM instrument WHERE symbol = 'KNRI11'`.execute(env.db)
    ).rows[0];
    expect(knri).toEqual({ lot_size: 1, tradable: false, source: 'BRAPI' });

    // Primeira cotação válida (market_data.external_quote_received): PENDING → ACTIVE.
    const petr = (
      await sql<{ id: string; status: string }>`
      SELECT id, status FROM instrument WHERE symbol = 'PETR4'`.execute(env.db)
    ).rows[0]!;
    expect(petr.status).toBe('PENDING');
    await send('market-data', 'market_data.external_quote_received', petr.id, {
      instrumentId: petr.id,
      symbol: 'PETR4',
      sourceSymbol: 'PETR4',
      kind: 'INSTRUMENT',
      lastPrice: '38.45',
      quoteTime: a.clock.now().toString(),
      open: null,
      high: null,
      low: null,
      previousClose: null,
      change: null,
      changePercent: null,
      volume: null,
      marketCap: null,
      week52Low: null,
      week52High: null,
      currency: 'BRL',
      stale: false,
      source: 'fixture',
      fetchedAt: a.clock.now().toString(),
    });
    const status = async () =>
      (
        await sql<{ status: string }>`SELECT status FROM instrument WHERE id = ${petr.id}`.execute(
          env.db,
        )
      ).rows[0]!.status;
    await waitUntil(async () => (await status()) === 'ACTIVE', { timeoutMs: 20_000 });

    const executionId = uuidv7();
    await send('scheduler', 'routine.triggered', REFERENCE_DAILY_ROUTINE, {
      routineName: REFERENCE_DAILY_ROUTINE,
      businessDate: '2026-01-05',
      executionId,
      attempt: 1,
      scheduledFor: a.clock.now().toString(),
      catchUp: false,
    });
    const completed = async () =>
      (
        await sql<{ payload: { executionId: string; stats: object } }>`
          SELECT payload FROM outbox_event WHERE event_type = 'routine.completed'`.execute(env.db)
      ).rows;
    await waitUntil(async () => (await completed()).length === 1, { timeoutMs: 20_000 });
    expect((await completed())[0]!.payload).toMatchObject({
      executionId,
      stats: { coverageEnd: '2027-12-31', alerted: false, suspended: 0 },
    });

    await a.stop();
    await client.close();
  });
});
