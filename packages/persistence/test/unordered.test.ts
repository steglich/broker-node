import { sql, type Kysely } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest } from '../src/index.js';
import { configFor } from './helpers.js';

const db = createDatabase(configFor('unordered', 'migrator'));
afterAll(() => db.destroy());

describe('migração-base nova depois das do serviço', () => {
  it('aplica uma 0000_platform_* que chegou depois de uma 0001_* já aplicada', async () => {
    const mk = (table: string) => ({
      up: (d: Kysely<unknown>) =>
        sql`CREATE TABLE ${sql.table(table)} (id int)`.execute(d).then(() => undefined),
    });
    await migrateToLatest(db, { '0001_unordered_service': mk('unordered_service') });
    const later = await migrateToLatest(db, {
      '0000_platform_zz_new': mk('unordered_platform'),
      '0001_unordered_service': mk('unordered_service'),
    });
    expect(later.results?.map((r) => [r.migrationName, r.status])).toEqual([
      ['0000_platform_zz_new', 'Success'],
    ]);
  });
});
