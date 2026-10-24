// De ponta a ponta no barramento: eventos auditáveis de um tópico entram na trilha, e o
// routine.triggered da rotina diária gera a âncora e o routine.completed em test.audit.events.
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
import { DAILY_ROUTINE } from '../src/application/audit-trail.js';
import { app, reset, startEnv, stopEnv, waitUntil, type Env } from './helpers.js';

let env: Env;
let rabbit: StartedRabbitMq;
beforeAll(async () => {
  [env, rabbit] = await Promise.all([startEnv(), startRabbitMq()]);
}, 180_000);
afterAll(async () => {
  await stopEnv(env);
  await rabbit?.container.stop();
});

const envelope = (over: Record<string, unknown>) => ({
  eventId: uuidv7(),
  eventVersion: 1,
  environment: 'test',
  occurredAt: '2026-01-05T13:00:00.000Z',
  correlationId: uuidv7(),
  ...over,
});

describe('captura pelo barramento', () => {
  it('grava os auditáveis do tópico, uma vez só, e responde à rotina diária', async () => {
    await reset(env);
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-producers');
    const identity = topicName('test', 'identity');
    const scheduler = topicName('test', 'scheduler');
    await ensureSuperStream(client, identity, { partitions: 2 });
    await ensureSuperStream(client, scheduler, { partitions: 1 });

    const a = await app(env, { stream, sourceContexts: ['identity'] });
    await a.start();

    const login = envelope({
      eventType: 'auth.login_succeeded',
      source: 'identity-service',
      partitionKey: 'user-1',
      actor: { type: 'USER', id: 'user-1' },
      auditable: true,
      payload: { userId: 'user-1', ip: '10.1.1.1', userAgent: 'app/1' },
    });
    const noise = envelope({
      eventType: 'auth.token_refreshed',
      source: 'identity-service',
      partitionKey: 'user-1',
      actor: { type: 'USER', id: 'user-1' },
      auditable: false,
      payload: { userId: 'user-1' },
    });
    const producer = await PartitionedProducer.create(client, identity, `test.${uuidv7()}`);
    const body = (m: object) => Buffer.from(JSON.stringify(m));
    await producer.sendAll([
      { partitionKey: 'user-1', publishingId: 1n, messageId: login.eventId, body: body(login) },
      { partitionKey: 'user-1', publishingId: 2n, messageId: noise.eventId, body: body(noise) },
      // Reentrega: a inbox (e o event_id único) garante um registro só.
      { partitionKey: 'user-1', publishingId: 3n, messageId: login.eventId, body: body(login) },
    ]);
    await waitUntil(
      async () =>
        (
          await sql<{ n: bigint }>`
            SELECT count(*) AS n FROM processed_event WHERE consumer = 'audit.trail.identity'`.execute(
            env.db,
          )
        ).rows[0]!.n === 2n,
      15_000,
      'consumo da trilha',
    );
    const records = await a.store.recordsFrom(1, 10);
    expect(records).toMatchObject([
      {
        seq: 1,
        action: 'auth.login_succeeded',
        actorId: 'user-1',
        ip: '10.1.1.1',
        userAgent: 'app/1',
        source: 'identity-service',
      },
    ]);

    // A rotina diária chega pelo tópico do agendador.
    const executionId = uuidv7();
    const routine = envelope({
      eventType: 'routine.triggered',
      source: 'scheduler-service',
      partitionKey: DAILY_ROUTINE,
      actor: { type: 'SYSTEM', id: 'scheduler-service' },
      auditable: false,
      payload: {
        routineName: DAILY_ROUTINE,
        businessDate: '2026-01-05',
        executionId,
        attempt: 1,
        scheduledFor: '2026-01-06T02:30:00.000Z',
        catchUp: false,
      },
    });
    const schedulerProducer = await PartitionedProducer.create(
      client,
      scheduler,
      `test.${uuidv7()}`,
    );
    await schedulerProducer.sendAll([
      {
        partitionKey: DAILY_ROUTINE,
        publishingId: 1n,
        messageId: routine.eventId,
        body: body(routine),
      },
    ]);
    // O relay publica o routine.completed em test.audit.events.
    await waitUntil(
      async () =>
        (
          await sql<{ n: bigint }>`
            SELECT count(*) AS n FROM outbox_event
            WHERE event_type = 'routine.completed' AND published_at IS NOT NULL`.execute(env.db)
        ).rows[0]!.n === 1n,
      15_000,
      'routine.completed publicado',
    );
    expect(await a.store.lastAnchor()).toMatchObject({
      businessDate: '2026-01-05',
      seq: 1,
      hash: records[0]!.hash,
    });

    await a.stop();
    await client.close();
  });
});
