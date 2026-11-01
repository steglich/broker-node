import { TickedClock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baseMigrations,
  createDatabase,
  EnvironmentClockReplica,
  inTransaction,
  migrateToLatest,
} from '../src/index.js';
import { configFor } from './helpers.js';

let migrator: Kysely<unknown>;
let app: Kysely<unknown>;

beforeAll(async () => {
  migrator = createDatabase(configFor('clock', 'migrator'));
  app = createDatabase(configFor('clock', 'app'));
  await migrateToLatest(migrator, baseMigrations);
});

afterAll(async () => {
  await Promise.all([migrator.destroy(), app.destroy()]);
});

const START = '2026-10-27T00:00:00.000Z';
const clockAt = (iso: string) => new TickedClock('VIRTUAL', Instant.parse(iso));

describe('relógio do ambiente restaurado na subida (RN-CLK-003)', () => {
  it('um serviço reiniciado volta ao último instante aplicado, sem esperar o próximo tick', async () => {
    const before = clockAt(START);
    const replica = new EnvironmentClockReplica(app, before);
    expect(await replica.restore()).toBe(false);

    await inTransaction(app, (trx) =>
      replica.apply(trx, { virtualNow: '2026-10-28T18:00:00.000Z' }),
    );
    expect(before.now().toString()).toBe('2026-10-28T18:00:00.000Z');
    // Tick atrasado (redelivery): nem o relógio nem o gravado voltam.
    await inTransaction(app, (trx) =>
      replica.apply(trx, { virtualNow: '2026-10-28T09:00:00.000Z' }),
    );

    // "Reinício": relógio novo no CLOCK_START, restaurado do banco.
    const after = clockAt(START);
    expect(await new EnvironmentClockReplica(app, after).restore()).toBe(true);
    expect(after.now().toString()).toBe('2026-10-28T18:00:00.000Z');
  });

  it('o tick numa transação desfeita não fica gravado', async () => {
    const clock = clockAt(START);
    const replica = new EnvironmentClockReplica(app, clock);
    await expect(
      inTransaction(app, async (trx) => {
        await replica.apply(trx, { virtualNow: '2026-12-01T12:00:00.000Z' });
        throw new Error('falha no consumidor');
      }),
    ).rejects.toThrow('falha no consumidor');

    const restarted = clockAt(START);
    await new EnvironmentClockReplica(app, restarted).restore();
    expect(restarted.now().toString()).toBe('2026-10-28T18:00:00.000Z');
  });
});
