// RN-ROT-002 de ponta a ponta no barramento: o dono da rotina publica routine.completed no PRÓPRIO
// tópico (aqui, test.clearing.events); o agendador consome, grava com a inbox e libera a dependente.
import { uuidv7 } from '@broker/ids';
import {
  connectStream,
  ensureSuperStream,
  PartitionedProducer,
  topicName,
} from '@broker/messaging';
import { startRabbitMq, type StartedRabbitMq } from '@broker/testing/containers';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, brt, reset, startDb, waitUntil, type Env } from './helpers.js';

let env: Env;
let rabbit: StartedRabbitMq;
beforeAll(async () => {
  [env, rabbit] = await Promise.all([startDb(), startRabbitMq()]);
}, 180_000);
afterAll(async () => {
  await env?.db.destroy();
  await Promise.all([env?.pg.container.stop(), rabbit?.container.stop()]);
});

const status = async (name: string) =>
  (
    await sql<{ status: string; execution_id: string }>`
    SELECT status, execution_id FROM routine_execution WHERE routine_name = ${name}`.execute(env.db)
  ).rows[0];

describe('resultado de rotina pelo barramento (RN-ROT-002)', () => {
  it('routine.completed no tópico do dono libera a dependente; repetir a mensagem não muda nada', async () => {
    await reset(env.db);
    // Só duas rotinas de teste: a "pai" (do clearing) e a "filha", que depende dela.
    await sql`UPDATE routine_definition SET enabled = false`.execute(env.db);
    await sql`
      INSERT INTO routine_definition (name, owner, schedule, days, depends_on) VALUES
        ('test_parent', 'clearing-service', '{"at":"08:00"}', 'TRADING', '{}'),
        ('test_child', 'clearing-service', '{"at":"08:00"}', 'TRADING', '{test_parent}')`.execute(
      env.db,
    );

    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const a = await app(env, {
      clock: { mode: 'VIRTUAL', start: brt('2026-03-03', '08:05') },
      stream,
      resultContexts: ['clearing'],
    });
    // O tópico do dono existe antes de alguém publicar nele.
    const client = await connectStream(stream, 'test-owner');
    const ownerTopic = topicName('test', 'clearing');
    await ensureSuperStream(client, ownerTopic, { partitions: 1 });
    await a.start();
    await waitUntil(
      async () => (await status('test_parent'))?.status === 'TRIGGERED',
      10_000,
      'pai disparado',
    );
    expect(await status('test_child')).toBeUndefined();

    // O relay do líder publicou o routine.triggered em test.scheduler.events.
    await waitUntil(
      async () =>
        (
          await sql<{
            n: bigint;
          }>`SELECT count(*) AS n FROM outbox_event WHERE published_at IS NULL`.execute(env.db)
        ).rows[0]!.n === 0n,
      10_000,
      'relay publicar',
    );

    const parent = (await status('test_parent'))!;
    const producer = await PartitionedProducer.create(client, ownerTopic, `test-owner.${uuidv7()}`);
    const message = {
      eventId: uuidv7(),
      eventType: 'routine.completed',
      eventVersion: 1,
      source: 'clearing-service',
      environment: 'test',
      occurredAt: brt('2026-03-03', '08:06').toString(),
      partitionKey: 'test_parent',
      correlationId: uuidv7(),
      actor: { type: 'SERVICE', id: 'clearing-service' },
      auditable: false,
      payload: {
        routineName: 'test_parent',
        businessDate: '2026-03-03',
        executionId: parent.execution_id,
      },
    };
    const body = Buffer.from(JSON.stringify(message));
    // A mesma mensagem duas vezes (entrega pelo menos uma vez): a inbox aplica uma só.
    await producer.sendAll([
      { partitionKey: 'test_parent', publishingId: 1n, messageId: message.eventId, body },
      { partitionKey: 'test_parent', publishingId: 2n, messageId: message.eventId, body },
    ]);

    await waitUntil(
      async () => (await status('test_child'))?.status === 'TRIGGERED',
      15_000,
      'filha disparada',
    );
    expect((await status('test_parent'))!.status).toBe('COMPLETED');
    const inbox = await sql<{
      consumer: string;
    }>`SELECT consumer FROM processed_event WHERE event_id = ${message.eventId}`.execute(env.db);
    expect(inbox.rows).toEqual([{ consumer: 'scheduler.routine-results.clearing' }]);

    await a.stop();
    await client.close();
  });
});
