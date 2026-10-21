import { sql, type Kysely } from 'kysely';
import Type from 'typebox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defineEvent,
  EventConsumer,
  openAmqp,
  topicName,
  type AmqpSession,
  type Envelope,
} from '../src/index.js';
import { newId, waitUntil } from './helpers.js';
import {
  amqpUrl,
  consumerDb,
  effects,
  envelope,
  streamSettings,
  TestProducer,
} from './stream-fixture.js';

const SUPER_STREAM = topicName('prod', 'risk');
const Hold = defineEvent({
  eventType: 'risk.hold_created',
  eventVersion: 1,
  payload: Type.Object({
    seq: Type.Integer(),
    amount: Type.String({ pattern: '^\\d+\\.\\d{2}$' }),
  }),
});

/** Atrasos curtos no teste; em produção são 1 min, 10 min e 1 h. */
const DELAYS = [300, 600, 900] as const;

let db: Kysely<unknown>;
let amqp: AmqpSession;
let producer: TestProducer;
let consumer: EventConsumer;
/** Quantas vezes ainda falhar, por eventId. -1 = falhar sempre. */
const failures = new Map<string, number>();
/** Linha do tempo das tentativas: [eventId, instante, resultado]. */
const timeline: Array<{ id: string; at: number; ok: boolean }> = [];
const alerts: string[] = [];

beforeAll(async () => {
  db = await consumerDb('retry');
  amqp = await openAmqp({ url: amqpUrl() });
  producer = await TestProducer.create(SUPER_STREAM);
  consumer = new EventConsumer({
    name: 'oms.hold-tracker',
    environment: 'prod',
    superStream: SUPER_STREAM,
    stream: streamSettings(),
    db,
    ordered: true,
    newId,
    retry: { amqp, delaysMs: DELAYS },
    backoff: { initialMs: 20, maxMs: 80 },
    onCriticalAlert: (a) => alerts.push(a.partitionKey),
    handlers: {
      'risk.hold_created': {
        definition: Hold,
        handle: async (trx, env: Envelope) => {
          const left = failures.get(env.eventId) ?? 0;
          if (left !== 0) {
            failures.set(env.eventId, left - 1);
            timeline.push({ id: env.eventId, at: Date.now(), ok: false });
            throw new Error('banco indisponível (simulado)');
          }
          timeline.push({ id: env.eventId, at: Date.now(), ok: true });
          await sql`INSERT INTO effect (event_id, partition_key, seq) VALUES (${env.eventId}, ${env.partitionKey}, ${(env.payload as { seq: number }).seq})`.execute(
            trx,
          );
        },
      },
    },
  });
  await consumer.start();
}, 120_000);

afterAll(async () => {
  await consumer?.stop();
  await producer?.close();
  await amqp?.connection.close().catch(() => undefined);
  await db?.destroy();
});

const hold = (key: string, seq: number, amount = '10.00') =>
  envelope('risk.hold_created', key, { seq, amount });
const attemptsOf = (id: string) => timeline.filter((t) => t.id === id);
const queueDepth = async (q: string) => (await amqp.channel.checkQueue(q)).messageCount;

describe('retentativas (RN-MSG-B-033/034)', () => {
  it('RN-MSG-B-033: erro transitório → 5 tentativas locais com backoff → retry.1m → retry.10m → sucesso', async () => {
    const msg = hold('acc-transient', 1);
    failures.set(msg.eventId, 6); // 5 locais + estágio 1 falham; o estágio 2 dá certo
    await producer.send([msg]);
    await waitUntil(
      async () => (await effects(db, 'acc-transient')).length === 1,
      20_000,
      'sucesso após retentativas',
    );

    const tries = attemptsOf(msg.eventId);
    expect(tries.map((t) => t.ok)).toEqual([false, false, false, false, false, false, true]);
    // Backoff local crescente (20, 40, 80, 80 ms) e depois os atrasos das filas.
    const gaps = tries.slice(1).map((t, i) => t.at - tries[i]!.at);
    expect(gaps.slice(0, 4).every((g, i) => g >= [20, 40, 80, 80][i]! - 5)).toBe(true);
    expect(gaps[4]).toBeGreaterThanOrEqual(DELAYS[0] - 50); // fila retry.1m
    expect(gaps[5]).toBeGreaterThanOrEqual(DELAYS[1] - 50); // fila retry.10m
    // Deu certo: nada na DLQ e a chave liberada.
    const dl = await sql`SELECT 1 FROM dead_letter WHERE event_id = ${msg.eventId}`.execute(db);
    expect(dl.rows).toHaveLength(0);
    await waitUntil(
      async () =>
        (await sql`SELECT 1 FROM blocked_key WHERE partition_key = 'acc-transient'`.execute(db))
          .rows.length === 0,
      5000,
      'chave liberada',
    );
  });

  it('RN-MSG-B-033: esgotadas as retentativas atrasadas, vai para a DLQ e bloqueia a chave', async () => {
    const msg = hold('acc-exhausted', 1);
    failures.set(msg.eventId, -1);
    await producer.send([msg]);
    await waitUntil(
      async () =>
        (await sql`SELECT 1 FROM dead_letter WHERE event_id = ${msg.eventId}`.execute(db)).rows
          .length === 1,
      20_000,
      'DLQ',
    );

    expect(attemptsOf(msg.eventId)).toHaveLength(5 + 3); // 5 locais + 1 por estágio (1m, 10m, 1h)
    const dl = (
      await sql<{
        attempts: number;
        error: string;
      }>`SELECT attempts, error FROM dead_letter WHERE event_id = ${msg.eventId}`.execute(db)
    ).rows[0]!;
    expect(dl.attempts).toBe(8);
    expect(dl.error).toMatch(/indisponível/);
    const block = (
      await sql<{
        reason: string;
      }>`SELECT reason FROM blocked_key WHERE partition_key = 'acc-exhausted'`.execute(db)
    ).rows[0];
    expect(block?.reason).toBe('DEAD_LETTER');
    expect(alerts).toContain('acc-exhausted');
    expect(await queueDepth('prod.oms.hold-tracker.dlq')).toBeGreaterThanOrEqual(1);
  });

  it('RN-MSG-B-034: erro de esquema vai direto para a DLQ, sem retentativa', async () => {
    const msg = hold('acc-schema', 1, '10.5'); // amount fora do padrão do esquema
    await producer.send([msg]);
    await waitUntil(
      async () =>
        (await sql`SELECT 1 FROM dead_letter WHERE event_id = ${msg.eventId}`.execute(db)).rows
          .length === 1,
      15_000,
      'DLQ',
    );
    const dl = (
      await sql<{
        attempts: number;
        error: string;
      }>`SELECT attempts, error FROM dead_letter WHERE event_id = ${msg.eventId}`.execute(db)
    ).rows[0]!;
    expect(dl.attempts).toBe(1);
    expect(dl.error).toMatch(/esquema/);
    expect(attemptsOf(msg.eventId)).toHaveLength(0); // o handler nem chegou a rodar
  });

  it('as filas quorum de retentativa existem com TTL e voltam para retry.return', async () => {
    for (const q of ['retry.1m', 'retry.10m', 'retry.1h', 'retry.return', 'dlq']) {
      await expect(amqp.channel.checkQueue(`prod.oms.hold-tracker.${q}`)).resolves.toBeTruthy();
    }
  });
});
