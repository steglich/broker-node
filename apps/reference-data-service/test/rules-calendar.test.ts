// 16.4: regras de negociação com vigência, calendário, grade horária, alerta de 60 dias e sandbox.
import { TradingCalendar, type CalendarData } from '@broker/calendar';
import { BusinessDate } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { testClock } from '@broker/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  app,
  approve,
  bearer,
  idOf,
  outbox,
  startEnv,
  stopEnv,
  syncCatalog,
  type App,
  type Env,
} from './helpers.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
  // Segunda, 05/01/2026, 10:00 BRT.
  a = await app(env, { clock: testClock('2026-01-05T13:00:00Z') });
  await syncCatalog(a, [{ symbol: 'PETR4' }]);
}, 180_000);
afterAll(() => stopEnv(env));

const propose = (body: object, token = a.tokens.market) =>
  a.http
    .post('/v1/bo/trading-rules/requests')
    .set(bearer(token))
    .set('Idempotency-Key', uuidv7())
    .send(body);
const effective = async (query: string) =>
  (
    await a.http
      .get(`/v1/trading-rules/effective${query}`)
      .set(bearer(a.tokens.customer))
      .expect(200)
  ).body;

describe('regras de negociação com vigência (Ativos §7)', () => {
  it('o padrão global semeado vale desde o início: túneis 20/8/3%, limites por ordem', async () => {
    const e = await effective('');
    expect(e.values).toEqual({
      rejectionBandPct: '0.20',
      staticAuctionBandPct: '0.08',
      dynamicAuctionBandPct: '0.03',
      volatilityAuctionDurationS: 300,
      volatilityAuctionExtensionS: 120,
      auctionRandomEndMaxS: 30,
      maxOrderQuantity: 1000000,
      maxOrderNotional: '5000000.00',
      marketProtectionPct: '0.02',
      smmSpreadBps: 10,
    });
    expect(e.overrideRuleId).toBeNull();
  });

  it('Nova vigência: túnel aprovado a partir de amanhã; hoje vale o anterior e amanhã o novo', async () => {
    const tomorrow = BusinessDate.parse('2026-01-06').atLocalTime('00:00').toString();
    const global = (await effective('')).values;
    const req = await propose({
      instrumentId: null,
      rules: { ...global, rejectionBandPct: '0.15' },
      validFrom: tomorrow,
      justification: 'túnel mais estreito',
    }).expect(201);
    // A matriz exige outro usuário como checker (BO_MARKET ou BO_ADMIN).
    await approve(a, req.body.id, a.tokens.market).expect(422);
    await approve(a, req.body.id, a.tokens.market2).expect(200);

    expect((await effective('')).values.rejectionBandPct).toBe('0.20');
    expect(
      (await effective(`?at=${encodeURIComponent('2026-01-06T13:00:00Z')}`)).values
        .rejectionBandPct,
    ).toBe('0.15');
    const [event] = await outbox(env.db, 'instrument.trading_rules_changed');
    expect(event!.payload).toMatchObject({
      instrumentId: null,
      validFrom: tomorrow,
      approvalRequestId: req.body.id,
    });
    expect(event!.partition_key).toBe('global');

    const versions = (
      await a.http.get('/v1/bo/trading-rules').set(bearer(a.tokens.market)).expect(200)
    ).body.items;
    expect(
      versions.map((v: { validFrom: string; validTo: string | null }) => [v.validFrom, v.validTo]),
    ).toEqual([
      [tomorrow, null],
      ['2026-01-01T00:00:00.000Z', tomorrow],
    ]);
  });

  it('sobrescrita por instrumento só nos campos dela; o resto segue o global', async () => {
    const id = await idOf(a, 'PETR4');
    const req = await propose({
      instrumentId: id,
      rules: { maxOrderQuantity: 200000 },
      validFrom: a.clock.now().toString(),
      justification: 'limite menor',
    }).expect(201);
    await approve(a, req.body.id, a.tokens.admin).expect(200);
    const e = await effective(`?instrumentId=${id}`);
    expect(e.values).toMatchObject({ maxOrderQuantity: 200000, rejectionBandPct: '0.20' });
    expect(e.overridden).toEqual(['maxOrderQuantity']);
  });

  it('recusa proposta incoerente, no passado ou sobreposta', async () => {
    const id = await idOf(a, 'PETR4');
    const bad = await propose({
      instrumentId: id,
      rules: { staticAuctionBandPct: '0.25' },
      validFrom: a.clock.now().toString(),
      justification: 'x'.repeat(5),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('INVALID_TRADING_RULES');
    const past = await propose({
      instrumentId: id,
      rules: { maxOrderQuantity: 1 },
      validFrom: '2026-01-01T00:00:00Z',
      justification: 'passado',
    });
    expect(past.body.code).toBe('VALID_FROM_IN_PAST');
    const partialGlobal = await propose({
      instrumentId: null,
      rules: { maxOrderQuantity: 1 },
      validFrom: '2026-02-01T03:00:00Z',
      justification: 'global',
    });
    expect(partialGlobal.body.code).toBe('INVALID_TRADING_RULES');
  });
});

describe('calendário e grade horária (RN-CAL-001..003)', () => {
  it('funções de calendário pela API (RN-CAL-002)', async () => {
    const carnaval = await a.http
      .get('/v1/calendar/days/2026-02-16')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(carnaval.body).toMatchObject({
      dayType: 'HOLIDAY',
      businessDay: false,
      nextBusinessDay: '2026-02-18',
      sessionSchedule: null,
    });
    const next = await a.http
      .get('/v1/calendar/days/2026-02-13/next?n=2')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(next.body.result).toBe('2026-02-19');
    const prev = await a.http
      .get('/v1/calendar/days/2026-02-18/next?n=-1')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(prev.body.result).toBe('2026-02-13');
    const between = await a.http
      .get('/v1/calendar/business-days-between?from=2026-02-13&to=2026-02-20')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(between.body.businessDays).toBe(3);
    const outside = await a.http
      .get('/v1/calendar/days/2028-01-03')
      .set(bearer(a.tokens.customer))
      .expect(422);
    expect(outside.body.code).toBe('CALENDAR_NOT_LOADED');
  });

  it('dia especial aprovado publica calendar.updated com o calendário completo para a cópia local', async () => {
    const req = await a.http
      .post('/v1/bo/calendar/requests')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({
        days: [{ date: '2026-03-20', type: 'NO_TRADING', description: 'Pregão suspenso (teste)' }],
        justification: 'comunicado B3',
      })
      .expect(201);
    await approve(a, req.body.id, a.tokens.admin).expect(200);
    const day = await a.http
      .get('/v1/calendar/days/2026-03-20')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(day.body).toMatchObject({ dayType: 'NO_TRADING', businessDay: false });
    const [event] = await outbox(env.db, 'calendar.updated');
    expect(event!.partition_key).toBe('calendar');
    expect(event!.payload).toMatchObject({ from: '2026-03-20', to: '2026-03-20' });
    const copy = new TradingCalendar(event!.payload['calendar'] as CalendarData);
    expect(copy.isBusinessDay(BusinessDate.parse('2026-03-20'))).toBe(false);
    expect(copy.nextBusinessDay(BusinessDate.parse('2026-03-19')).toString()).toBe('2026-03-23');
  });

  it('RN-CAL-003: nova grade com vigência futura; hoje continua a anterior', async () => {
    const req = await a.http
      .post('/v1/bo/session-schedules/requests')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({
        name: 'Horário de verão dos EUA',
        dayType: 'BUSINESS_DAY',
        validFrom: '2026-03-09',
        phases: [
          { phase: 'PRE_TRADING', start: '09:00' },
          { phase: 'PRE_OPENING', start: '09:45' },
          { phase: 'CONTINUOUS', start: '10:00' },
          { phase: 'CLOSING_CALL', start: '17:55' },
          { phase: 'POST_CLOSE', start: '18:00' },
          { phase: 'CLOSED', start: '18:30' },
        ],
        justification: 'ajuste anual',
      })
      .expect(201);
    await approve(a, req.body.id, a.tokens.market2).expect(200);
    const before = await a.http
      .get('/v1/calendar/days/2026-03-06')
      .set(bearer(a.tokens.customer))
      .expect(200);
    const after = await a.http
      .get('/v1/calendar/days/2026-03-09')
      .set(bearer(a.tokens.customer))
      .expect(200);
    const closing = (b: { sessionSchedule: { phases: { phase: string; startsAt: string }[] } }) =>
      b.sessionSchedule.phases.find((p) => p.phase === 'CLOSING_CALL')!.startsAt;
    expect(closing(before.body)).toBe('2026-03-06T19:55:00.000Z');
    expect(closing(after.body)).toBe('2026-03-09T20:55:00.000Z');
    const [event] = await outbox(env.db, 'session_schedule.updated');
    expect(event!.payload).toMatchObject({ from: '2026-03-09', to: null });
  });

  it('RN-MC-BO-003: proposta de calendário feita antes de outra mudança aprovada fica STALE', async () => {
    const send = (date: string) =>
      a.http
        .post('/v1/bo/calendar/requests')
        .set(bearer(a.tokens.market))
        .set('Idempotency-Key', uuidv7())
        .send({
          days: [{ date, type: 'HOLIDAY', description: 'Feriado (teste)' }],
          justification: 'teste',
        });
    const first = await send('2026-04-22').expect(201);
    // Outra proposta não pode ficar pendente junto (um alvo: o calendário).
    expect((await send('2026-04-23')).body.code).toBe('REQUEST_ALREADY_PENDING');
    await approve(a, first.body.id, a.tokens.admin).expect(200);
    const second = await send('2026-04-23').expect(201);
    const schedule = await a.http
      .post('/v1/bo/calendar/requests')
      .set(bearer(a.tokens.market2))
      .set('Idempotency-Key', uuidv7())
      .send({ extendTo: '2028-01-31', justification: 'teste' });
    expect(schedule.body.code).toBe('REQUEST_ALREADY_PENDING');
    await a.http
      .post(`/v1/bo/change-requests/${second.body.id}/cancel`)
      .set(bearer(a.tokens.market))
      .expect(200);
  });

  it('Calendário acabando: faltando 60 dias para o último dia carregado, o backoffice recebe alerta (uma vez)', async () => {
    a.clock.advanceTo(BusinessDate.parse('2027-10-31').atLocalTime('06:30'));
    expect((await a.daily()).alerted).toBe(false);
    a.clock.advanceTo(BusinessDate.parse('2027-11-01').atLocalTime('06:30'));
    const stats = await a.daily();
    expect(stats).toMatchObject({ coverageEnd: '2027-12-31', daysLeft: 60, alerted: true });
    expect((await a.daily()).alerted).toBe(false);
    expect(a.alerts.filter((x) => x.kind === 'CALENDAR_COVERAGE_ENDING')).toEqual([
      expect.objectContaining({ data: { coverageEnd: '2027-12-31', daysLeft: 60 } }),
    ]);
    const tasks = await a.http
      .get('/v1/bo/tasks?status=OPEN')
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(tasks.body.items.map((t: { kind: string }) => t.kind)).toContain(
      'CALENDAR_COVERAGE_ENDING',
    );

    // Carregar o próximo ano (extensão aprovada) e o alerta não volta para o mesmo período.
    const req = await a.http
      .post('/v1/bo/calendar/requests')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({
        extendTo: '2028-12-31',
        days: [{ date: '2028-01-03', type: 'HOLIDAY', description: 'Teste' }],
        justification: 'calendário 2028',
      })
      .expect(201);
    await approve(a, req.body.id, a.tokens.admin).expect(200);
    const after = await a.daily();
    expect(after).toMatchObject({ coverageEnd: '2028-12-31', alerted: false });
    const day = await a.http
      .get('/v1/calendar/days/2028-01-03')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(day.body).toMatchObject({ dayType: 'HOLIDAY', businessDay: false });
  });
});

describe('sandbox (RN-SBX-002)', () => {
  it('Sábado no sandbox: is_business_day é verdadeiro, com a grade de dia útil', async () => {
    const sandbox = await app(env, {
      clock: testClock('2026-01-05T13:00:00Z'),
      allDaysBusiness: true,
    });
    const sat = await sandbox.http
      .get('/v1/calendar/days/2026-01-10')
      .set(bearer(sandbox.tokens.customer))
      .expect(200);
    expect(sat.body).toMatchObject({
      dayType: 'BUSINESS_DAY',
      businessDay: true,
      nextBusinessDay: '2026-01-11',
    });
    expect(sat.body.sessionSchedule.phases.map((p: { phase: string }) => p.phase)).toContain(
      'CONTINUOUS',
    );
    const holiday = await sandbox.http
      .get('/v1/calendar/days/2026-02-16')
      .set(bearer(sandbox.tokens.customer))
      .expect(200);
    expect(holiday.body.businessDay).toBe(true);
    const data = (
      await sandbox.http.get('/v1/calendar').set(bearer(sandbox.tokens.customer)).expect(200)
    ).body;
    expect(data.allDaysBusiness).toBe(true);
    // Fora do sandbox, o mesmo sábado não é útil.
    const prod = await a.http
      .get('/v1/calendar/days/2026-01-10')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(prod.body.businessDay).toBe(false);
  });
});
