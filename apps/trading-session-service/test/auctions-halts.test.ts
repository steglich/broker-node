// Tarefa 21.2: leilões programados com prorrogação, suspensões e retomada por leilão
// (RN-AUC-001..003, RN-HLT-*), com Postgres real e relógio virtual.
import { Decimal } from '@broker/domain-kernel';
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

const indicative = (a: App, auctionId: string, price: string | null) =>
  a.store.transaction((tx) =>
    a.session.onAuctionIndicative(tx, {
      board: 'MAIN',
      auctionId,
      theoreticalPrice: price,
      theoreticalQuantity: 1000,
    }),
  );
const completed = (
  a: App,
  instrumentId: string,
  auctionId: string,
  price: string | null,
  quantity = 500,
) =>
  a.store.transaction((tx) =>
    a.session.onAuctionCompleted(tx, { instrumentId, board: 'MAIN', auctionId, price, quantity }),
  );
const lastCommand = async (id: string) =>
  (await outbox(env.db, 'engine.phase_change')).filter((c) => c.partition_key === id).at(-1)!
    .payload;

describe('prorrogação (RN-AUC-003)', () => {
  it('spec "Prorrogação": teórico fora do túnel no fim previsto prorroga 2 minutos; o resto abre', async () => {
    const a = await app(env);
    const petr = await instrument(a, 'PETR4', '10.00');
    const vale = await instrument(a, 'VALE3', '10.00');
    await openDay(a, 'PRE_OPENING');
    const [petrAuction] = await liveAuctions(a, petr);
    const [valeAuction] = await liveAuctions(a, vale);
    await indicative(a, petrAuction!.id, '11.00'); // 10% acima, túnel de 8%
    await indicative(a, valeAuction!.id, '10.50');

    await routine(a, 'continuous', brt(DAY, '10:00'));

    expect((await market(a)).phase).toBe('CONTINUOUS');
    const [extended] = await liveAuctions(a, petr);
    expect(extended).toMatchObject({ id: petrAuction!.id, extensions: 1, marketScoped: false });
    expect(extended!.expectedEndAt.toString()).toBe(brt(DAY, '10:02').toString());
    // PETR4 continua em leilão, pela fase própria, e o Motor recebe o novo fim.
    expect((await inst(a, petr))!.phase).toBe('PRE_OPENING');
    expect(await lastCommand(petr)).toMatchObject({
      phase: 'PRE_OPENING',
      auctionId: petrAuction!.id,
      auctionEndAt: brt(DAY, '10:02').toString(),
    });
    expect((await outbox(env.db, 'session.phase_changed')).at(-2)!.payload).toMatchObject({
      scope: petr,
      from: 'PRE_OPENING',
      to: 'PRE_OPENING',
      reason: 'AUCTION_EXTENDED',
      expectedEndAt: brt(DAY, '10:02').toString(),
    });
    // VALE3 dentro do túnel: conclui com a abertura do mercado.
    expect(await lastCommand(vale)).toMatchObject({
      phase: 'CONTINUOUS',
      concludesAuctionId: valeAuction!.id,
    });

    const view = await a.http.get('/v1/market/session/PETR4').set(bearer(a.tokens.customer));
    expect(view.body).toMatchObject({
      phase: 'PRE_OPENING',
      auction: { extensions: 1, theoreticalPrice: '11' },
    });

    // Volta para dentro do túnel antes do novo fim: conclui, e abre ao o Motor responder.
    await indicative(a, petrAuction!.id, '10.70');
    a.clock.advanceTo(brt(DAY, '10:02'));
    await a.session.tick();
    expect(await lastCommand(petr)).toMatchObject({
      phase: 'CONTINUOUS',
      concludesAuctionId: petrAuction!.id,
    });
    expect((await inst(a, petr))!.phase).toBe('PRE_OPENING');

    await completed(a, petr, petrAuction!.id, '10.70');
    const after = (await inst(a, petr))!;
    expect(after.phase).toBeNull();
    // RN-INS-040: o preço do leilão vira a referência dos túneis.
    expect(after.bandReferencePrice!.toFixed(2)).toBe('10.70');
    expect((await outbox(env.db, 'session.phase_changed')).at(-1)!.payload).toMatchObject({
      scope: petr,
      from: 'PRE_OPENING',
      to: 'CONTINUOUS',
      reason: 'AUCTION_COMPLETED',
    });
    // O Motor já estava em CONTINUOUS: nada de comando repetido.
    expect((await lastCommand(petr))['concludesAuctionId']).toBe(petrAuction!.id);
  });

  it('RN-AUC-003: depois de 3 prorrogações, conclui limitado ao túnel e alerta o backoffice', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', '10.00');
    await openDay(a, 'PRE_OPENING');
    const [auction] = await liveAuctions(a, id);
    await indicative(a, auction!.id, '12.00');
    await routine(a, 'continuous', brt(DAY, '10:00'));
    for (const hhmm of ['10:02', '10:04']) {
      a.clock.advanceTo(brt(DAY, hhmm));
      await a.session.tick();
    }
    expect((await liveAuctions(a, id))[0]!.extensions).toBe(3);
    a.clock.advanceTo(brt(DAY, '10:06'));
    await a.session.tick();

    expect(await lastCommand(id)).toMatchObject({
      phase: 'CONTINUOUS',
      concludesAuctionId: auction!.id,
      priceLimit: { min: '9.2000', max: '10.8000' },
    });
    const alerts = await a.queries.alerts(10);
    expect(alerts.map((x) => x.kind)).toEqual(['AUCTION_EXTENSIONS_EXHAUSTED']);
    expect(alerts[0]!.data).toMatchObject({ auctionId: auction!.id, theoreticalPrice: '12' });
    const res = await a.http.get('/v1/bo/session/alerts').set(bearer(a.tokens.market)).expect(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('RN-AUC-003: com KEEP_OPEN, mantém o leilão até o backoffice concluir', async () => {
    const a = await app(env, {
      params: {
        marketDataOutageMinutes: 0,
        auctionExtensionPolicy: 'KEEP_OPEN',
        maxAuctionExtensions: 0,
      },
    });
    const id = await instrument(a, 'PETR4', '10.00');
    await openDay(a, 'PRE_OPENING');
    const [auction] = await liveAuctions(a, id);
    await indicative(a, auction!.id, '12.00');
    await routine(a, 'continuous', brt(DAY, '10:00'));
    expect((await liveAuctions(a, id))[0]!.status).toBe('HELD');
    expect((await inst(a, id))!.phase).toBe('PRE_OPENING');
    expect(await a.queries.alerts(10)).toHaveLength(1);

    // Mantido: o tempo não o tira do lugar.
    a.clock.advanceTo(brt(DAY, '11:00'));
    await a.session.tick();
    expect((await liveAuctions(a, id))[0]!.status).toBe('HELD');

    await a.http
      .post(`/v1/bo/session/auctions/${auction!.id}/conclude`)
      .set(bearer(a.tokens.customer))
      .expect(403);
    const res = await a.http
      .post(`/v1/bo/session/auctions/${auction!.id}/conclude`)
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(res.body.status).toBe('CONCLUDING');
    expect(await lastCommand(id)).toMatchObject({
      phase: 'CONTINUOUS',
      priceLimit: { min: '9.2000', max: '10.8000' },
    });
    await a.http
      .post(`/v1/bo/session/auctions/${auction!.id}/conclude`)
      .set(bearer(a.tokens.market))
      .expect(422);
  });

  it('call prorrogada: mercado segue em CLOSING_CALL e o post_close só termina depois dela (RN-ROT-002)', async () => {
    const a = await app(env);
    const petr = await instrument(a, 'PETR4', '10.00');
    const vale = await instrument(a, 'VALE3', '10.00');
    await openDay(a, 'CLOSING_CALL');
    const [petrCall] = await liveAuctions(a, petr);
    expect(petrCall!.type).toBe('CLOSING');
    await indicative(a, petrCall!.id, '11.00');

    const execution = await routine(a, 'post_close', brt(DAY, '17:00'));

    expect((await market(a)).phase).toBe('CLOSING_CALL');
    expect(
      await outbox(env.db, 'routine.completed').then((r) => r.at(-1)!.payload['routineName']),
    ).toBe('closing_call');
    // Quem concluiu já vai a POST_CLOSE pela fase própria (a mais restritiva).
    expect((await inst(a, vale))!.phase).toBe('POST_CLOSE');
    expect((await inst(a, petr))!.phase).toBeNull();
    expect(await lastCommand(petr)).toMatchObject({
      phase: 'CLOSING_CALL',
      auctionEndAt: brt(DAY, '17:02').toString(),
    });

    await indicative(a, petrCall!.id, '10.50');
    a.clock.advanceTo(brt(DAY, '17:02'));
    await a.session.tick();

    expect((await market(a)).phase).toBe('POST_CLOSE');
    expect((await inst(a, vale))!.phase).toBeNull();
    expect((await inst(a, petr))!.phase).toBeNull();
    expect(await lastCommand(petr)).toMatchObject({
      phase: 'POST_CLOSE',
      concludesAuctionId: petrCall!.id,
    });
    const done = (await outbox(env.db, 'routine.completed')).at(-1)!.payload;
    expect(done).toMatchObject({ routineName: 'post_close', executionId: execution });
  });

  it('RN-AUC-020: leilão sem preço não muda a referência', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', '10.00');
    await openDay(a, 'PRE_OPENING');
    const [auction] = await liveAuctions(a, id);
    await routine(a, 'continuous', brt(DAY, '10:00'));
    await completed(a, id, auction!.id, null, 0);
    expect((await inst(a, id))!.bandReferencePrice!.toFixed(2)).toBe('10.00');
  });

  it('o preço teórico do livro fracionário é ignorado', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', '10.00');
    await openDay(a, 'PRE_OPENING');
    const [auction] = await liveAuctions(a, id);
    await a.store.transaction((tx) =>
      a.session.onAuctionIndicative(tx, {
        board: 'ODD_LOT',
        auctionId: auction!.id,
        theoreticalPrice: '50.00',
        theoreticalQuantity: 1,
      }),
    );
    expect((await liveAuctions(a, id))[0]!.theoreticalPrice).toBeNull();
  });
});

describe('leilão por volatilidade (RN-AUC-030..032)', () => {
  const trigger = (a: App, instrumentId: string, auctionId: string, end: string) =>
    a.store.transaction((tx) =>
      a.session.onAuctionTriggered(tx, {
        instrumentId,
        board: 'MAIN',
        auctionId,
        expectedEndAt: end,
      }),
    );

  it('spec "Instrumento em leilão": mercado contínuo, PETR4 em VOLATILITY_AUCTION; retorno ao concluir', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', '10.00');
    await openDay(a, 'CONTINUOUS');
    const before = (await outbox(env.db, 'engine.phase_change')).length;
    const auctionId = uuidv7();
    a.clock.advanceTo(brt(DAY, '11:00'));
    await trigger(a, id, auctionId, brt(DAY, '11:05').toString());
    await trigger(a, id, auctionId, brt(DAY, '11:05').toString()); // repetido não duplica

    expect((await market(a)).phase).toBe('CONTINUOUS');
    const view = await a.http.get('/v1/market/session/PETR4').set(bearer(a.tokens.customer));
    expect(view.body).toMatchObject({ phase: 'VOLATILITY_AUCTION', auction: { auctionId } });
    // Foi o Motor que abriu: não recebe comando de volta.
    expect(await outbox(env.db, 'engine.phase_change')).toHaveLength(before);
    expect((await outbox(env.db, 'session.phase_changed')).at(-1)!.payload).toMatchObject({
      scope: id,
      from: 'CONTINUOUS',
      to: 'VOLATILITY_AUCTION',
      auctionId,
    });

    a.clock.advanceTo(brt(DAY, '11:05'));
    await a.session.tick();
    expect(await lastCommand(id)).toMatchObject({
      phase: 'CONTINUOUS',
      concludesAuctionId: auctionId,
    });
    await completed(a, id, auctionId, '10.40');
    expect((await inst(a, id))!.phase).toBeNull();
  });

  it('call de fechamento encerra o leilão por volatilidade em aberto', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4', '10.00');
    await openDay(a, 'CONTINUOUS');
    const auctionId = uuidv7();
    a.clock.advanceTo(brt(DAY, '16:54'));
    await trigger(a, id, auctionId, brt(DAY, '16:59').toString());
    await routine(a, 'closing_call', brt(DAY, '16:55'));
    const live = await liveAuctions(a, id);
    expect(live.map((x) => x.type)).toEqual(['CLOSING']);
    expect((await inst(a, id))!.phase).toBeNull();
    expect(await lastCommand(id)).toMatchObject({ phase: 'CLOSING_CALL', auctionType: 'CLOSING' });
  });
});

describe('suspensões (Pregão §5)', () => {
  it('spec "Suspensão manual": VALE3 em HALTED com motivo; a retomada abre leilão de 5 minutos', async () => {
    const a = await app(env);
    const vale = await instrument(a, 'VALE3');
    const petr = await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    a.clock.advanceTo(brt(DAY, '11:00'));

    await a.http
      .post('/v1/bo/session/halt')
      .set(bearer(a.tokens.customer))
      .send({ instrumentId: vale, reason: 'notícia relevante' })
      .expect(403);
    const res = await a.http
      .post('/v1/bo/session/halt')
      .set(bearer(a.tokens.market))
      .send({ instrumentId: vale, reason: 'notícia relevante' })
      .expect(200);
    expect(res.body).toMatchObject({
      scope: vale,
      reasonCode: 'BACKOFFICE',
      description: 'notícia relevante',
      cancelAllOnHalt: false,
      actorId: 'op-market',
    });

    expect((await market(a)).phase).toBe('CONTINUOUS');
    expect((await inst(a, vale))!.phase).toBe('HALTED');
    expect((await inst(a, petr))!.phase).toBeNull();
    expect(await lastCommand(vale)).toEqual({ scope: vale, phase: 'HALTED' });
    // RN-HLT-001: sem `cancel_all_on_halt`, as ordens ficam no livro.
    expect((await outbox(env.db, 'session.halt_started')).at(-1)!.payload).toMatchObject({
      haltId: res.body.haltId,
      scope: vale,
      reasonCode: 'BACKOFFICE',
      cancelAllOnHalt: false,
    });

    a.clock.advanceTo(brt(DAY, '11:30'));
    await a.http
      .post('/v1/bo/session/resume')
      .set(bearer(a.tokens.market))
      .send({ haltId: res.body.haltId })
      .expect(200);
    expect(await outbox(env.db, 'session.halt_ended')).toHaveLength(1);
    const [reopening] = await liveAuctions(a, vale);
    expect(reopening).toMatchObject({ type: 'REOPENING', status: 'OPEN' });
    expect(reopening!.expectedEndAt.toString()).toBe(brt(DAY, '11:35').toString());
    expect((await inst(a, vale))!.phase).toBe('PRE_OPENING');
    expect(await lastCommand(vale)).toMatchObject({
      phase: 'PRE_OPENING',
      auctionType: 'REOPENING',
      auctionId: reopening!.id,
      auctionEndAt: brt(DAY, '11:35').toString(),
    });

    a.clock.advanceTo(brt(DAY, '11:35'));
    await a.session.tick();
    await completed(a, vale, reopening!.id, '10.20');
    expect((await inst(a, vale))!.phase).toBeNull();
  });

  it('RN-HLT-001: cancel_all_on_halt vai no evento para o OMS; a retomada agendada roda sozinha', async () => {
    const a = await app(env);
    const id = await instrument(a, 'VALE3');
    await openDay(a, 'CONTINUOUS');
    a.clock.advanceTo(brt(DAY, '11:00'));
    await a.http
      .post('/v1/bo/session/halt')
      .set(bearer(a.tokens.market))
      .send({
        instrumentId: id,
        reason: 'erro operacional',
        cancelAllOnHalt: true,
        resumeAt: brt(DAY, '11:20').toString(),
      })
      .expect(200);
    expect((await outbox(env.db, 'session.halt_started')).at(-1)!.payload).toMatchObject({
      cancelAllOnHalt: true,
      resumesAt: brt(DAY, '11:20').toString(),
    });
    a.clock.advanceTo(brt(DAY, '11:19'));
    await a.session.tick();
    expect((await inst(a, id))!.phase).toBe('HALTED');
    a.clock.advanceTo(brt(DAY, '11:20'));
    await a.session.tick();
    expect((await inst(a, id))!.phase).toBe('PRE_OPENING');
  });

  it('spec "Recuperação do Motor": HALTED com ENGINE_RECOVERY até a retomada por leilão', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    a.clock.advanceTo(brt(DAY, '12:00'));
    await a.store.transaction((tx) => a.session.onBookRecovering(tx, id));
    await a.store.transaction((tx) => a.session.onBookRecovering(tx, id)); // repetido é a mesma

    expect(await outbox(env.db, 'session.halt_started')).toHaveLength(1);
    const view = await a.http.get('/v1/market/session/PETR4').set(bearer(a.tokens.customer));
    expect(view.body).toMatchObject({ phase: 'HALTED', reason: 'ENGINE_RECOVERY' });

    // Só termina quando o Motor avisa, não por comando.
    const [halt] = await a.queries.halts(true, 10);
    const refused = await a.http
      .post('/v1/bo/session/resume')
      .set(bearer(a.tokens.market))
      .send({ haltId: halt!.id })
      .expect(422);
    expect(refused.body.code).toBe('HALT_NOT_RESUMABLE');

    await a.store.transaction((tx) => a.session.onBookRecovered(tx, id));
    expect((await inst(a, id))!.phase).toBe('PRE_OPENING');
    expect((await liveAuctions(a, id))[0]!.type).toBe('REOPENING');
  });

  it('RN-INS-020/021: SUSPENDED no cadastro suspende; a volta retoma por leilão', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    const status = (from: string, to: string, reason: string) =>
      a.store.transaction((tx) =>
        a.session.onStatusChanged(tx, { instrumentId: id, symbol: 'PETR4', from, to, reason }),
      );
    await status('ACTIVE', 'SUSPENDED', 'STALE_REFERENCE_PRICE');
    expect((await inst(a, id))!).toMatchObject({
      phase: 'HALTED',
      reason: 'STALE_REFERENCE_PRICE',
    });
    await status('SUSPENDED', 'ACTIVE', 'QUOTE_RECOVERED');
    expect((await inst(a, id))!.phase).toBe('PRE_OPENING');
    expect((await liveAuctions(a, id))[0]!.type).toBe('REOPENING');

    await status('ACTIVE', 'SUSPENDED', 'CORPORATE_ACTION_SPLIT');
    expect((await inst(a, id))!.reason).toBe('CORPORATE_ACTION');
    // A suspensão cancela o leilão de retomada em curso.
    expect(await liveAuctions(a, id)).toEqual([]);
  });

  it('dois motivos ao mesmo tempo: só retoma quando o último acaba', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    await a.store.transaction((tx) => a.session.onBookRecovering(tx, id));
    const res = await a.http
      .post('/v1/bo/session/halt')
      .set(bearer(a.tokens.market))
      .send({ instrumentId: id, reason: 'manual' })
      .expect(200);
    await a.store.transaction((tx) => a.session.onBookRecovered(tx, id));
    expect((await inst(a, id))!.phase).toBe('HALTED');
    await a.http
      .post('/v1/bo/session/resume')
      .set(bearer(a.tokens.market))
      .send({ haltId: res.body.haltId })
      .expect(200);
    expect((await inst(a, id))!.phase).toBe('PRE_OPENING');
  });

  it('instrumento suspenso fica de fora dos leilões do mercado e segue HALTED no dia seguinte', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    await routine(a, 'calendar_check', brt(DAY, '07:00'));
    await a.store.transaction((tx) => a.session.onBookRecovering(tx, id));
    await routine(a, 'pre_opening', brt(DAY, '09:45'));
    expect(await liveAuctions(a, id)).toEqual([]);
    await routine(a, 'continuous', brt(DAY, '10:00'));
    expect(await lastCommand(id)).toMatchObject({ phase: 'HALTED' });
    await routine(a, 'post_close', brt(DAY, '17:00'));
    await routine(a, 'session_close', brt(DAY, '17:30'));
    expect((await inst(a, id))!.phase).toBe('HALTED');
    // Fora de pregão, a retomada não tem leilão: volta a seguir o mercado.
    await a.store.transaction((tx) => a.session.onBookRecovered(tx, id));
    expect((await inst(a, id))!.phase).toBeNull();
    expect(await liveAuctions(a, id)).toEqual([]);
    expect(await lastCommand(id)).toEqual({ scope: id, phase: 'CLOSED' });
  });

  it('Backoffice §3: suspender o mercado exige BO_ADMIN aprovando; a grade anda por baixo', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    a.clock.advanceTo(brt(DAY, '11:00'));

    const proposal = await a.http
      .post('/v1/bo/session/halt')
      .set(bearer(a.tokens.market))
      .send({ reason: 'falha geral', cancelAllOnHalt: true })
      .expect(202);
    expect(proposal.body).toMatchObject({
      type: 'MARKET_HALT',
      status: 'PENDING',
      makerId: 'op-market',
    });
    expect((await market(a)).phase).toBe('CONTINUOUS');

    const approve = (token: string) =>
      a.http.post(`/v1/bo/session/change-requests/${proposal.body.id}/approve`).set(bearer(token));
    expect((await approve(a.tokens.market).expect(403)).body.code).toBe('MAKER_CANNOT_DECIDE');
    expect((await approve(a.tokens.market2).expect(403)).body.code).toBe('FORBIDDEN');
    expect((await approve(a.tokens.admin).expect(200)).body.status).toBe('APPROVED');
    expect((await approve(a.tokens.admin).expect(422)).body.code).toBe('REQUEST_NOT_PENDING');

    const m = await market(a);
    expect(m).toMatchObject({
      phase: 'HALTED',
      scheduledPhase: 'CONTINUOUS',
      reason: 'BACKOFFICE',
    });
    expect(await lastCommand(id)).toEqual({ scope: id, phase: 'HALTED' });
    const [halt] = await a.queries.halts(true, 10);
    expect(halt).toMatchObject({
      scope: 'MARKET',
      cancelAllOnHalt: true,
      actorId: 'op-market',
      approvalRequestId: proposal.body.id,
    });

    // A call passa com o mercado suspenso: só a fase da grade muda.
    await routine(a, 'closing_call', brt(DAY, '16:55'));
    expect(await market(a)).toMatchObject({ phase: 'HALTED', scheduledPhase: 'CLOSING_CALL' });
    // O post_close encerra a suspensão de mercado: sem leilão, sem pendência.
    await routine(a, 'post_close', brt(DAY, '17:00'));
    expect((await market(a)).phase).toBe('POST_CLOSE');
    expect(await a.queries.halts(true, 10)).toEqual([]);
    expect(await lastCommand(id)).toEqual({ scope: id, phase: 'POST_CLOSE' });
  });

  it('retomar o mercado: aprovação, leilão de 5 minutos e volta à fase da grade', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    a.clock.advanceTo(brt(DAY, '11:00'));
    const halting = await a.http
      .post('/v1/bo/session/halt')
      .set(bearer(a.tokens.market))
      .send({ reason: 'falha geral' });
    await a.http
      .post(`/v1/bo/session/change-requests/${halting.body.id}/approve`)
      .set(bearer(a.tokens.admin))
      .expect(200);
    const [halt] = await a.queries.halts(true, 10);

    // Justificativa é obrigatória na proposta de mercado.
    await a.http
      .post('/v1/bo/session/resume')
      .set(bearer(a.tokens.market))
      .send({ haltId: halt!.id })
      .expect(422);
    const resuming = await a.http
      .post('/v1/bo/session/resume')
      .set(bearer(a.tokens.market))
      .send({ haltId: halt!.id, justification: 'normalizado' })
      .expect(202);
    a.clock.advanceTo(brt(DAY, '11:30'));
    await a.http
      .post(`/v1/bo/session/change-requests/${resuming.body.id}/approve`)
      .set(bearer(a.tokens.admin))
      .expect(200);

    const m = await market(a);
    expect(m).toMatchObject({
      phase: 'PRE_OPENING',
      scheduledPhase: 'CONTINUOUS',
      reason: 'RESUME',
    });
    expect(m.expectedEndAt!.toString()).toBe(brt(DAY, '11:35').toString());
    const [auction] = await liveAuctions(a, id);
    expect(auction).toMatchObject({ type: 'REOPENING', marketScoped: true });
    expect(await lastCommand(id)).toMatchObject({ phase: 'PRE_OPENING', auctionType: 'REOPENING' });

    a.clock.advanceTo(brt(DAY, '11:35'));
    await a.session.tick();
    expect((await market(a)).phase).toBe('CONTINUOUS');
    expect(await lastCommand(id)).toMatchObject({
      phase: 'CONTINUOUS',
      concludesAuctionId: auction!.id,
    });
  });

  it('RN-MC-BO-002/003: reprovação, cancelamento, expiração e solicitação vencida pelo estado', async () => {
    const a = await app(env);
    await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    const propose = async () =>
      (
        await a.http
          .post('/v1/bo/session/halt')
          .set(bearer(a.tokens.market))
          .send({ reason: 'x' })
          .expect(202)
      ).body.id as string;

    const rejected = await a.http
      .post(`/v1/bo/session/change-requests/${await propose()}/reject`)
      .set(bearer(a.tokens.admin))
      .send({ reason: 'sem motivo' })
      .expect(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', decisionReason: 'sem motivo' });

    const canceled = await propose();
    await a.http
      .post(`/v1/bo/session/change-requests/${canceled}/cancel`)
      .set(bearer(a.tokens.market2))
      .expect(403);
    await a.http
      .post(`/v1/bo/session/change-requests/${canceled}/cancel`)
      .set(bearer(a.tokens.market))
      .expect(200);

    const first = await propose();
    const second = await propose();
    await a.http
      .post(`/v1/bo/session/change-requests/${first}/approve`)
      .set(bearer(a.tokens.admin))
      .expect(200);
    const stale = await a.http
      .post(`/v1/bo/session/change-requests/${second}/approve`)
      .set(bearer(a.tokens.admin))
      .expect(200);
    expect(stale.body.status).toBe('STALE');

    const late = await propose();
    a.clock.advanceBy(25 * 3_600_000);
    await a.http
      .post(`/v1/bo/session/change-requests/${late}/approve`)
      .set(bearer(a.tokens.admin))
      .expect(422);
    expect(await a.backoffice.expireDue()).toBe(1);
    const list = await a.http
      .get('/v1/bo/session/change-requests?status=EXPIRED')
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([late]);
  });

  it('Pregão §5: Market Data mudo por 10 minutos no contínuo suspende; a volta retoma por leilão', async () => {
    const a = await app(env, { params: { marketDataOutageMinutes: 10 } });
    const id = await instrument(a, 'PETR4');
    await openDay(a, 'CONTINUOUS');
    const beat = () => a.store.transaction((tx) => a.session.heartbeat(tx));

    a.clock.advanceTo(brt(DAY, '10:09'));
    await a.session.tick();
    expect((await market(a)).phase).toBe('CONTINUOUS');
    await beat();
    a.clock.advanceTo(brt(DAY, '10:18'));
    await a.session.tick();
    expect((await market(a)).phase).toBe('CONTINUOUS');

    // Economia de cota (Brapi §5.3): leituras rareiam de propósito, não suspende.
    await a.store.transaction((tx) => tx.saveBudgetLevel('SAVING'));
    a.clock.advanceTo(brt(DAY, '10:40'));
    await a.session.tick();
    expect((await market(a)).phase).toBe('CONTINUOUS');
    await a.store.transaction((tx) => tx.saveBudgetLevel('NORMAL'));

    await a.session.tick();
    expect(await market(a)).toMatchObject({ phase: 'HALTED', reason: 'MARKET_DATA_UNAVAILABLE' });
    expect(await lastCommand(id)).toEqual({ scope: id, phase: 'HALTED' });

    a.clock.advanceTo(brt(DAY, '10:50'));
    await beat();
    expect((await market(a)).phase).toBe('PRE_OPENING');
    expect((await liveAuctions(a, id))[0]!.type).toBe('REOPENING');
    expect((await market(a)).expectedEndAt!.toString()).toBe(brt(DAY, '10:55').toString());
  });

  it('universo: quem entra recebe a referência e a fase; quem sai tem o leilão cancelado', async () => {
    const a = await app(env);
    await openDay(a, 'PRE_OPENING');
    const id = uuidv7();
    await a.store.transaction(async (tx) => {
      await a.session.onInstrumentState(tx, {
        instrumentId: id,
        symbol: 'NOVO3',
        tradable: false,
        status: 'PENDING',
      });
      const i = (await tx.instrument(id))!;
      i.bandReferencePrice = new Decimal('5');
      await tx.saveInstrument(i);
    });
    await a.store.transaction((tx) =>
      a.session.onTradabilityChanged(tx, { instrumentId: id, symbol: 'NOVO3', tradable: true }),
    );
    expect(await lastCommand(id)).toEqual({ scope: id, phase: 'PRE_OPENING' });
    expect((await outbox(env.db, 'engine.band_update')).at(-1)!.partition_key).toBe(id);
    await a.store.transaction((tx) =>
      a.session.onTradabilityChanged(tx, { instrumentId: id, symbol: 'NOVO3', tradable: false }),
    );
    expect(await lastCommand(id)).toEqual({ scope: id, phase: 'CLOSED' });
  });
});
