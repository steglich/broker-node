// Tarefa 21.3: circuit breaker (RN-CB-*) e preço de fechamento (RN-FCH-*), com Postgres real.
import { Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  bearer,
  brt,
  DAY,
  inst,
  instrument,
  liveAuctions,
  market,
  openDay,
  outbox,
  reset,
  routine,
  startEnv,
  stopEnv,
  type App,
  type Env,
} from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
}, 180_000);
afterAll(() => stopEnv(env));
beforeEach(() => reset(env.db));

/** Leitura do Ibovespa externo; `previousClose` 100.000, então `last` é a queda. */
const ibov = (a: App, last: string, opts: { stale?: boolean; quoteTime?: Instant } = {}) =>
  a.store.transaction((tx) =>
    a.session.onIndexQuote(tx, {
      lastPrice: last,
      previousClose: '100000',
      quoteTime: opts.quoteTime ?? a.clock.now(),
      stale: opts.stale ?? false,
    }),
  );

describe('circuit breaker automático (Pregão §6)', () => {
  it('spec "Nível 1": queda de 10% às 13:00 leva tudo a HALTED por 30 min e retoma por leilão de 15', async () => {
    const a = await app(env);
    const petr = await instrument(a, 'PETR4');
    const vale = await instrument(a, 'VALE3');
    await openDay(a, 'CONTINUOUS');
    a.clock.advanceTo(brt(DAY, '13:00'));

    await ibov(a, '90500'); // 9,5%: não dispara
    expect((await market(a)).phase).toBe('CONTINUOUS');
    await ibov(a, '90000');

    expect(await market(a)).toMatchObject({
      phase: 'HALTED',
      scheduledPhase: 'CONTINUOUS',
      reason: 'CIRCUIT_BREAKER_L1',
    });
    expect((await market(a)).expectedEndAt!.toString()).toBe(brt(DAY, '13:30').toString());
    expect(
      (await outbox(env.db, 'session.circuit_breaker_triggered')).map((e) => e.payload),
    ).toEqual([
      {
        level: 1,
        indexChangePercent: '-0.10000000',
        resumesAt: brt(DAY, '13:30').toString(),
        origin: 'INDEX',
      },
    ]);
    expect((await outbox(env.db, 'session.halt_started')).at(-1)!.payload).toMatchObject({
      scope: 'MARKET',
      reasonCode: 'CIRCUIT_BREAKER_L1',
      resumesAt: brt(DAY, '13:30').toString(),
    });
    for (const id of [petr, vale]) {
      const view = await a.http
        .get(`/v1/market/session/${id === petr ? 'PETR4' : 'VALE3'}`)
        .set(bearer(a.tokens.customer));
      expect(view.body).toMatchObject({ phase: 'HALTED', reason: 'CIRCUIT_BREAKER_L1' });
      const commands = (await outbox(env.db, 'engine.phase_change')).filter(
        (c) => c.partition_key === id,
      );
      expect(commands.at(-1)!.payload).toEqual({ scope: id, phase: 'HALTED' });
    }

    a.clock.advanceTo(brt(DAY, '13:29'));
    await a.session.tick();
    expect((await market(a)).phase).toBe('HALTED');
    a.clock.advanceTo(brt(DAY, '13:30'));
    await a.session.tick();
    // RN-CB-004: retomada por leilão de pré-abertura de 15 minutos.
    expect((await market(a)).phase).toBe('PRE_OPENING');
    expect((await market(a)).expectedEndAt!.toString()).toBe(brt(DAY, '13:45').toString());
    expect((await liveAuctions(a, petr))[0]).toMatchObject({ type: 'REOPENING' });
    a.clock.advanceTo(brt(DAY, '13:45'));
    await a.session.tick();
    expect((await market(a)).phase).toBe('CONTINUOUS');
  });

  it('spec "Última meia hora": a queda de 10% às 16:40 não dispara', async () => {
    const a = await app(env);
    await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    a.clock.advanceTo(brt(DAY, '16:40'));
    await ibov(a, '90000');
    expect((await market(a)).phase).toBe('CONTINUOUS');
    expect(await outbox(env.db, 'session.circuit_breaker_triggered')).toEqual([]);
  });

  it('RN-CB-002 é parametrizável: sem janela, 16:40 dispara', async () => {
    const a = await app(env, {
      params: { marketDataOutageMinutes: 0, circuitBreakerBlackoutMinutes: 0 },
    });
    await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    a.clock.advanceTo(brt(DAY, '16:40'));
    await ibov(a, '90000');
    expect((await market(a)).phase).toBe('HALTED');
  });

  it('RN-CB-001: cada nível uma vez; o seguinte só depois da retomada do anterior', async () => {
    const a = await app(env);
    await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    a.clock.advanceTo(brt(DAY, '11:00'));
    await ibov(a, '89000');
    // Suspenso e na reabertura, nova queda não dispara nada.
    await ibov(a, '84000');
    a.clock.advanceTo(brt(DAY, '11:30'));
    await a.session.tick();
    await ibov(a, '84000');
    expect((await market(a)).phase).toBe('PRE_OPENING');
    a.clock.advanceTo(brt(DAY, '11:45'));
    await a.session.tick();
    expect((await market(a)).phase).toBe('CONTINUOUS');

    // De volta ao contínuo, 12% não repete o nível 1.
    await ibov(a, '88000');
    expect((await market(a)).phase).toBe('CONTINUOUS');
    await ibov(a, '85000');
    expect(await market(a)).toMatchObject({ phase: 'HALTED', reason: 'CIRCUIT_BREAKER_L2' });
    expect((await market(a)).expectedEndAt!.toString()).toBe(brt(DAY, '12:45').toString());

    a.clock.advanceTo(brt(DAY, '12:45'));
    await a.session.tick();
    a.clock.advanceTo(brt(DAY, '13:00'));
    await a.session.tick();
    await ibov(a, '80000');
    // Nível 3: padrão até o fim do pregão.
    expect(await market(a)).toMatchObject({ phase: 'HALTED', reason: 'CIRCUIT_BREAKER_L3' });
    expect(
      (await outbox(env.db, 'session.circuit_breaker_triggered')).at(-1)!.payload,
    ).toMatchObject({
      level: 3,
      resumesAt: brt(DAY, '17:00').toString(),
    });
    a.clock.advanceTo(brt(DAY, '16:00'));
    await a.session.tick();
    expect((await market(a)).phase).toBe('HALTED');
    await routine(a, 'closing_call', brt(DAY, '16:55'));
    expect((await market(a)).phase).toBe('HALTED');
    await routine(a, 'post_close', brt(DAY, '17:00'));
    expect((await market(a)).phase).toBe('POST_CLOSE');
    expect(await a.queries.halts(true, 10)).toEqual([]);
  });

  it('não dispara fora do contínuo, com leitura defasada nem com leitura de outro dia', async () => {
    const a = await app(env);
    await instrument(a, 'PETR4');
    await openDay(a, 'PRE_OPENING');
    await ibov(a, '80000');
    expect((await market(a)).phase).toBe('PRE_OPENING');
    await routine(a, 'continuous', brt(DAY, '10:00'));
    await ibov(a, '80000', { stale: true });
    await ibov(a, '80000', { quoteTime: brt('2026-03-02', '16:00') });
    expect((await market(a)).phase).toBe('CONTINUOUS');
    expect(await outbox(env.db, 'session.circuit_breaker_triggered')).toEqual([]);
    expect((await a.store.transaction((tx) => tx.watch())).indexLast!.toFixed(0)).toBe('80000');
  });
});

describe('circuit breaker manual e no sandbox (RN-CB-003)', () => {
  it('Backoffice §3: dispara com dupla aprovação; fora do contínuo é recusado', async () => {
    const a = await app(env);
    await instrument(a, 'PETR4');
    await routine(a, 'pre_trading', brt(DAY, '09:00'));
    const early = await a.http
      .post('/v1/bo/session/circuit-breaker')
      .set(bearer(a.tokens.market))
      .send({ justification: 'teste' })
      .expect(422);
    expect(early.body.code).toBe('CIRCUIT_BREAKER_NOT_ALLOWED');
    await routine(a, 'pre_opening', brt(DAY, '09:45'));
    await routine(a, 'continuous', brt(DAY, '10:00'));

    a.clock.advanceTo(brt(DAY, '16:40'));
    const proposal = await a.http
      .post('/v1/bo/session/circuit-breaker')
      .set(bearer(a.tokens.market))
      .send({ justification: 'decisão da mesa' })
      .expect(202);
    expect((await market(a)).phase).toBe('CONTINUOUS');
    await a.http
      .post(`/v1/bo/session/change-requests/${proposal.body.id}/approve`)
      .set(bearer(a.tokens.admin))
      .expect(200);
    // A janela da última meia hora é do disparo automático.
    expect(await market(a)).toMatchObject({ phase: 'HALTED', reason: 'CIRCUIT_BREAKER_L1' });
    expect(
      (await outbox(env.db, 'session.circuit_breaker_triggered')).at(-1)!.payload,
    ).toMatchObject({
      origin: 'BACKOFFICE',
      indexChangePercent: null,
    });
    const [halt] = await a.queries.halts(true, 10);
    expect(halt!.approvalRequestId).toBe(proposal.body.id);
  });

  it('RN-SBX-005: comando de teste sem aprovação, só com os comandos de sandbox ligados', async () => {
    const off = await app(env);
    await off.http
      .post('/v1/sandbox/session/circuit-breaker')
      .set(bearer(off.tokens.market))
      .expect(404);

    const a = await app(env, { sandboxCommands: true });
    await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    const res = await a.http
      .post('/v1/sandbox/session/circuit-breaker')
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(res.body).toEqual({ level: 1 });
    expect(
      (await outbox(env.db, 'session.circuit_breaker_triggered')).at(-1)!.payload['origin'],
    ).toBe('SANDBOX');
  });
});

describe('preço de fechamento (Pregão §9)', () => {
  const close = async (a: App) => {
    await routine(a, 'post_close', brt(DAY, '17:00'));
    await routine(a, 'session_close', brt(DAY, '17:30'));
  };
  const trade = (a: App, id: string, price: string, seq: number, auctionId?: string) =>
    a.store.transaction((tx) =>
      a.session.onTradeExecuted(tx, {
        instrumentId: id,
        board: 'MAIN',
        engineSeq: seq,
        price,
        tradingDate: DAY,
        ...(auctionId ? { auctionId } : {}),
      }),
    );
  const closingOf = async (a: App, id: string) =>
    (await a.queries.closingPrices(BusinessDateOf())).find((c) => c.instrumentId === id)!;
  const BusinessDateOf = () => brt(DAY, '12:00').businessDate();

  it('RN-FCH-001: call de fechamento, senão último negócio do contínuo', async () => {
    const a = await app(env);
    const withCall = await instrument(a, 'PETR4', '10.00');
    const withTrade = await instrument(a, 'VALE3', '20.00');
    await openDay(a, 'CLOSING_CALL');
    await trade(a, withCall, '10.40', 1);
    await trade(a, withTrade, '20.40', 1);
    await trade(a, withTrade, '20.30', 3);
    await trade(a, withTrade, '20.90', 2); // fora de ordem, não vale
    await trade(a, withTrade, '25.00', 4, uuidv7()); // negócio de leilão não é do contínuo
    await a.store.transaction((tx) =>
      a.session.onTradeExecuted(tx, {
        instrumentId: withTrade,
        board: 'ODD_LOT',
        engineSeq: 5,
        price: '30.00',
        tradingDate: DAY,
      }),
    );
    const [call] = await liveAuctions(a, withCall);
    const [noCall] = await liveAuctions(a, withTrade);

    await routine(a, 'post_close', brt(DAY, '17:00'));
    await a.store.transaction((tx) =>
      a.session.onAuctionCompleted(tx, {
        instrumentId: withCall,
        board: 'MAIN',
        auctionId: call!.id,
        price: '10.55',
        quantity: 800,
      }),
    );
    await a.store.transaction((tx) =>
      a.session.onAuctionCompleted(tx, {
        instrumentId: withTrade,
        board: 'MAIN',
        auctionId: noCall!.id,
        price: null,
        quantity: 0,
      }),
    );
    await routine(a, 'session_close', brt(DAY, '17:30'));

    expect(await closingOf(a, withCall)).toMatchObject({ source: 'CLOSING_CALL' });
    expect((await closingOf(a, withCall)).price.toFixed(2)).toBe('10.55');
    expect(await closingOf(a, withTrade)).toMatchObject({ source: 'LAST_TRADE' });
    expect((await closingOf(a, withTrade)).price.toFixed(2)).toBe('20.30');

    const res = await a.http
      .get(`/v1/bo/session/closing-prices?date=${DAY}`)
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(res.body.items).toHaveLength(2);
  });

  it('spec "Sem negócios no dia": o fechamento é o previous_close', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', '10.00');
    await openDay(a, 'CLOSING_CALL');
    await close(a);
    expect(await closingOf(a, id)).toMatchObject({ source: 'PREVIOUS_CLOSE' });
    expect((await closingOf(a, id)).price.toFixed(2)).toBe('10.00');
  });

  it('negócio de outro pregão não fecha o dia', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', '10.00');
    await a.store.transaction((tx) =>
      a.session.onTradeExecuted(tx, {
        instrumentId: id,
        board: 'MAIN',
        engineSeq: 1,
        price: '99.00',
        tradingDate: '2026-03-02',
      }),
    );
    await openDay(a, 'CLOSING_CALL');
    await close(a);
    expect(await closingOf(a, id)).toMatchObject({ source: 'PREVIOUS_CLOSE' });
  });

  it('RN-FCH-002: o fechamento vira previous_close e band_reference_price do pregão seguinte', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', '10.00');
    await openDay(a, 'CONTINUOUS');
    await trade(a, id, '10.80', 1);
    await routine(a, 'closing_call', brt(DAY, '16:55'));
    await close(a);
    const after = (await inst(a, id))!;
    expect(after.previousClose!.toFixed(2)).toBe('10.80');
    expect(after.bandReferencePrice!.toFixed(2)).toBe('10.80');

    await routine(a, 'calendar_check', brt('2026-03-04', '07:00'), '2026-03-04');
    expect((await outbox(env.db, 'engine.band_update')).at(-1)!.payload).toMatchObject({
      instrumentId: id,
      bandReferencePrice: '10.8',
    });
  });

  it('RN-FCH-003: divergência acima de 5% do externo alerta uma vez, ao fechar ou na leitura seguinte', async () => {
    const a = await app(env);
    const atClose = await instrument(a, 'PETR4', '10.00');
    const later = await instrument(a, 'VALE3', '10.00');
    const fine = await instrument(a, 'ITUB4', '10.00');
    await openDay(a, 'CLOSING_CALL');
    const quote = (id: string, last: string, at: Instant) =>
      a.store.transaction((tx) =>
        a.session.onInstrumentQuote(tx, {
          instrumentId: id,
          lastPrice: last,
          previousClose: '10.00',
          quoteTime: at,
        }),
      );
    await quote(atClose, '12.00', brt(DAY, '16:50'));
    await quote(fine, '10.40', brt(DAY, '16:50'));
    await close(a);

    expect((await a.queries.alerts(10)).map((x) => [x.kind, x.data['instrumentId']])).toEqual([
      ['CLOSE_DIVERGENCE', atClose],
    ]);
    expect(await closingOf(a, atClose)).toMatchObject({ divergenceAlert: true });
    expect((await closingOf(a, atClose)).externalClose!.toFixed(2)).toBe('12.00');
    expect(await closingOf(a, fine)).toMatchObject({ divergenceAlert: false });

    // A leitura das 18:00 chega depois do fechamento: confere de novo, sem repetir o alerta.
    a.clock.advanceTo(brt(DAY, '18:00'));
    await quote(later, '11.00', brt(DAY, '18:00'));
    await quote(atClose, '12.10', brt(DAY, '18:00'));
    const alerts = await a.queries.alerts(10);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((x) => x.data['instrumentId'])).toContain(later);
  });

  it('o primeiro fechamento externo é a semente de quem não tem fechamento', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', null);
    await a.store.transaction((tx) =>
      a.session.onInstrumentQuote(tx, {
        instrumentId: id,
        lastPrice: '33.00',
        previousClose: '32.00',
        quoteTime: a.clock.now(),
      }),
    );
    const after = (await inst(a, id))!;
    expect(after.previousClose!.toFixed(2)).toBe('32.00');
    expect((await outbox(env.db, 'engine.band_update'))[0]!.payload).toMatchObject({
      bandReferencePrice: '32',
    });
  });
});
