// 16.2: universo negociável com limite, dupla aprovação e instrument.tradability_changed.
import { uuidv7 } from '@broker/ids';
import { testClock } from '@broker/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  app,
  approve,
  bearer,
  idOf,
  include,
  outbox,
  startEnv,
  stopEnv,
  syncCatalog,
  type App,
  type Env,
} from './helpers.js';

// RN-INS-012: sugestão inicial de universo (20 instrumentos).
const SUGGESTED = [
  'PETR4',
  'VALE3',
  'ITUB4',
  'MGLU3',
  'BBDC4',
  'BBAS3',
  'ABEV3',
  'WEGE3',
  'B3SA3',
  'RENT3',
  'SUZB3',
  'ELET3',
  'PRIO3',
  'RADL3',
  'LREN3',
  'BOVA11',
  'HGLG11',
  'KNRI11',
  'IVVB11',
  'AAPL34',
];

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
  a = await app(env, { clock: testClock('2026-01-05T13:00:00Z') });
  await syncCatalog(
    a,
    [...SUGGESTED, 'CSAN3', 'GGBR4'].map((symbol) => ({ symbol })),
  );
}, 180_000);
afterAll(() => stopEnv(env));

describe('dupla aprovação da inclusão (Backoffice §3–§4)', () => {
  it('Instrumento incluído: aprovação publica instrument.tradability_changed e deixa PENDING até a primeira cotação', async () => {
    const id = await idOf(a, 'WEGE3');
    // Já ativo antes (consulta), para conferir a volta a PENDING.
    await a.store.transaction((tx) => a.instruments.onQuoteReceived(tx, id));
    const req = await include(a, id);
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({
      type: 'UNIVERSE_INCLUDE',
      status: 'PENDING',
      makerId: 'op-market',
      currentState: { tradable: false, status: 'ACTIVE' },
    });
    expect(req.body.expiresAt).toBe('2026-01-06T13:00:00.000Z');

    // RN-BO-001: o maker não aprova; BO_MARKET não é o checker do universo.
    const own = await approve(a, req.body.id, a.tokens.market).expect(422);
    expect(own.body.code).toBe('MAKER_CANNOT_APPROVE');
    const asMarket = await a.http
      .post(`/v1/bo/change-requests/${req.body.id}/approve`)
      .set(bearer(a.tokens.market2))
      .expect(422);
    expect(asMarket.body.code).toBe('CHECKER_ROLE_REQUIRED');

    const ok = await approve(a, req.body.id).expect(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', decidedBy: 'op-admin' });
    const i = await a.instruments.get(id);
    expect(i).toMatchObject({
      tradable: true,
      status: 'PENDING',
      statusReason: 'AWAITING_FIRST_QUOTE',
    });
    const [event] = await outbox(env.db, 'instrument.tradability_changed');
    expect(event!.payload).toEqual({
      instrumentId: id,
      symbol: 'WEGE3',
      oddLotSymbol: 'WEGE3F',
      lotSize: 100,
      tradable: true,
      approvalRequestId: req.body.id,
    });
    expect(event!.partition_key).toBe(id);
    // Aprovar de novo não executa outra vez (RN-MC-BO-004).
    await approve(a, req.body.id)
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('REQUEST_NOT_PENDING'));
    expect(await outbox(env.db, 'instrument.tradability_changed')).toHaveLength(1);
  });

  it('o maker cancela; reprovar exige o checker; uma pendente por instrumento', async () => {
    const id = await idOf(a, 'CSAN3');
    const req = await include(a, id);
    const dup = await include(a, id);
    expect(dup.status).toBe(422);
    expect(dup.body.code).toBe('REQUEST_ALREADY_PENDING');
    await a.http
      .post(`/v1/bo/change-requests/${req.body.id}/cancel`)
      .set(bearer(a.tokens.admin))
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('ONLY_MAKER_CAN_CANCEL'));
    await a.http
      .post(`/v1/bo/change-requests/${req.body.id}/cancel`)
      .set(bearer(a.tokens.market))
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('CANCELED'));
    const again = await include(a, id);
    await a.http
      .post(`/v1/bo/change-requests/${again.body.id}/reject`)
      .set(bearer(a.tokens.admin))
      .send({ reason: 'fora da estratégia' })
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({ status: 'REJECTED', decisionReason: 'fora da estratégia' }),
      );
    expect((await a.instruments.get(id)).tradable).toBe(false);
  });

  it('RN-MC-BO-003: o instrumento mudou entre a criação e a aprovação → STALE sem executar', async () => {
    const id = await idOf(a, 'GGBR4');
    const req = await include(a, id);
    await a.http
      .post(`/v1/bo/instruments/${id}/status`)
      .set(bearer(a.tokens.market))
      .send({ status: 'SUSPENDED', reason: 'Fato relevante' })
      .expect(200);
    const res = await approve(a, req.body.id).expect(422);
    expect(res.body.code).toBe('REQUEST_STALE');
    expect((await a.requests.get(req.body.id)).status).toBe('STALE');
    expect((await a.instruments.get(id)).tradable).toBe(false);
  });

  it('solicitação sem decisão em 24 h expira', async () => {
    const id = await idOf(a, 'CSAN3');
    const req = await include(a, id);
    a.clock.advanceTo(a.clock.now().plusMillis(24 * 3_600_000));
    expect(await a.requests.expireDue()).toBe(1);
    expect((await a.requests.get(req.body.id)).status).toBe('EXPIRED');
  });
});

describe('limite do universo (RN-INS-011)', () => {
  it('Universo cheio: a inclusão do 21º com o limite padrão é recusada com aviso do orçamento da brapi', async () => {
    for (const symbol of SUGGESTED.filter((s) => s !== 'WEGE3')) {
      const req = await include(a, await idOf(a, symbol));
      expect(req.status).toBe(201);
      await approve(a, req.body.id).expect(200);
    }
    const universe = await a.http
      .get('/v1/instruments/universe')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(universe.body).toMatchObject({ max: 20, count: 20 });

    const res = await include(a, await idOf(a, 'CSAN3'));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TRADABLE_UNIVERSE_FULL');
    expect(res.body.detail).toMatch(/orçamento de requisições da brapi/);
    expect(res.body.context).toEqual({ tradableCount: 20, max: 20 });
  });

  it('a aprovação também confere o limite: o universo encheu depois da proposta → STALE', async () => {
    // Proposta feita com 19 no universo (retirada em curso), aprovada depois que voltou a 20.
    const petr = await idOf(a, 'PETR4');
    const removal = await a.http
      .post('/v1/bo/universe/requests')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({ instrumentId: petr, action: 'REMOVE', justification: 'rodízio' })
      .expect(201);
    await approve(a, removal.body.id).expect(200);
    const csan = await include(a, await idOf(a, 'CSAN3'));
    expect(csan.status).toBe(201);
    const back = await include(a, petr);
    await approve(a, back.body.id).expect(200);
    const res = await approve(a, csan.body.id).expect(422);
    expect(res.body.code).toBe('REQUEST_STALE');
    expect((await a.requests.get(csan.body.id)).decisionReason).toMatch(/^TRADABLE_UNIVERSE_FULL/);
  });
});

describe('retirada (RN-INS-013)', () => {
  it('Retirada com ordens abertas: recusada ao propor e ao aprovar', async () => {
    const id = await idOf(a, 'ITUB4');
    a.orders.open.set(id, 2);
    const res = await a.http
      .post('/v1/bo/universe/requests')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({ instrumentId: id, action: 'REMOVE', justification: 'sai do universo' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSTRUMENT_HAS_OPEN_ORDERS');

    a.orders.open.set(id, 0);
    const req = await a.http
      .post('/v1/bo/universe/requests')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({ instrumentId: id, action: 'REMOVE', justification: 'sai do universo' })
      .expect(201);
    a.orders.open.set(id, 1);
    const stale = await approve(a, req.body.id).expect(422);
    expect(stale.body.code).toBe('REQUEST_STALE');
    expect((await a.instruments.get(id)).tradable).toBe(true);
  });

  it('retirada aprovada: tradable = false e tradability_changed com tradable = false', async () => {
    const id = await idOf(a, 'ITUB4');
    a.orders.open.set(id, 0);
    const req = await a.http
      .post('/v1/bo/universe/requests')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({ instrumentId: id, action: 'REMOVE', justification: 'sai do universo' })
      .expect(201);
    await approve(a, req.body.id).expect(200);
    expect((await a.instruments.get(id)).tradable).toBe(false);
    const last = (await outbox(env.db, 'instrument.tradability_changed')).at(-1)!;
    expect(last.payload).toMatchObject({
      instrumentId: id,
      tradable: false,
      approvalRequestId: req.body.id,
    });
  });
});
