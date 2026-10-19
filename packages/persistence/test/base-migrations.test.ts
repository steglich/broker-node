import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseMigrations, createDatabase, makeAppendOnly, migrateToLatest } from '../src/index.js';
import { configFor } from './helpers.js';

const migrations: Record<string, Migration> = {
  ...baseMigrations,
  '0001_ledger_entry': {
    async up(db: Kysely<unknown>) {
      await sql`CREATE TABLE ledger_entry (id uuid PRIMARY KEY, amount numeric(20, 2) NOT NULL)`.execute(
        db,
      );
      await makeAppendOnly(db, 'ledger_entry');
    },
  },
};

let migrator: Kysely<unknown>;
let app: Kysely<unknown>;

beforeAll(async () => {
  migrator = createDatabase(configFor('appendonly', 'migrator'));
  app = createDatabase(configFor('appendonly', 'app'));
  await migrateToLatest(migrator, migrations);
});

afterAll(async () => {
  await Promise.all([migrator.destroy(), app.destroy()]);
});

describe('tabelas técnicas obrigatórias (RN-DB §4)', () => {
  it('RN-DB §4: as migrações-base criam as tabelas técnicas', async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`.execute(app);
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        'blocked_key',
        'consumer_offset',
        'dead_letter',
        'idempotency_record',
        'outbox_event',
        'parked_message',
        'processed_event',
        'saga_instance',
        'schema_migration',
      ]),
    );
  });

  it('ADR-0008: a aplicação grava e marca a outbox; o índice de pendentes segue a ordem de inserção', async () => {
    for (const n of [1, 2, 3]) {
      await sql`
        INSERT INTO outbox_event (id, aggregate_type, aggregate_id, event_type, event_version, partition_key, payload, occurred_at)
        VALUES (${`0192a3c0-0000-7000-8000-00000000000${n}`}, 'account', 'acc-1', 'ledger.entry_posted', 1, 'acc-1',
                ${JSON.stringify({ n })}, '2026-10-16T20:00:00Z')`.execute(app);
    }
    await sql`UPDATE outbox_event SET published_at = now() WHERE payload->>'n' = '1'`.execute(app);
    const pending = await sql<{ n: string }>`
      SELECT payload->>'n' AS n FROM outbox_event WHERE published_at IS NULL ORDER BY seq`.execute(
      app,
    );
    expect(pending.rows.map((r) => r.n)).toEqual(['2', '3']);
  });

  it('RN-MSG-B-030: a inbox impede processar o mesmo evento duas vezes no mesmo consumidor', async () => {
    const insert = (consumer: string) =>
      sql`INSERT INTO processed_event (event_id, consumer) VALUES ('0192a3c0-0000-7000-8000-0000000000aa', ${consumer})`.execute(
        app,
      );
    await insert('ledger.projector');
    await expect(insert('ledger.projector')).rejects.toThrow(/duplicate key/);
    await insert('notification.sender'); // outro consumidor processa o mesmo evento
  });

  it('RN-MSG-B-035: a chave bloqueada referencia a mensagem da DLQ que a bloqueou', async () => {
    await expect(
      sql`INSERT INTO blocked_key (consumer, partition_key, dead_letter_id)
          VALUES ('c', 'acc-1', '0192a3c0-0000-7000-8000-0000000000ff')`.execute(app),
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql`INSERT INTO dead_letter (id, consumer, stream, payload, error, attempts, status)
          VALUES ('0192a3c0-0000-7000-8000-0000000000fe', 'c', 's', '{}', 'erro', 5, 'PERDIDO')`.execute(
        app,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('tabelas append-only (RN-DB §3)', () => {
  beforeAll(async () => {
    await sql`INSERT INTO ledger_entry (id, amount) VALUES ('0192a3c0-0000-7000-8000-000000000001', 10.00)`.execute(
      app,
    );
  });

  it('RN-DB §3: a aplicação insere e lê', async () => {
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM ledger_entry`.execute(app);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('RN-DB §3: UPDATE, DELETE e TRUNCATE pela aplicação falham por permissão', async () => {
    await expect(sql`UPDATE ledger_entry SET amount = 99`.execute(app)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`DELETE FROM ledger_entry`.execute(app)).rejects.toThrow(/permission denied/);
    await expect(sql`TRUNCATE ledger_entry`.execute(app)).rejects.toThrow(/permission denied/);
  });

  it('RN-DB §3: o gatilho recusa UPDATE, DELETE e TRUNCATE até do dono da tabela', async () => {
    await expect(sql`UPDATE ledger_entry SET amount = 99`.execute(migrator)).rejects.toThrow(
      /append-only: UPDATE/,
    );
    await expect(sql`DELETE FROM ledger_entry`.execute(migrator)).rejects.toThrow(
      /append-only: DELETE/,
    );
    await expect(sql`TRUNCATE ledger_entry`.execute(migrator)).rejects.toThrow(
      /append-only: TRUNCATE/,
    );
  });

  it('o gatilho segura mesmo se alguém der GRANT de UPDATE por engano', async () => {
    await sql`GRANT UPDATE ON ledger_entry TO appendonly_app`.execute(migrator);
    try {
      await expect(sql`UPDATE ledger_entry SET amount = 99`.execute(app)).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await sql`REVOKE UPDATE ON ledger_entry FROM appendonly_app`.execute(migrator);
    }
    const { rows } = await sql<{ amount: string }>`SELECT amount::text FROM ledger_entry`.execute(
      app,
    );
    expect(rows[0]!.amount).toBe('10.00');
  });
});
