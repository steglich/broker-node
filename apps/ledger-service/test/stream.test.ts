// Consumidores pelo RabbitMQ: account.opened/status_changed (customer) e a rotina pix_reconciliation.
import { uuidv7 } from '@broker/ids';
import {
  connectStream,
  ensureSuperStream,
  PartitionedProducer,
  topicName,
} from '@broker/messaging';
import { waitUntil } from '@broker/testing';
import { startRabbitMq, type StartedRabbitMq } from '@broker/testing/containers';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIX_RECONCILIATION_ROUTINE } from '../src/app.js';
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

describe('consumidores do ledger-service', () => {
  it('account.opened (repetido) cria as contas uma vez; status_changed atualiza a cópia; a rotina reconcilia', async () => {
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-producers');
    await ensureSuperStream(client, topicName('test', 'customer'), { partitions: 2 });
    await ensureSuperStream(client, topicName('test', 'scheduler'), { partitions: 1 });
    const a = await app(env, { stream });
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

    const accountId = uuidv7();
    const opened = {
      accountId,
      customerId: uuidv7(),
      accountNumber: '1000001-9',
      openedAt: a.clock.now().toString(),
    };
    await send('customer', 'account.opened', accountId, opened);
    await send('customer', 'account.opened', accountId, opened);
    await send('customer', 'account.status_changed', accountId, {
      accountId,
      from: 'ACTIVE',
      to: 'BLOCKED',
      reasonCode: 'FRAUD_SUSPECTED',
      actor: { type: 'BACKOFFICE', id: 'op-1' },
    });
    const status = async () =>
      (
        await sql<{
          status: string;
        }>`SELECT status FROM customer_account WHERE account_id = ${accountId}`.execute(env.db)
      ).rows[0]?.status;
    await waitUntil(async () => (await status()) === 'BLOCKED', { timeoutMs: 20_000 });
    const { rows } = await sql<{ code: string }>`
      SELECT code FROM ledger_account WHERE owner_id = ${accountId} ORDER BY code`.execute(env.db);
    expect(rows.map((r) => r.code)).toEqual(['CUST_CASH', 'CUST_CASH_COLLATERAL']);

    const executionId = uuidv7();
    await send('scheduler', 'routine.triggered', PIX_RECONCILIATION_ROUTINE, {
      routineName: PIX_RECONCILIATION_ROUTINE,
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
      stats: { status: 'OK', divergences: 0 },
    });

    await a.stop();
    await client.close();
  });
});
