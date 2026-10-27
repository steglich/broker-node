// 18.3 consumidores dos eventos da Fase 1 pelo RabbitMQ; o e-mail chega na caixa de captura (Mailpit).
import { uuidv7 } from '@broker/ids';
import {
  connectStream,
  ensureSuperStream,
  PartitionedProducer,
  topicName,
} from '@broker/messaging';
import { testClock, waitUntil } from '@broker/testing';
import {
  startMailpit,
  startRabbitMq,
  type StartedMailpit,
  type StartedRabbitMq,
} from '@broker/testing/containers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpEmailSender } from '../src/adapters/integrations.js';
import { app, outbox, startEnv, stopEnv, type Env } from './helpers.js';

let env: Env;
let rabbit: StartedRabbitMq;
let mailpit: StartedMailpit;
beforeAll(async () => {
  [env, rabbit, mailpit] = await Promise.all([startEnv(), startRabbitMq(), startMailpit()]);
}, 180_000);
afterAll(async () => {
  await stopEnv(env);
  await rabbit?.container.stop();
  await mailpit?.container.stop();
});

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function inbox(): Promise<MailpitMessage[]> {
  const res = await fetch(`${mailpit.apiUrl}/api/v1/messages`);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}

async function text(id: string): Promise<string> {
  const res = await fetch(`${mailpit.apiUrl}/api/v1/message/${id}`);
  return ((await res.json()) as { Text: string }).Text;
}

describe('18.3 consumidores do notification-service', () => {
  it('deposit.credited no ledger.events → DEPOSIT_CREDITED na caixa de captura; customer e identity também', async () => {
    const stream = {
      host: rabbit.host,
      port: rabbit.streamPort,
      user: rabbit.user,
      password: rabbit.password,
    };
    const client = await connectStream(stream, 'test-producers');
    for (const ctx of ['ledger', 'customer', 'identity'])
      await ensureSuperStream(client, topicName('test', ctx), { partitions: 2 });
    const email = new SmtpEmailSender({
      host: mailpit.smtpHost,
      port: mailpit.smtpPort,
      from: 'Broker <avisos@broker.localhost>',
    });
    const a = await app(env, {
      stream,
      clock: testClock('2026-10-27T14:00:00Z'),
      email,
      workerIntervalMs: 100,
    });
    const c = a.recipients.add({
      userId: uuidv7(),
      accountId: uuidv7(),
      email: 'maria@exemplo.com',
      phone: '+5511987654321',
    });
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
      return e.eventId;
    };

    // Os consumidores começam em `next`: espera estarem de pé antes de publicar.
    await new Promise((r) => setTimeout(r, 1500));
    await send('ledger', 'deposit.credited', c.accountId!, {
      depositId: uuidv7(),
      accountId: c.accountId,
      amount: '1500.5',
    });
    await send('customer', 'account.status_changed', c.accountId!, {
      accountId: c.accountId,
      from: 'ACTIVE',
      to: 'BLOCKED',
      reasonCode: 'OPERATOR',
      actor: { type: 'USER', id: 'op-1' },
    });
    await send('identity', 'identity.password_changed', c.userId, {
      userId: c.userId,
      at: a.clock.now().toString(),
    });

    await waitUntil(async () => (await inbox()).length >= 3, { timeoutMs: 30_000 });
    const messages = await inbox();
    expect(messages.map((m) => m.Subject).sort()).toEqual([
      'Alteração de segurança',
      'Depósito creditado',
      'Status da conta alterado',
    ]);
    const credited = messages.find((m) => m.Subject === 'Depósito creditado')!;
    expect(credited.To.map((t) => t.Address)).toEqual(['maria@exemplo.com']);
    const body = await text(credited.ID);
    expect(body).toContain('R$ 1.500,50');
    expect(body).toContain('27/10/2026 às 11:00');
    expect(body).toContain('https://app.broker.test/extrato');
    // O SMS da troca de senha foi para o message-sink.
    expect(a.sink.smsSent).toHaveLength(1);
    expect(
      (await outbox(env.db, 'notification.created')).map((e) => e.payload['code']).sort(),
    ).toEqual(['ACCOUNT_STATUS_CHANGED', 'DEPOSIT_CREDITED', 'SECURITY_PASSWORD_CHANGED']);

    await a.stop();
    email.close();
    await client.close();
  });
});
