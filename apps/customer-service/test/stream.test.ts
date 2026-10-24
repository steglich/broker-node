// Consumidores pelo RabbitMQ: identity.user_registered, ledger.negative_balance_* e a rotina diária do agendador.
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
import { DAILY_ROUTINE } from '../src/app.js';
import {
  app,
  bearer,
  onboardUntil,
  startEnv,
  stopEnv,
  submitAndDecide,
  waitUntil,
  type Env,
} from './helpers.js';

let env: Env;
let rabbit: StartedRabbitMq;
beforeAll(async () => {
  [env, rabbit] = await Promise.all([startEnv(), startRabbitMq()]);
}, 180_000);
afterAll(async () => {
  await stopEnv(env);
  await rabbit?.container.stop();
});

describe('consumidores do customer-service', () => {
  it('cria a solicitação no cadastro do login, restringe por saldo devedor e responde à rotina diária', async () => {
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-producers');
    for (const ctx of ['identity', 'ledger'])
      await ensureSuperStream(client, topicName('test', ctx), { partitions: 2 });
    const a = await app(env, { stream, consumeLedgerEvents: true });
    await a.start();

    let id = 0n;
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
          publishingId: ++id,
          messageId: e.eventId,
          body: Buffer.from(JSON.stringify(e)),
        },
      ]);
    };

    const userId = uuidv7();
    await send('identity', 'identity.user_registered', userId, {
      userId,
      realm: 'customers',
      emailHash: 'a'.repeat(64),
      registeredAt: a.clock.now().toString(),
    });
    await send('identity', 'identity.user_registered', uuidv7(), {
      userId: uuidv7(),
      realm: 'backoffice',
      emailHash: 'b'.repeat(64),
      registeredAt: a.clock.now().toString(),
    });
    await waitUntil(
      async () =>
        (await sql`SELECT 1 FROM onboarding_application WHERE user_id = ${userId}`.execute(env.db))
          .rows.length === 1,
    );
    expect(
      (await sql`SELECT count(*)::int AS n FROM onboarding_application`.execute(env.db)).rows,
    ).toEqual([{ n: 1 }]);

    const c = await onboardUntil(a, 'TERMS');
    expect(await submitAndDecide(a, c)).toBe('APPROVED');
    const accountId = (await a.http.get('/v1/me/profile').set(bearer(c.token))).body.account
      .accountId as string;
    const status = async () =>
      (
        await sql<{
          status: string;
        }>`SELECT status FROM investment_account WHERE id = ${accountId}`.execute(env.db)
      ).rows[0]!.status;
    await send('ledger', 'ledger.negative_balance_detected', accountId, {
      accountId,
      settledBalance: '-120.50',
    });
    await waitUntil(async () => (await status()) === 'RESTRICTED');
    await send('ledger', 'ledger.negative_balance_cleared', accountId, {
      accountId,
      settledBalance: '0.00',
    });
    await waitUntil(async () => (await status()) === 'ACTIVE');

    const executionId = uuidv7();
    await send('scheduler', 'routine.triggered', DAILY_ROUTINE, {
      routineName: DAILY_ROUTINE,
      businessDate: '2026-01-05',
      executionId,
      attempt: 1,
      scheduledFor: a.clock.now().toString(),
      catchUp: false,
    });
    await waitUntil(
      async () =>
        (
          await sql`SELECT 1 FROM outbox_event WHERE event_type = 'routine.completed'`.execute(
            env.db,
          )
        ).rows.length === 1,
    );
    const done = (
      await sql<{
        payload: { executionId: string; stats: object };
      }>`SELECT payload FROM outbox_event WHERE event_type = 'routine.completed'`.execute(env.db)
    ).rows[0]!;
    expect(done.payload).toMatchObject({ executionId, stats: { expiredApplications: 0 } });

    await a.stop();
    await client.close();
  });
});
