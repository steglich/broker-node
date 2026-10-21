import { Decimal } from '@broker/domain-kernel';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baseMigrations,
  createDatabase,
  inTransaction,
  MIGRATION_TABLE,
  migrateToLatest,
  runMigrationsFromEnv,
} from '../src/index.js';
import { configFor } from './helpers.js';

interface DB {
  account_balance: { id: string; amount: Decimal; price: Decimal; quantity: bigint };
}

const migrations: Record<string, Migration> = {
  ...baseMigrations,
  '0001_account_balance': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE account_balance (
          id        uuid PRIMARY KEY,
          amount    numeric(20, 2) NOT NULL,
          price     numeric(20, 8) NOT NULL,
          quantity  bigint NOT NULL
        )`.execute(db);
    },
  },
};

let migrator: Kysely<unknown>;
let app: Kysely<DB>;

beforeAll(async () => {
  migrator = createDatabase(configFor('migrations', 'migrator'));
  app = createDatabase<DB>(configFor('migrations', 'app'));
});

afterAll(async () => {
  await Promise.all([migrator.destroy(), app.destroy()]);
});

describe('migrador (RN-DB-020)', () => {
  it('RN-DB-020: aplica as migrações em ordem e uma segunda execução não faz nada', async () => {
    const first = await migrateToLatest(migrator, migrations);
    expect(first.results?.map((r) => [r.migrationName, r.status])).toEqual([
      ['0000_platform_base', 'Success'],
      ['0000_platform_blocked_key_retry', 'Success'],
      ['0001_account_balance', 'Success'],
    ]);
    const second = await migrateToLatest(migrator, migrations);
    expect(second.results).toEqual([]);
    const applied = await sql<{
      name: string;
    }>`SELECT name FROM ${sql.table(MIGRATION_TABLE)} ORDER BY name`.execute(migrator);
    expect(applied.rows.map((r) => r.name)).toEqual([
      '0000_platform_base',
      '0000_platform_blocked_key_retry',
      '0001_account_balance',
    ]);
  });

  it('RN-DB-032: o usuário da aplicação não consegue migrar (sem DDL)', async () => {
    const extra = {
      ...migrations,
      '0002_forbidden': {
        up: (db: Kysely<unknown>) =>
          sql`CREATE TABLE forbidden (id int)`.execute(db).then(() => undefined),
      },
    };
    await expect(migrateToLatest(app as unknown as Kysely<unknown>, extra)).rejects.toThrow(
      /permission denied/,
    );
  });

  it('one-shot: runMigrationsFromEnv lê DB_* e a senha do arquivo de segredo', async () => {
    const cfg = configFor('migrations', 'migrator');
    const dir = mkdtempSync(join(tmpdir(), 'broker-secret-'));
    writeFileSync(join(dir, 'pw'), cfg.password);
    const saved = { ...process.env };
    Object.assign(process.env, {
      DB_HOST: cfg.host,
      DB_PORT: String(cfg.port),
      DB_NAME: cfg.database,
      DB_USER: cfg.user,
      DB_PASSWORD_FILE: join(dir, 'pw'),
    });
    const lines: string[] = [];
    try {
      expect(await runMigrationsFromEnv(migrations, (l) => lines.push(l))).toBe(0);
      expect(lines).toEqual(['nenhuma migração pendente']);
      process.env['DB_PASSWORD_FILE'] = join(dir, 'missing');
      await expect(runMigrationsFromEnv(migrations, () => undefined)).rejects.toThrow(/ENOENT/);
    } finally {
      process.env = saved;
    }
  });
});

describe('numeric ↔ Decimal e bigint (ADR-0004)', () => {
  it('ADR-0004: grava e lê numeric sem perder precisão e int8 como bigint', async () => {
    const row = {
      id: '0192a3c0-0000-7000-8000-000000000001',
      amount: new Decimal('123456789012345678.12'),
      price: new Decimal('38.51151234'),
      quantity: 2n ** 62n,
    };
    await app.insertInto('account_balance').values(row).execute();
    const read = await app
      .selectFrom('account_balance')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(read.amount).toBeInstanceOf(Decimal);
    expect(read.amount.toFixed(2)).toBe('123456789012345678.12');
    expect(read.price.equals(row.price)).toBe(true);
    expect(read.quantity).toBe(2n ** 62n);
  });

  it('ADR-0004: Decimal em filtro e em atualização vira string decimal exata', async () => {
    const id = '0192a3c0-0000-7000-8000-000000000002';
    await app
      .insertInto('account_balance')
      .values({
        id,
        amount: new Decimal('0.1').plus('0.2'),
        price: new Decimal('1e-8'),
        quantity: 1n,
      })
      .execute();
    const found = await app
      .selectFrom('account_balance')
      .select('price')
      .where('amount', '=', new Decimal('0.30'))
      .executeTakeFirstOrThrow();
    expect(found.price.toFixed(8)).toBe('0.00000001');
  });
});

describe('transações', () => {
  const id = (n: number) => `0192a3c0-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const count = async () =>
    Number(
      (
        await app
          .selectFrom('account_balance')
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

  it('commit grava tudo; erro dentro da transação desfaz tudo (rollback)', async () => {
    const before = await count();
    await inTransaction(app, async (trx) => {
      await trx
        .insertInto('account_balance')
        .values({ id: id(10), amount: new Decimal('1'), price: new Decimal('1'), quantity: 1n })
        .execute();
    });
    expect(await count()).toBe(before + 1);

    await expect(
      inTransaction(app, async (trx) => {
        await trx
          .insertInto('account_balance')
          .values({ id: id(11), amount: new Decimal('1'), price: new Decimal('1'), quantity: 1n })
          .execute();
        await trx
          .insertInto('account_balance')
          .values({ id: id(12), amount: new Decimal('1'), price: new Decimal('1'), quantity: 1n })
          .execute();
        throw new Error('falha de regra no meio do caso de uso');
      }),
    ).rejects.toThrow(/falha de regra/);
    expect(await count()).toBe(before + 1);
  });

  it('repete a transação inteira em falha de serialização (40001) quando pedido', async () => {
    let calls = 0;
    const result = await inTransaction(
      app,
      async () => {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error('could not serialize access'), { code: '40001' });
        return 'ok';
      },
      { isolation: 'serializable', retries: 2 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    await expect(
      inTransaction(
        app,
        async () => {
          throw Object.assign(new Error('unique_violation'), { code: '23505' });
        },
        { retries: 3 },
      ),
    ).rejects.toThrow(/unique_violation/);
  });
});
