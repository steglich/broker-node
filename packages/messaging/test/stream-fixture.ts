import { createDatabase, migrateToLatest, baseMigrations } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import { inject } from 'vitest';
import {
  connectStream,
  ensureSuperStream,
  PartitionedProducer,
  type Envelope,
  type StreamSettings,
} from '../src/index.js';
import { actor, newId, pgConfig } from './helpers.js';

export const streamSettings = (): StreamSettings => {
  const { rabbit } = inject('broker');
  return {
    host: rabbit.host,
    port: rabbit.streamPort,
    user: rabbit.user,
    password: rabbit.password,
  };
};

export const amqpUrl = () => {
  const { rabbit } = inject('broker');
  return `amqp://${rabbit.user}:${rabbit.password}@${rabbit.host}:${rabbit.amqpPort}/`;
};

/** Database do consumidor com as migrações-base e uma tabela `effect` onde o handler grava. */
export async function consumerDb(service: string): Promise<Kysely<unknown>> {
  const migrator = createDatabase(pgConfig(service, 'migrator'));
  await migrateToLatest(migrator, {
    ...baseMigrations,
    '0001_effect': {
      async up(db: Kysely<unknown>) {
        await sql`
          CREATE TABLE effect (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            event_id uuid NOT NULL,
            partition_key text NOT NULL,
            seq int NOT NULL
          )`.execute(db);
      },
    },
  });
  await migrator.destroy();
  return createDatabase(pgConfig(service, 'app'));
}

export const effects = async (db: Kysely<unknown>, key?: string) =>
  (
    await sql<{ event_id: string; partition_key: string; seq: number }>`
      SELECT event_id, partition_key, seq FROM effect
      WHERE ${key ?? null}::text IS NULL OR partition_key = ${key ?? null} ORDER BY id`.execute(db)
  ).rows;

/** Publica envelopes direto no super stream (sem outbox), para testar o consumidor isolado. */
export class TestProducer {
  private nextId = 1n;
  private constructor(
    private readonly producer: PartitionedProducer,
    readonly close: () => Promise<void>,
  ) {}

  static async create(
    superStream: string,
    publisherRef = `test.${newId()}`,
  ): Promise<TestProducer> {
    const client = await connectStream(streamSettings(), `test-producer:${superStream}`);
    await ensureSuperStream(client, superStream, { partitions: 3 });
    const producer = await PartitionedProducer.create(client, superStream, publisherRef);
    return new TestProducer(producer, () => client.close());
  }

  async send(envelopes: Envelope[]): Promise<void> {
    await this.producer.sendAll(
      envelopes.map((e) => ({
        partitionKey: e.partitionKey,
        publishingId: this.nextId++,
        messageId: e.eventId,
        body: Buffer.from(JSON.stringify(e)),
      })),
    );
  }

  async sendRaw(partitionKey: string, body: string): Promise<void> {
    await this.producer.sendAll([
      { partitionKey, publishingId: this.nextId++, messageId: newId(), body: Buffer.from(body) },
    ]);
  }
}

export function envelope(
  eventType: string,
  partitionKey: string,
  payload: Record<string, unknown>,
  overrides: Partial<Envelope> = {},
): Envelope {
  return {
    eventId: newId(),
    eventType,
    eventVersion: 1,
    source: 'test-producer',
    environment: 'prod',
    occurredAt: '2026-10-16T13:00:00.000Z',
    partitionKey,
    correlationId: newId(),
    actor,
    auditable: false,
    payload,
    ...overrides,
  };
}
