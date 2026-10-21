import { Instant } from '@broker/domain-kernel';
import { inTransaction } from '@broker/persistence';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import { Offset, type Client } from 'rabbitmq-stream-js-client';
import Type from 'typebox';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  connectStream,
  defineEvent,
  ensureSuperStream,
  EventConsumer,
  EventPublisher,
  topicName,
  type Envelope,
} from '../src/index.js';
import { actor, clock, newId, pgConfig, serviceDb, waitUntil } from './helpers.js';
import { consumerDb as sinkDb } from './stream-fixture.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const SUPER_STREAM = topicName('prod', 'ledger');
const EntryPosted = defineEvent({
  eventType: 'ledger.entry_posted',
  eventVersion: 1,
  payload: Type.Object({ accountId: Type.String(), seq: Type.Integer() }),
});

let producerDb: Kysely<unknown>;
let consumerDb: Kysely<unknown>;
let admin: Client;
let consumer: EventConsumer;
const publisher = new EventPublisher({
  source: 'ledger-service',
  environment: 'prod',
  clock: clock(),
  newId,
});
const stream = () => {
  const { rabbit } = inject('broker');
  return {
    host: rabbit.host,
    port: rabbit.streamPort,
    user: rabbit.user,
    password: rabbit.password,
  };
};

/** Roda o relay num processo separado; resolve quando o processo terminar. */
function runRelay(env: { crash: boolean; publisherRef: string }): {
  done: Promise<string | null>;
  kill: () => void;
  output: string[];
} {
  const output: string[] = [];
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=source', 'test/fixtures/relay-process.ts'],
    {
      cwd: pkgDir,
      env: {
        ...process.env,
        RELAY_DB: JSON.stringify(pgConfig('relay', 'app')),
        RELAY_STREAM: JSON.stringify(stream()),
        RELAY_SUPER_STREAM: SUPER_STREAM,
        RELAY_PUBLISHER_REF: env.publisherRef,
        RELAY_CRASH: env.crash ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const collect = (c: Buffer) => output.push(...c.toString().split('\n').filter(Boolean));
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  return {
    done: new Promise((r) => proc.on('exit', (_code, signal) => r(signal))),
    kill: () => proc.kill('SIGKILL'),
    output,
  };
}

const unpublished = async () =>
  Number(
    (
      await sql<{
        n: string;
      }>`SELECT count(*) AS n FROM outbox_event WHERE published_at IS NULL`.execute(producerDb)
    ).rows[0]!.n,
  );
const effects = async () =>
  (
    await sql<{
      event_id: string;
      account_id: string;
      seq: number;
    }>`SELECT event_id, partition_key AS account_id, seq FROM effect ORDER BY id`.execute(
      consumerDb,
    )
  ).rows;

/** Quantas cópias de cada eventId existem no super stream (lendo todas as partições do início). */
async function copiesInStream(): Promise<Map<string, number>> {
  const reader = await connectStream(stream(), 'stream-reader');
  const copies = new Map<string, number>();
  const partitions = await reader.partitionsQuery({ superStream: SUPER_STREAM });
  let last = Date.now();
  for (const p of partitions) {
    await reader.declareConsumer({ stream: p, offset: Offset.first() }, (m) => {
      const id = (JSON.parse(m.content.toString()) as Envelope).eventId;
      copies.set(id, (copies.get(id) ?? 0) + 1);
      last = Date.now();
    });
  }
  await waitUntil(() => Date.now() - last > 1000, 15_000, 'leitura do stream');
  await reader.close();
  return copies;
}

async function publishEvents(account: string, seqs: number[]): Promise<string[]> {
  const ids: string[] = [];
  for (const seq of seqs) {
    ids.push(
      await inTransaction(producerDb, (trx) =>
        publisher.publish(
          trx,
          EntryPosted,
          { accountId: account, seq },
          { partitionKey: account, aggregateType: 'account', aggregateId: account, actor },
        ),
      ),
    );
  }
  return ids;
}

beforeAll(async () => {
  producerDb = await serviceDb('relay');
  // Banco próprio do consumidor deste teste, com a tabela `effect` onde o handler grava.
  consumerDb = await sinkDb('relaysink');

  admin = await connectStream(stream(), 'relay-test-admin');
  await ensureSuperStream(admin, SUPER_STREAM, { partitions: 3, maxAge: '90D' });

  consumer = new EventConsumer({
    name: 'balance.projector',
    environment: 'prod',
    superStream: SUPER_STREAM,
    stream: stream(),
    db: consumerDb,
    ordered: true,
    newId,
    handlers: {
      'ledger.entry_posted': {
        definition: EntryPosted,
        handle: async (trx, env) => {
          const p = env.payload as { accountId: string; seq: number };
          await sql`INSERT INTO effect (event_id, partition_key, seq) VALUES (${env.eventId}, ${p.accountId}, ${p.seq})`.execute(
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
  await admin?.close().catch(() => undefined);
  await Promise.all([producerDb?.destroy(), consumerDb?.destroy()]);
});

describe('outbox relay (ADR-0008, D7)', () => {
  it('ADR-0008: relay morto entre publicar e marcar → republica sem efeito duplicado; o broker deduplica', async () => {
    const ids = [
      ...(await publishEvents('acc-1', [1, 2, 3])),
      ...(await publishEvents('acc-2', [1, 2])),
    ];

    // 1) O relay publica, o broker confirma e o processo morre antes de marcar published_at.
    const crashed = runRelay({ crash: true, publisherRef: 'ledger.outbox.e1' });
    expect(await crashed.done).toBe('SIGKILL');
    expect(crashed.output).toContain('PUBLISHED 5');
    expect(await unpublished()).toBe(5); // a transação foi desfeita: nada marcado

    // 2) Um relay novo (mesma época do publisherRef) republica e marca.
    const healthy = runRelay({ crash: false, publisherRef: 'ledger.outbox.e1' });
    await waitUntil(async () => (await unpublished()) === 0, 20_000, 'outbox publicada');
    await waitUntil(async () => (await effects()).length >= 5, 20_000, 'efeitos no consumidor');
    healthy.kill();
    await healthy.done;

    // Efeito exatamente uma vez e na ordem de cada conta.
    const applied = await effects();
    expect(applied.map((e) => e.event_id).sort()).toEqual([...ids].sort());
    expect(applied.filter((e) => e.account_id === 'acc-1').map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(applied.filter((e) => e.account_id === 'acc-2').map((e) => e.seq)).toEqual([1, 2]);
    // O broker descartou a republicação pelo publishingId (= seq): uma cópia de cada no stream.
    const copies = await copiesInStream();
    for (const id of ids) expect(copies.get(id)).toBe(1);
  });

  it('RN-MSG-B-030: sem a deduplicação do broker (época nova), a inbox ainda garante o efeito único', async () => {
    const ids = await publishEvents('acc-3', [1, 2]);
    const crashed = runRelay({ crash: true, publisherRef: 'ledger.outbox.e2' });
    expect(await crashed.done).toBe('SIGKILL');
    // Época diferente: o broker não reconhece os publishingIds e grava as duas cópias.
    const healthy = runRelay({ crash: false, publisherRef: 'ledger.outbox.e3' });
    await waitUntil(async () => (await unpublished()) === 0, 20_000, 'outbox publicada');
    await waitUntil(
      async () => (await effects()).filter((e) => e.account_id === 'acc-3').length >= 2,
      20_000,
      'efeitos',
    );
    healthy.kill();
    await healthy.done;

    const copies = await copiesInStream();
    for (const id of ids) expect(copies.get(id)).toBe(2);
    await new Promise((r) => setTimeout(r, 1000)); // tempo para a cópia duplicada chegar ao consumidor
    expect((await effects()).filter((e) => e.account_id === 'acc-3').map((e) => e.seq)).toEqual([
      1, 2,
    ]);
  });

  it('D7: a limpeza apaga só os publicados há mais de 7 dias', async () => {
    const { OutboxRelay } = await import('../src/index.js');
    await sql`UPDATE outbox_event SET published_at = now() - interval '8 days' WHERE seq = (SELECT min(seq) FROM outbox_event)`.execute(
      producerDb,
    );
    const before = Number(
      (await sql<{ n: string }>`SELECT count(*) AS n FROM outbox_event`.execute(producerDb))
        .rows[0]!.n,
    );
    const relay = new OutboxRelay({
      db: producerDb,
      listenConfig: pgConfig('relay', 'app'),
      producer: undefined as never,
      clock: {
        mode: 'REAL',
        now: () => Instant.ofEpochMillis(0),
        businessDate: () => Instant.ofEpochMillis(0).businessDate(),
      },
    });
    expect(await relay.cleanup()).toBe(1);
    const after = Number(
      (await sql<{ n: string }>`SELECT count(*) AS n FROM outbox_event`.execute(producerDb))
        .rows[0]!.n,
    );
    expect(after).toBe(before - 1);
  });
});
