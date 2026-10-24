// Tarefas 11.1 e 11.2: disparo pela tabela de rotinas e pelo calendário, idempotência,
// dependências e catch-up, com Postgres real e relógio virtual.
import { BusinessDate } from '@broker/domain-kernel';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, brt, completeAll, reset, startDb, triggered, type Env } from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await startDb();
});
afterAll(async () => {
  await env?.db.destroy();
  await env?.pg.container.stop();
});
beforeEach(() => reset(env.db));

const key = (t: { routineName: string; businessDate: string }) =>
  `${t.routineName}@${t.businessDate}`;

describe('disparo pela tabela de rotinas e pelo calendário (11.1, RN-ROT-001)', () => {
  it('spec "Feriado": no Carnaval nenhuma rotina de pregão ou liquidação dispara', async () => {
    const a = await app(env, { clock: { mode: 'VIRTUAL', start: brt('2026-02-16', '06:00') } });
    for (const hhmm of ['08:00', '12:00', '23:59']) {
      a.clock.advanceTo(brt('2026-02-16', hhmm));
      expect(await a.scheduler.step()).toEqual([]);
    }
    a.clock.advanceTo(brt('2026-02-17', '23:59')); // terça de Carnaval
    expect(await a.scheduler.step()).toEqual([]);
    expect(await triggered(env.db)).toEqual([]);
  });

  it('dispara o que venceu, com routine.triggered na outbox e a execução gravada', async () => {
    const a = await app(env);
    a.clock.advanceTo(brt('2026-03-03', '08:40'));
    const fired = await a.scheduler.step();
    expect(fired.map((f) => f.routineName)).toEqual([
      'calendar_check',
      'settlement',
      'corporate_actions_ex_date',
    ]);
    const events = await triggered(env.db);
    expect(events.map(key)).toEqual([
      'calendar_check@2026-03-03',
      'settlement@2026-03-03',
      'corporate_actions_ex_date@2026-03-03',
    ]);
    expect(events[1]).toMatchObject({
      executionId: fired[1]!.executionId,
      attempt: 1,
      catchUp: false,
    });
  });

  it('spec "Disparo duplicado": repetir o passo, ou dois agendadores ao mesmo tempo, não duplica', async () => {
    const a = await app(env);
    const b = await app(env);
    a.clock.advanceTo(brt('2026-03-03', '08:40'));
    b.clock.advanceTo(brt('2026-03-03', '08:40'));
    // Os dois "líderes" decidem juntos (o caso do failover em que o antigo ainda não percebeu).
    const [fa, fb] = await Promise.all([a.scheduler.step(), b.scheduler.step()]);
    expect(fa.length + fb.length).toBe(3);
    expect(await a.scheduler.step()).toEqual([]);
    const events = await triggered(env.db);
    expect(events.map(key).sort()).toEqual([
      'calendar_check@2026-03-03',
      'corporate_actions_ex_date@2026-03-03',
      'settlement@2026-03-03',
    ]);
    const { rows } = await sql<{ n: bigint }>`SELECT count(*) AS n FROM routine_execution`.execute(
      env.db,
    );
    expect(rows[0]!.n).toBe(3n);
  });
});

describe('dependências e catch-up (11.2, RN-ROT-002/003)', () => {
  it('spec "Notas antes do fechamento": as notas esperam e saem logo após o routine.completed do fechamento', async () => {
    const a = await app(env);
    // O dia corre até as 17:12 com todos os donos respondendo, menos o do fechamento.
    for (const hhmm of ['07:00', '09:00', '09:45', '10:00', '16:25', '16:55']) {
      a.clock.advanceTo(brt('2026-03-03', hhmm));
      await a.scheduler.step();
      await completeAll(a.scheduler, env.db);
    }
    a.clock.advanceTo(brt('2026-03-03', '17:12'));
    await a.scheduler.step(); // post_close, que fica sem resposta
    const names = async () => (await triggered(env.db)).map((t) => t.routineName);
    expect(await names()).toContain('post_close');
    expect(await names()).not.toContain('brokerage_notes');

    const postClose = (await triggered(env.db)).find((t) => t.routineName === 'post_close')!;
    await a.scheduler.finish({ ...postClose, status: 'COMPLETED' });
    await a.scheduler.step(); // eod_orders (depende só do fechamento)
    await completeAll(a.scheduler, env.db);
    const fired = await a.scheduler.step();
    expect(fired.map((f) => f.routineName)).toContain('brokerage_notes');
  });

  it('spec "Sistema fora por um dia": as rotinas de D saem em ordem antes das de D+1, inclusive o fim das ordens DAY', async () => {
    // O agendador estava parado desde a véspera; volta no dia 04/03 às 08:30.
    const a = await app(env, {
      clock: { mode: 'VIRTUAL', start: brt('2026-03-04', '08:30') },
      startDate: BusinessDate.parse('2026-03-03'),
    });
    // Os donos respondem a cada passo, como fariam no ar.
    for (let i = 0; i < 30; i++) {
      const fired = await a.scheduler.step();
      const done = await completeAll(a.scheduler, env.db);
      if (fired.length === 0 && done === 0) break;
    }
    const events = await triggered(env.db);
    const firstNextDay = events.findIndex((e) => e.businessDate === '2026-03-04');
    const lastPreviousDay = events.map((e) => e.businessDate).lastIndexOf('2026-03-03');
    expect(lastPreviousDay).toBeLessThan(firstNextDay);
    // D inteiro, em atraso; D+1 só até o que venceu às 08:30.
    expect(events.filter((e) => e.businessDate === '2026-03-03')).toHaveLength(18);
    expect(events.filter((e) => e.businessDate === '2026-03-03').every((e) => e.catchUp)).toBe(
      true,
    );
    expect(events.map(key)).toContain('eod_orders@2026-03-03');
    expect(events.filter((e) => e.businessDate === '2026-03-04').map((e) => e.routineName)).toEqual(
      ['calendar_check', 'settlement', 'corporate_actions_ex_date'],
    );
  });

  it('falha: a dependente espera; o novo disparo tem executionId novo e a resposta antiga é ignorada', async () => {
    const a = await app(env);
    a.clock.advanceTo(brt('2026-03-03', '09:05'));
    await a.scheduler.step();
    const check = (await triggered(env.db)).find((t) => t.routineName === 'calendar_check')!;
    await a.scheduler.finish({ ...check, status: 'FAILED', reason: 'calendário não carregado' });
    expect((await a.scheduler.step()).map((f) => f.routineName)).not.toContain('pre_trading');

    const retried = await a.scheduler.retry('calendar_check', '2026-03-03');
    expect(retried).toMatchObject({ status: 'TRIGGERED', attempt: 2 });
    expect(retried.executionId).not.toBe(check.executionId);
    expect(await a.scheduler.finish({ ...check, status: 'COMPLETED' })).toBe('STALE');
    expect(
      await a.scheduler.finish({ ...check, executionId: retried.executionId, status: 'COMPLETED' }),
    ).toBe('UPDATED');
    expect((await a.scheduler.step()).map((f) => f.routineName)).toEqual(['pre_trading']);
    await expect(a.scheduler.retry('calendar_check', '2026-03-03')).rejects.toThrow(
      'não está FAILED',
    );
  });
});
