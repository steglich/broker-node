// Tarefa 11.3: clock.ticked nos modos ACCELERATED/VIRTUAL, advance_to e liderança por lease.
import { Instant } from '@broker/domain-kernel';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnvironmentClock } from '../src/application/environment-clock.js';
import { app, brt, reset, startDb, ticks, triggered, waitUntil, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await startDb();
});
afterAll(async () => {
  await env?.db.destroy();
  await env?.pg.container.stop();
});
beforeEach(() => reset(env.db));

describe('relógio ACCELERATED (RN-CLK-002/003)', () => {
  it('publica clock.ticked a cada minuto virtual e grava o tempo', async () => {
    let wall = 1_000_000;
    // 60×: um minuto virtual por segundo real.
    const a = await app(env, {
      clock: {
        mode: 'ACCELERATED',
        start: Instant.parse('2026-03-03T12:00:00Z'),
        speedFactor: 60,
        wall: () => wall,
      },
    });
    // Eleito, o líder já publica o primeiro tick (o minuto atual).
    await a.start();
    await waitUntil(async () => (await ticks(env.db)).length === 1, 5_000, 'primeiro tick');
    wall += 500; // meio minuto virtual: nada novo
    await a.runner.tick();
    wall += 500;
    await a.runner.tick();
    wall += 60_000; // uma hora virtual de uma vez: o tick é o minuto atual, não 60 ticks atrasados
    await a.runner.tick();
    expect((await ticks(env.db)).map((t) => t.virtualNow)).toEqual([
      '2026-03-03T12:00:00.000Z',
      '2026-03-03T12:01:00.000Z',
      '2026-03-03T13:01:00.000Z',
    ]);
    expect((await ticks(env.db))[0]).toMatchObject({ mode: 'ACCELERATED', speedFactor: 60 });
    await a.stop();

    // Reiniciar continua do tempo gravado, e não do CLOCK_START.
    const again = await EnvironmentClock.load(
      a.store,
      { mode: 'ACCELERATED', start: Instant.parse('2026-03-03T12:00:00Z'), speedFactor: 60 },
      () => 0,
    );
    expect(again.now().toString()).toBe('2026-03-03T13:01:00.000Z');
    // RN-CLK-003: um ambiente nunca mistura modos.
    await expect(
      EnvironmentClock.load(a.store, {
        mode: 'VIRTUAL',
        start: Instant.parse('2026-03-03T12:00:00Z'),
      }),
    ).rejects.toThrow('o ambiente está em ACCELERATED');
  });

  it('spec "Relógio acelerado": com 60 minutos reais por dia útil, o pregão inteiro cabe em ~60 minutos', async () => {
    // PRE_TRADING 09:00 → CLOSED 17:30 = 8h30 de pregão; 1 dia útil (24 h) em 60 min reais = 24×.
    let wall = 0;
    const clock = await EnvironmentClock.load(
      {
        transaction: async (fn) => fn({ loadClock: async () => null } as never),
        definitions: async () => [],
        executions: async () => [],
      },
      { mode: 'ACCELERATED', start: brt('2026-03-03', '09:00'), speedFactor: 24 },
      () => wall,
    );
    wall = (8.5 * 3600_000) / 24; // 21,25 minutos reais
    expect(clock.now().toString()).toBe(brt('2026-03-03', '17:30').toString());
  });
});

describe('advance_to no modo VIRTUAL (RN-CLK-002)', () => {
  it('anda parando em cada horário de rotina, com um clock.ticked em cada parada', async () => {
    const a = await app(env);
    await a.start();
    await waitUntil(a.isLeader, 5_000, 'liderança');

    const res = await request(a.service.app)
      .post('/v1/clock/advance')
      .send({ to: brt('2026-03-03', '08:45').toString() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'VIRTUAL',
      now: brt('2026-03-03', '08:45').toString(),
      leader: true,
    });
    expect((await ticks(env.db)).map((t) => t.virtualNow)).toEqual(
      ['06:00', '07:00', '08:00', '08:30', '08:45'].map((h) => brt('2026-03-03', h).toString()),
    );
    expect((await triggered(env.db)).map((t) => t.routineName)).toEqual([
      'calendar_check',
      'settlement',
      'corporate_actions_ex_date',
      'securities_lending_renewal',
    ]);

    // Spec "Relógio virtual parado": sem advance_to, o tempo não muda.
    await new Promise((r) => setTimeout(r, 1_200));
    expect((await request(a.service.app).get('/v1/clock')).body.now).toBe(
      brt('2026-03-03', '08:45').toString(),
    );

    const back = await request(a.service.app)
      .post('/v1/clock/advance')
      .send({ to: brt('2026-03-03', '08:00').toString() });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('CLOCK_CANNOT_GO_BACK');
    await a.stop();
  });

  it('advance_to é recusado fora do VIRTUAL, e as rotas de admin somem sem ADMIN_API_ENABLED', async () => {
    const accelerated = await app(env, {
      clock: { mode: 'ACCELERATED', start: brt('2026-03-03', '06:00'), speedFactor: 10 },
    });
    await accelerated.start();
    await waitUntil(accelerated.isLeader, 5_000, 'liderança');
    const res = await request(accelerated.service.app)
      .post('/v1/clock/advance')
      .send({ to: brt('2026-03-04', '06:00').toString() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLOCK_MODE_NOT_VIRTUAL');
    await accelerated.stop();
    await reset(env.db);

    const readOnly = await app(env, { adminApi: false });
    expect(
      (
        await request(readOnly.service.app)
          .post('/v1/clock/advance')
          .send({ to: brt('2026-03-04', '06:00').toString() })
      ).status,
    ).toBe(404);
    expect((await request(readOnly.service.app).get('/v1/routines')).body.routines).toHaveLength(
      20,
    );
  });
});

describe('liderança por lease (RN-ENV-021)', () => {
  it('spec "Failover do líder": a réplica assume, continua do tempo gravado e nada sai em dobro', async () => {
    const a = await app(env);
    const b = await app(env);
    await a.start();
    await waitUntil(a.isLeader, 5_000, 'A líder');
    await b.start();
    expect(b.isLeader()).toBe(false);
    // A réplica não dispara nem anda o relógio.
    const standby = await request(b.service.app)
      .post('/v1/clock/advance')
      .send({ to: brt('2026-03-03', '09:00').toString() });
    expect(standby.status).toBe(503);
    expect(standby.body.code).toBe('NOT_LEADER');

    expect(
      (
        await request(a.service.app)
          .post('/v1/clock/advance')
          .send({ to: brt('2026-03-03', '08:15').toString() })
      ).status,
    ).toBe(200);

    // O líder "morre": a conexão que segura o lock cai (como num kill -9 do processo).
    const admin = new pg.Client({
      ...env.database,
      user: env.pg.superuser.user,
      password: env.pg.superuser.password,
    });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted`,
    );
    await admin.end();
    // Para o "antigo líder" não voltar a disputar durante o teste.
    await a.stop();

    await waitUntil(b.isLeader, 10_000, 'B assumir');
    const clock = (await request(b.service.app).get('/v1/clock')).body;
    expect(clock).toMatchObject({ leader: true, now: brt('2026-03-03', '08:15').toString() });
    expect(
      (
        await request(b.service.app)
          .post('/v1/clock/advance')
          .send({ to: brt('2026-03-03', '08:50').toString() })
      ).status,
    ).toBe(200);

    const events = await triggered(env.db);
    const keys = events.map((e) => `${e.routineName}@${e.businessDate}`);
    expect(keys).toEqual([
      'calendar_check@2026-03-03',
      'settlement@2026-03-03',
      'corporate_actions_ex_date@2026-03-03',
      'securities_lending_renewal@2026-03-03',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    // B continuou de 08:15: o primeiro tick dele é 08:30 (a próxima rotina), não o início configurado.
    const tickTimes = (await ticks(env.db)).map((t) => t.virtualNow);
    expect(tickTimes.indexOf(brt('2026-03-03', '06:00').toString())).toBe(
      tickTimes.lastIndexOf(brt('2026-03-03', '06:00').toString()),
    );
    expect(tickTimes.slice(-3)).toEqual(
      ['08:30', '08:45', '08:50'].map((h) => brt('2026-03-03', h).toString()),
    );
    await b.stop();
  });
});
