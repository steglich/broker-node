import { sql, type Kysely } from 'kysely';
import Type from 'typebox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineEvent, EventConsumer, topicName, type Envelope } from '../src/index.js';
import { newId, sleep, waitUntil } from './helpers.js';
import { consumerDb, effects, envelope, streamSettings, TestProducer } from './stream-fixture.js';

const SUPER_STREAM = topicName('prod', 'custody');
const Moved = defineEvent({
  eventType: 'custody.position_moved',
  eventVersion: 1,
  payload: Type.Object({ seq: Type.Integer() }),
});

let db: Kysely<unknown>;
let producer: TestProducer;
let calls = 0;

function makeConsumer(): EventConsumer {
  return new EventConsumer({
    name: 'portfolio.projector',
    environment: 'prod',
    superStream: SUPER_STREAM,
    stream: streamSettings(),
    db,
    ordered: true,
    newId,
    localAttempts: 2,
    backoff: { initialMs: 10, maxMs: 10 },
    handlers: {
      'custody.position_moved': {
        definition: Moved,
        handle: async (trx, env: Envelope) => {
          calls++;
          await sql`INSERT INTO effect (event_id, partition_key, seq) VALUES (${env.eventId}, ${env.partitionKey}, ${(env.payload as { seq: number }).seq})`.execute(
            trx,
          );
        },
      },
    },
  });
}

const moved = (key: string, seq: number, overrides: Partial<Envelope> = {}) =>
  envelope('custody.position_moved', key, { seq }, overrides);
const deadLetters = async () =>
  (
    await sql<{
      error: string;
      event_id: string | null;
    }>`SELECT error, event_id FROM dead_letter ORDER BY created_at`.execute(db)
  ).rows;

let consumer: EventConsumer;

beforeAll(async () => {
  db = await consumerDb('consumer');
  producer = await TestProducer.create(SUPER_STREAM);
  consumer = makeConsumer();
  await consumer.start();
}, 120_000);

afterAll(async () => {
  await consumer?.stop();
  await producer?.close();
  await db?.destroy();
});

describe('EventConsumer (RN-MSG-B-030..032)', () => {
  it('RN-MSG-B-032: processa os eventos de uma chave na ordem publicada', async () => {
    await producer.send([1, 2, 3, 4, 5].map((s) => moved('acc-order', s)));
    await waitUntil(async () => (await effects(db, 'acc-order')).length === 5, 15_000, 'efeitos');
    expect((await effects(db, 'acc-order')).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('RN-MSG-B-030: evento duplicado (mesmo eventId publicado duas vezes) aplica o efeito uma vez', async () => {
    const dup = moved('acc-dup', 1);
    await producer.send([dup, dup, moved('acc-dup', 2)]);
    await waitUntil(async () => (await effects(db, 'acc-dup')).length === 2, 15_000, 'efeitos');
    await sleep(500);
    expect((await effects(db, 'acc-dup')).map((e) => e.seq)).toEqual([1, 2]);
    const inbox = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM processed_event WHERE event_id = ${dup.eventId}`.execute(db);
    expect(Number(inbox.rows[0]!.n)).toBe(1);
  });

  it('RN-MSG-B-031: retoma do offset salvo depois de parar, sem reprocessar o que já foi feito', async () => {
    await consumer.stop();
    const callsBefore = calls;
    const offsetsBefore = (
      await sql<{
        offset: bigint;
      }>`SELECT "offset" FROM consumer_offset ORDER BY partition`.execute(db)
    ).rows;
    await producer.send([1, 2, 3].map((s) => moved('acc-resume', s)));

    consumer = makeConsumer();
    await consumer.start();
    await waitUntil(
      async () => (await effects(db, 'acc-resume')).length === 3,
      15_000,
      'efeitos após retomar',
    );
    await sleep(500);
    expect(calls - callsBefore).toBe(3); // só os 3 novos; nada relido do início
    const offsetsAfter = (
      await sql<{
        offset: bigint;
      }>`SELECT "offset" FROM consumer_offset ORDER BY partition`.execute(db)
    ).rows;
    expect(offsetsAfter.reduce((a, r) => a + r.offset, 0n)).toBeGreaterThan(
      offsetsBefore.reduce((a, r) => a + r.offset, 0n),
    );
  });

  it('RN-MSG-B-012: mensagem de outro ambiente vai para a DLQ sem efeito', async () => {
    const foreign = moved('acc-env', 1, { environment: 'sandbox' });
    await producer.send([foreign]);
    await waitUntil(
      async () => (await deadLetters()).some((d) => /sandbox/.test(d.error)),
      15_000,
      'DLQ',
    );
    expect(await effects(db, 'acc-env')).toEqual([]);
  });

  it('spec: mensagem sem eventId vai direto para a DLQ como erro permanente', async () => {
    const { eventId: _omit, ...withoutId } = moved('acc-noid', 1);
    await producer.sendRaw('acc-noid', JSON.stringify(withoutId));
    await waitUntil(
      async () => (await deadLetters()).some((d) => /eventId/.test(d.error)),
      15_000,
      'DLQ',
    );
  });

  it('RN-MSG-B-022: campo desconhecido no envelope e no payload é ignorado (tolerant reader)', async () => {
    await producer.send([
      moved('acc-tolerant', 1, {
        novoCampo: 'x',
        payload: { seq: 1, campoNovo: true },
      } as Partial<Envelope>),
    ]);
    await waitUntil(async () => (await effects(db, 'acc-tolerant')).length === 1, 15_000, 'efeito');
  });

  it('RN-MSG-B-021: outra versão do evento e eventos não tratados são ignorados, sem DLQ', async () => {
    const before = (await deadLetters()).length;
    await producer.send([
      moved('acc-version', 1, { eventVersion: 2 }),
      envelope('custody.other_thing', 'acc-version', {}),
      moved('acc-version', 3),
    ]);
    await waitUntil(async () => (await effects(db, 'acc-version')).length === 1, 15_000, 'efeito');
    expect((await effects(db, 'acc-version')).map((e) => e.seq)).toEqual([3]);
    expect((await deadLetters()).length).toBe(before);
  });
});
