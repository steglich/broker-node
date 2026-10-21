import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventConsumer, PermanentError, topicName, type Envelope } from '../src/index.js';
import { createDatabase } from '@broker/persistence';
import { newId, pgConfig, sleep, waitUntil } from './helpers.js';
import { consumerDb, effects, envelope, streamSettings, TestProducer } from './stream-fixture.js';

const SUPER_STREAM = topicName('prod', 'clearing');
let db: Kysely<unknown>;
let producer: TestProducer;
let ordered: EventConsumer;
let unordered: EventConsumer;
/** Enquanto true, eventos com `poison` falham de forma permanente (simula um bug). */
let bugActive = true;

function consumer(
  name: string,
  isOrdered: boolean,
  table: 'effect' | 'effect_unordered',
): EventConsumer {
  return new EventConsumer({
    name,
    environment: 'prod',
    superStream: SUPER_STREAM,
    stream: streamSettings(),
    db,
    ordered: isOrdered,
    newId,
    handlers: {
      'clearing.trade_allocated': {
        handle: async (trx, env: Envelope) => {
          const p = env.payload as { seq: number; poison?: boolean };
          if (p.poison && bugActive) throw new PermanentError('bug no handler (simulado)');
          await sql`INSERT INTO ${sql.table(table)} (event_id, partition_key, seq) VALUES (${env.eventId}, ${env.partitionKey}, ${p.seq})`.execute(
            trx,
          );
        },
      },
    },
  });
}

const allocated = (key: string, seq: number, poison = false) =>
  envelope('clearing.trade_allocated', key, { seq, poison });
const parked = async (key: string) =>
  Number(
    (
      await sql<{
        n: string;
      }>`SELECT count(*) AS n FROM parked_message WHERE consumer = 'custody.allocator' AND partition_key = ${key}`.execute(
        db,
      )
    ).rows[0]!.n,
  );
const blocked = async (key: string) =>
  (
    await sql`SELECT 1 FROM blocked_key WHERE consumer = 'custody.allocator' AND partition_key = ${key}`.execute(
      db,
    )
  ).rows.length > 0;

beforeAll(async () => {
  db = await consumerDb('blocking');
  producer = await TestProducer.create(SUPER_STREAM);
  ordered = consumer('custody.allocator', true, 'effect');
  await ordered.start();
}, 120_000);

afterAll(async () => {
  await ordered?.stop();
  await unordered?.stop();
  await producer?.close();
  await db?.destroy();
});

describe('bloqueio por chave (RN-MSG-B-035)', () => {
  it('RN-MSG-B-035: a chave A fica retida enquanto a B segue; a liberação reprocessa A em ordem', async () => {
    const a1 = allocated('acc-A', 1, true);
    await producer.send([
      a1,
      allocated('acc-A', 2),
      allocated('acc-B', 1),
      allocated('acc-A', 3),
      allocated('acc-B', 2),
    ]);

    await waitUntil(
      async () => (await effects(db, 'acc-B')).length === 2,
      15_000,
      'chave B processada',
    );
    await waitUntil(async () => (await parked('acc-A')) === 2, 15_000, 'A2 e A3 estacionadas');
    expect(await blocked('acc-A')).toBe(true);
    expect(await effects(db, 'acc-A')).toEqual([]);

    // Mais uma da chave A chega enquanto ela está bloqueada: também estaciona, atrás das outras.
    await producer.send([allocated('acc-A', 4)]);
    await waitUntil(async () => (await parked('acc-A')) === 3, 15_000, 'A4 estacionada');

    // O bug é corrigido e a mensagem que bloqueava é reprocessada pela ferramenta de DLQ.
    bugActive = false;
    const dl = (
      await sql<{ id: string }>`SELECT id FROM dead_letter WHERE event_id = ${a1.eventId}`.execute(
        db,
      )
    ).rows[0]!;
    await ordered.reprocessDeadLetter(dl.id, 'operador-1', 'handler corrigido');

    expect((await effects(db, 'acc-A')).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(await parked('acc-A')).toBe(0);
    expect(await blocked('acc-A')).toBe(false);

    // Depois de liberada, a chave volta ao fluxo normal.
    await producer.send([allocated('acc-A', 5)]);
    await waitUntil(async () => (await effects(db, 'acc-A')).length === 5, 15_000, 'A5');
    expect((await effects(db, 'acc-A')).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('RN-MSG-B-035: em consumidor não ordenado (ex.: notificações), a DLQ não bloqueia a chave', async () => {
    // Tabela própria do consumidor não ordenado, criada pelo migrador (o usuário da aplicação não tem DDL).
    const migrator = createDatabase(pgConfig('blocking', 'migrator'));
    await sql`CREATE TABLE IF NOT EXISTS effect_unordered (LIKE effect INCLUDING ALL)`.execute(
      migrator,
    );
    await sql`GRANT SELECT, INSERT ON effect_unordered TO blocking_app`.execute(migrator);
    await migrator.destroy();

    bugActive = true;
    unordered = consumer('notification.sender', false, 'effect_unordered');
    await unordered.start();
    await producer.send([
      allocated('user-1', 1, true),
      allocated('user-1', 2),
      allocated('user-1', 3),
    ]);
    await waitUntil(
      async () =>
        (
          await sql<{
            n: bigint;
          }>`SELECT count(*) AS n FROM effect_unordered WHERE partition_key = 'user-1'`.execute(db)
        ).rows[0]!.n === 2n,
      15_000,
      'user-1 seguiu',
    );
    await sleep(300);
    const rows = await sql<{
      seq: number;
    }>`SELECT seq FROM effect_unordered WHERE partition_key = 'user-1' ORDER BY id`.execute(db);
    expect(rows.rows.map((r) => r.seq)).toEqual([2, 3]);
    expect(
      (await sql`SELECT 1 FROM blocked_key WHERE consumer = 'notification.sender'`.execute(db))
        .rows,
    ).toHaveLength(0);
  });
});
