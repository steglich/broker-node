import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { hosts, secret } from './env.js';

const clients: pg.Client[] = [];

async function connectAs(user: string, database: string): Promise<pg.Client> {
  const client = new pg.Client({
    host: 'localhost',
    port: hosts.postgresPort,
    user,
    database,
    password: secret(`db/${user}`),
  });
  clients.push(client);
  await client.connect();
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.end().catch(() => undefined)));
});

describe('isolamento de dados por serviço', () => {
  it('RN-DB-001: o usuário do OMS conecta no próprio database', async () => {
    const oms = await connectAs('oms_app', 'oms');
    const { rows } = await oms.query<{ db: string }>('SELECT current_database() AS db');
    expect(rows[0]?.db).toBe('oms');
  });

  it('RN-DB-001: o usuário do OMS não conecta no database do ledger', async () => {
    await expect(connectAs('oms_app', 'ledger')).rejects.toThrow(
      /permission denied for database "ledger"/,
    );
    await expect(connectAs('oms_migrator', 'ledger')).rejects.toThrow(
      /permission denied for database "ledger"/,
    );
  });

  it('RN-DB-032: <svc>_app não executa CREATE TABLE', async () => {
    const app = await connectAs('ledger_app', 'ledger');
    await expect(app.query('CREATE TABLE should_fail (id int)')).rejects.toThrow(
      /permission denied for schema public/,
    );
  });

  it('RN-DB-032: só <svc>_migrator altera o esquema, e <svc>_app recebe DML na tabela criada', async () => {
    const migrator = await connectAs('ledger_migrator', 'ledger');
    await migrator.query('DROP TABLE IF EXISTS infra_test_grant');
    await migrator.query('CREATE TABLE infra_test_grant (id int PRIMARY KEY)');
    try {
      const app = await connectAs('ledger_app', 'ledger');
      await app.query('INSERT INTO infra_test_grant VALUES (1)');
      const { rows } = await app.query('SELECT id FROM infra_test_grant');
      expect(rows).toEqual([{ id: 1 }]);
      await expect(app.query('DROP TABLE infra_test_grant')).rejects.toThrow(/must be owner/);
    } finally {
      await migrator.query('DROP TABLE IF EXISTS infra_test_grant');
    }
  });
});
