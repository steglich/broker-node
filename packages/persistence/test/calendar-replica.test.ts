import { b3Calendar2026To2027, TradingCalendar, type CalendarData } from '@broker/calendar';
import { BusinessDate } from '@broker/domain-kernel';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baseMigrations,
  CalendarReplica,
  calendarReplicaMigrations,
  createDatabase,
  inTransaction,
  migrateToLatest,
} from '../src/index.js';
import { configFor } from './helpers.js';

let migrator: Kysely<unknown>;
let app: Kysely<unknown>;

beforeAll(async () => {
  migrator = createDatabase(configFor('calendar', 'migrator'));
  app = createDatabase(configFor('calendar', 'app'));
  await migrateToLatest(migrator, { ...baseMigrations, ...calendarReplicaMigrations });
});

afterAll(async () => {
  await Promise.all([migrator.destroy(), app.destroy()]);
});

const d = (iso: string) => BusinessDate.parse(iso);
const withDay = (date: string): CalendarData => ({
  ...b3Calendar2026To2027,
  days: [...b3Calendar2026To2027.days, { date, type: 'NO_TRADING', description: 'teste' }],
});

describe('cópia local do calendário (D15)', () => {
  it('aplica na transação, troca a memória e as outras instâncias acompanham por refresh', async () => {
    const consumer = new CalendarReplica(app, new TradingCalendar(b3Calendar2026To2027));
    const other = new CalendarReplica(app, new TradingCalendar(b3Calendar2026To2027));
    expect(await other.refresh()).toBe(false);

    const applied = await inTransaction(app, (trx) =>
      consumer.apply(trx, {
        data: withDay('2026-03-20'),
        eventId: 'e1',
        occurredAt: '2026-01-05T13:00:00Z',
      }),
    );
    expect(applied).toBe(true);
    expect(consumer.calendar.isBusinessDay(d('2026-03-20'))).toBe(false);
    expect(other.calendar.isBusinessDay(d('2026-03-20'))).toBe(true);
    expect(await other.refresh()).toBe(true);
    expect(other.calendar.isBusinessDay(d('2026-03-20'))).toBe(false);
    expect(await other.refresh()).toBe(false);

    // Reinício: a semente dá lugar ao que está gravado.
    const restarted = new CalendarReplica(app, new TradingCalendar(b3Calendar2026To2027));
    await restarted.refresh();
    expect(restarted.calendar.isBusinessDay(d('2026-03-20'))).toBe(false);
  });

  it('ignora evento mais velho que o gravado e recusa dados inválidos sem trocar nada', async () => {
    const replica = new CalendarReplica(app, new TradingCalendar(b3Calendar2026To2027));
    await replica.refresh();
    const old = await inTransaction(app, (trx) =>
      replica.apply(trx, {
        data: withDay('2026-03-23'),
        eventId: 'e0',
        occurredAt: '2026-01-04T13:00:00Z',
      }),
    );
    expect(old).toBe(false);
    expect(replica.calendar.isBusinessDay(d('2026-03-23'))).toBe(true);

    const invalid: CalendarData = {
      ...b3Calendar2026To2027,
      days: [{ date: '2026-03-21', type: 'HOLIDAY', description: 'sábado' }],
    };
    await expect(
      inTransaction(app, (trx) =>
        replica.apply(trx, { data: invalid, eventId: 'e2', occurredAt: '2026-01-06T13:00:00Z' }),
      ),
    ).rejects.toThrow(/fim de semana/);
    expect(replica.calendar.isBusinessDay(d('2026-03-20'))).toBe(false);
  });

  it('se a transação do consumidor desfaz, o refresh volta ao gravado', async () => {
    const replica = new CalendarReplica(app, new TradingCalendar(b3Calendar2026To2027));
    await replica.refresh();
    await expect(
      inTransaction(app, async (trx) => {
        await replica.apply(trx, {
          data: withDay('2026-03-24'),
          eventId: 'e3',
          occurredAt: '2026-01-07T13:00:00Z',
        });
        throw new Error('falha depois de aplicar');
      }),
    ).rejects.toThrow(/falha/);
    expect(replica.calendar.isBusinessDay(d('2026-03-24'))).toBe(false);
    expect(await replica.refresh()).toBe(true);
    expect(replica.calendar.isBusinessDay(d('2026-03-24'))).toBe(true);
  });
});
