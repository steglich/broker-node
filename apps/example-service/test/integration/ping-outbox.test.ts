// Teste de integração de referência (RN-QA-020/021, D20): banco real em contêiner, migrações do
// serviço, relógio virtual e builders do @broker/testing. Os serviços novos copiam este formato.
import { ExamplePingedV1 } from '@broker/contracts/events/example.pinged/v1';
import { uuidv7 } from '@broker/ids';
import { EventPublisher } from '@broker/messaging';
import { createDatabase, inTransaction, migrateToLatest } from '@broker/persistence';
import { anActor, testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../src/migrations.js';

describe('example-service: ping e outbox na mesma transação (ADR-0008)', () => {
  let pg: StartedPostgres;
  let db: Kysely<unknown>;
  const clock = testClock({ date: '2026-02-18', time: '13:00' });
  const publisher = new EventPublisher({
    source: 'example-service',
    environment: 'test',
    clock,
    newId: uuidv7,
  });

  beforeAll(async () => {
    pg = await startPostgres(['example']);
    const migrator = createDatabase(databaseConfig(pg, 'example', 'migrator'));
    await migrateToLatest(migrator, migrations);
    await migrator.destroy();
    db = createDatabase(databaseConfig(pg, 'example', 'app'));
  });
  afterAll(async () => {
    await db?.destroy();
    await pg?.container.stop();
  });

  async function createPing(fail = false): Promise<string> {
    const pingId = uuidv7();
    await inTransaction(db, async (trx) => {
      await sql`INSERT INTO ping (id, created_at) VALUES (${pingId}, ${clock.now().toString()})`.execute(
        trx,
      );
      await publisher.publish(
        trx,
        ExamplePingedV1,
        { pingId },
        {
          partitionKey: pingId,
          aggregateType: 'ping',
          aggregateId: pingId,
          actor: anActor(),
        },
      );
      if (fail) throw new Error('falha depois de publicar');
    });
    return pingId;
  }

  it('RN-CLK-004: o evento vai para a outbox com o occurred_at do relógio virtual', async () => {
    const pingId = await createPing();
    const { rows } = await sql<{ event_type: string; payload: unknown; occurred_at: Date }>`
      SELECT event_type, payload, occurred_at FROM outbox_event WHERE aggregate_id = ${pingId}`.execute(
      db,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('example.pinged');
    expect(rows[0]!.payload).toEqual({ pingId });
    expect(rows[0]!.occurred_at.toISOString()).toBe('2026-02-18T16:00:00.000Z');
  });

  it('ADR-0008: rollback do caso de uso descarta o ping e o evento juntos', async () => {
    clock.advanceBy(1_000);
    await expect(createPing(true)).rejects.toThrow('falha depois de publicar');
    const { rows } = await sql<{ n: bigint }>`
      SELECT count(*) AS n FROM outbox_event WHERE occurred_at = ${clock.now().toString()}`.execute(
      db,
    );
    expect(rows[0]!.n).toBe(0n);
  });
});
