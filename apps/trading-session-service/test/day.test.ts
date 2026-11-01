// Tarefa 21.1: um dia completo com o relógio virtual, com Postgres real (RN-SES-001/002).
import { uuidv7 } from '@broker/ids';
import { testClock } from '@broker/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  bearer,
  brt,
  DAY,
  inst,
  instrument,
  market,
  outbox,
  reset,
  routine,
  startEnv,
  stopEnv,
  type Env,
} from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
}, 180_000);
afterAll(() => stopEnv(env));
beforeEach(() => reset(env.db));

describe('grade horária (Pregão §4.1, §8)', () => {
  it('RN-SES-002 / dia completo: fases, eventos, comandos ao Motor e rotinas confirmadas', async () => {
    const a = await app(env);
    const petr = await instrument(a, 'PETR4');
    const vale = await instrument(a, 'VALE3');

    const steps: [string, string, string][] = [
      ['pre_trading', '09:00', 'PRE_TRADING'],
      ['pre_opening', '09:45', 'PRE_OPENING'],
      ['continuous', '10:00', 'CONTINUOUS'],
      ['closing_call', '16:55', 'CLOSING_CALL'],
      ['post_close', '17:00', 'POST_CLOSE'],
      ['session_close', '17:30', 'CLOSED'],
    ];
    await routine(a, 'calendar_check', brt(DAY, '07:00'));
    for (const [name, hhmm, phase] of steps) {
      await routine(a, name, brt(DAY, hhmm));
      expect((await market(a)).phase).toBe(phase);
    }

    const phases = await outbox(env.db, 'session.phase_changed');
    expect(phases.map((e) => [e.payload['from'], e.payload['to'], e.partition_key])).toEqual([
      ['CLOSED', 'PRE_TRADING', 'MARKET'],
      ['PRE_TRADING', 'PRE_OPENING', 'MARKET'],
      ['PRE_OPENING', 'CONTINUOUS', 'MARKET'],
      ['CONTINUOUS', 'CLOSING_CALL', 'MARKET'],
      ['CLOSING_CALL', 'POST_CLOSE', 'MARKET'],
      ['POST_CLOSE', 'CLOSED', 'MARKET'],
    ]);
    const closingCall = phases[3]!.payload;
    expect(closingCall).toMatchObject({
      scope: 'MARKET',
      reason: 'SCHEDULE',
      effectiveAt: brt(DAY, '16:55').toString(),
      expectedEndAt: brt(DAY, '17:00').toString(),
    });
    // CLOSED termina na abertura do próximo dia útil.
    expect(phases[5]!.payload['expectedEndAt']).toBe(brt('2026-03-04', '09:00').toString());

    // O Motor recebe a fase de cada instrumento, com a chave dele.
    const commands = await outbox(env.db, 'engine.phase_change');
    for (const id of [petr, vale]) {
      const mine = commands.filter((c) => c.partition_key === id);
      expect(mine.map((c) => c.payload['phase'])).toEqual(steps.map(([, , phase]) => phase));
    }
    // Abertura e call levam leilão com id, tipo, fim previsto e semente; a saída manda concluir.
    const mine = commands.filter((c) => c.partition_key === petr).map((c) => c.payload);
    expect(mine[1]).toMatchObject({
      auctionType: 'OPENING',
      auctionEndAt: brt(DAY, '10:00').toString(),
      randomSeed: expect.any(String),
    });
    expect(mine[2]!['concludesAuctionId']).toBe(mine[1]!['auctionId']);
    expect(mine[3]).toMatchObject({ auctionType: 'CLOSING' });
    expect(mine[4]!['concludesAuctionId']).toBe(mine[3]!['auctionId']);

    expect((await outbox(env.db, 'session.trading_day_opened')).map((e) => e.payload)).toEqual([
      { businessDate: DAY },
    ]);
    expect((await outbox(env.db, 'session.trading_day_closed')).map((e) => e.payload)).toEqual([
      { businessDate: DAY },
    ]);
    const done = await outbox(env.db, 'routine.completed');
    expect(done.map((e) => e.payload['routineName'])).toEqual([
      'calendar_check',
      ...steps.map(([name]) => name),
    ]);
    const { rows } = await sql<{ status: string }>`
      SELECT status FROM trading_day WHERE business_date = ${DAY}`.execute(env.db);
    expect(rows).toEqual([{ status: 'CLOSED' }]);
  });

  it('spec "Abertura do dia": a rotina das 09:45 leva o mercado a PRE_OPENING e o Motor recebe PhaseChange', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    await routine(a, 'pre_opening', brt(DAY, '09:45'));
    expect((await market(a)).phase).toBe('PRE_OPENING');
    const [command] = await outbox(env.db, 'engine.phase_change');
    expect(command).toMatchObject({
      partition_key: id,
      payload: { scope: id, phase: 'PRE_OPENING' },
    });
  });

  it('RN-ROT-001: re-disparo não repete o efeito e confirma com o novo executionId', async () => {
    const a = await app(env);
    await instrument(a, 'PETR4');
    await routine(a, 'pre_trading', brt(DAY, '09:00'), DAY, uuidv7());
    const second = await routine(a, 'pre_trading', null, DAY, uuidv7());
    expect(await outbox(env.db, 'session.phase_changed')).toHaveLength(1);
    expect(await outbox(env.db, 'engine.phase_change')).toHaveLength(1);
    const done = await outbox(env.db, 'routine.completed');
    expect(done).toHaveLength(2);
    expect(done[1]!.payload['executionId']).toBe(second);
  });

  it('rotinas de outros donos são ignoradas', async () => {
    const a = await app(env);
    await routine(a, 'settlement', brt(DAY, '08:00'));
    expect(await outbox(env.db)).toEqual([]);
  });

  it('LATE_OPEN: na Quarta-feira de Cinzas o PRE_OPENING termina no horário especial', async () => {
    const a = await app(env, { clock: testClock({ date: '2026-02-18', time: '06:00' }) });
    await routine(a, 'pre_opening', brt('2026-02-18', '12:45'), '2026-02-18');
    expect((await market(a)).expectedEndAt?.toString()).toBe(brt('2026-02-18', '13:00').toString());
  });

  it('AFTER_MARKET (Q-04): nenhuma rotina leva a ele', async () => {
    const { ROUTINE_PHASES } = await import('../src/domain/phases.js');
    expect(Object.values(ROUTINE_PHASES)).not.toContain('AFTER_MARKET');
  });
});

describe('abertura do dia (Pregão §8)', () => {
  it('spec "Dia sem pregão": 24/12 NO_TRADING não abre dia nenhum', async () => {
    const a = await app(env);
    await routine(a, 'calendar_check', brt('2026-12-24', '07:00'), '2026-12-24');
    expect(await outbox(env.db, 'session.trading_day_opened')).toEqual([]);
    const { rows } = await sql`SELECT 1 FROM trading_day`.execute(env.db);
    expect(rows).toEqual([]);
    const [done] = await outbox(env.db, 'routine.completed');
    expect(done!.payload['stats']).toMatchObject({ opened: false, dayType: 'NO_TRADING' });
  });

  it('RN-INS-040: em dia útil, manda a referência dos túneis e as regras ao Motor', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', '32.50');
    await instrument(a, 'NOVO3', null);
    await routine(a, 'calendar_check', brt(DAY, '07:00'));
    const updates = await outbox(env.db, 'engine.band_update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      partition_key: id,
      payload: {
        instrumentId: id,
        bandReferencePrice: '32.5',
        staticAuctionBandPct: '0.08',
        rejectionBandPct: '0.20',
      },
    });
  });

  it('Ativos §7: a vigência futura só vale quando chega; a sobrescrita vence o global', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    await a.store.transaction((tx) =>
      a.session.onTradingRulesChanged(tx, {
        ruleId: uuidv7(),
        instrumentId: null,
        rules: { staticAuctionBandPct: '0.10' },
        validFrom: brt('2026-03-10', '00:00'),
      }),
    );
    expect(await outbox(env.db, 'engine.band_update')).toEqual([]);
    await a.store.transaction((tx) =>
      a.session.onTradingRulesChanged(tx, {
        ruleId: uuidv7(),
        instrumentId: id,
        rules: { staticAuctionBandPct: '0.05' },
        validFrom: brt('2026-03-01', '00:00'),
      }),
    );
    const updates = await outbox(env.db, 'engine.band_update');
    expect(updates[0]!.payload['staticAuctionBandPct']).toBe('0.05');
    expect(
      (await a.store.transaction((tx) => tx.rulesAt(id, brt('2026-03-11', '10:00'))))
        .staticAuctionBandPct,
    ).toBe('0.05');
  });
});

describe('consulta do estado (Contratos §4)', () => {
  it('spec "Consulta durante leilão": a fase, o auction_id e o fim previsto', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    await routine(a, 'pre_opening', brt(DAY, '09:45'));
    const res = await a.http
      .get('/v1/market/session/PETR4')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(res.body).toMatchObject({
      instrumentId: id,
      phase: 'PRE_OPENING',
      expectedEndAt: brt(DAY, '10:00').toString(),
      auction: { type: 'OPENING', status: 'OPEN', expectedEndAt: brt(DAY, '10:00').toString() },
    });
    expect(res.body.auction.auctionId).toEqual(expect.any(String));
    expect(res.body.nextEvents[0]).toEqual({
      phase: 'CONTINUOUS',
      at: brt(DAY, '10:00').toString(),
    });

    const all = await a.http.get('/v1/market/session').set(bearer(a.tokens.customer)).expect(200);
    expect(all.body.market).toMatchObject({ phase: 'PRE_OPENING', scheduledPhase: 'PRE_OPENING' });
    expect(all.body.instruments).toHaveLength(1);
    expect(all.body.nextEvents.map((e: { phase: string }) => e.phase)).toEqual([
      'CONTINUOUS',
      'CLOSING_CALL',
      'POST_CLOSE',
      'CLOSED',
    ]);

    await a.http.get('/v1/market/session/XXXX3').set(bearer(a.tokens.customer)).expect(404);
    await a.http.get('/v1/market/session').expect(401);
  });

  it('depois do fim do dia, o próximo evento é a abertura do próximo dia útil', async () => {
    const a = await app(env);
    a.clock.advanceTo(brt(DAY, '18:00'));
    const res = await a.http.get('/v1/market/session').set(bearer(a.tokens.customer)).expect(200);
    expect(res.body.nextEvents).toEqual([
      { phase: 'PRE_TRADING', at: brt('2026-03-04', '09:00').toString() },
    ]);
    expect(await inst(a, uuidv7())).toBeNull();
  });
});
