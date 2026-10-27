// 16.3: histórico de tickers, busca por ticker antigo e tarefas de renomeação.
import { testClock } from '@broker/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  app,
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
  a = await app(env, { clock: testClock('2026-01-05T13:00:00Z') });
  await syncCatalog(a, [
    { symbol: 'ELET3' },
    { symbol: 'ELET6' },
    { symbol: 'BRFS3' },
    { symbol: 'JBSS3' },
  ]);
}, 180_000);
afterAll(() => stopEnv(env));

const detect = (p: {
  oldSymbol: string;
  newSymbol: string;
  effectiveDate: string;
  conversionRatio?: string;
}) => a.store.transaction((tx) => a.renames.onRenameDetected(tx, p));

describe('renomeação detectada (RN-INS-033)', () => {
  it('abre uma tarefa por troca (repetir não duplica) e avisa o backoffice', async () => {
    expect(
      await detect({
        oldSymbol: 'ELET3',
        newSymbol: 'AXIA3',
        effectiveDate: '2026-01-12',
        conversionRatio: '1',
      }),
    ).toBe(true);
    expect(
      await detect({
        oldSymbol: 'ELET3',
        newSymbol: 'AXIA3',
        effectiveDate: '2026-01-12',
        conversionRatio: '1',
      }),
    ).toBe(false);
    expect(
      await detect({ oldSymbol: 'XPTO3', newSymbol: 'XPTO4', effectiveDate: '2026-01-12' }),
    ).toBe(false);
    expect(a.alerts).toEqual([
      expect.objectContaining({
        kind: 'SYMBOL_RENAME_CONFIRMATION',
        message: expect.stringContaining('ELET3 → AXIA3'),
      }),
    ]);
    const tasks = await a.http
      .get('/v1/bo/tasks?status=OPEN')
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(tasks.body.items).toHaveLength(1);
    expect(tasks.body.items[0]).toMatchObject({
      kind: 'SYMBOL_RENAME_CONFIRMATION',
      data: {
        oldSymbol: 'ELET3',
        newSymbol: 'AXIA3',
        effectiveDate: '2026-01-12',
        corporateAction: false,
      },
    });
  });

  it('Busca por ticker antigo: confirmada a tarefa, ELET3 devolve AXIA3 com o aviso "Ticker alterado"', async () => {
    const id = await idOf(a, 'ELET3');
    const [task] = (
      await a.http.get('/v1/bo/tasks?status=OPEN').set(bearer(a.tokens.market)).expect(200)
    ).body.items;
    const res = await a.http
      .post(`/v1/bo/tasks/${task.id}/confirm`)
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(res.body.instrument).toMatchObject({
      instrumentId: id,
      symbol: 'AXIA3',
      oddLotSymbol: 'AXIA3F',
    });
    expect(res.body.task.status).toBe('DONE');

    const old = await a.http
      .get('/v1/instruments/by-symbol/ELET3')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(old.body).toMatchObject({
      instrument: { instrumentId: id, symbol: 'AXIA3' },
      board: 'MAIN',
      tradingSymbol: 'AXIA3',
      notice: 'Ticker alterado de ELET3 para AXIA3 em 12/01/2026',
    });
    const search = await a.http
      .get('/v1/instruments/search?q=ELET3')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(search.body.items[0].notice).toBe('Ticker alterado de ELET3 para AXIA3 em 12/01/2026');

    const history = await a.http
      .get(`/v1/instruments/${id}/symbol-history`)
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(history.body.items).toEqual([
      { symbol: 'ELET3', validFrom: '2026-01-05', validTo: '2026-01-11', conversionRatio: '1' },
    ]);
    const [changed] = await outbox(env.db, 'instrument.symbol_changed');
    expect(changed!.payload).toEqual({
      instrumentId: id,
      oldSymbol: 'ELET3',
      newSymbol: 'AXIA3',
      effectiveDate: '2026-01-12',
    });
  });

  it('RN-INS-031: conversão com razão ≠ 1 vira evento corporativo e não renomeia', async () => {
    expect(
      await detect({
        oldSymbol: 'ELET6',
        newSymbol: 'AXIA6',
        effectiveDate: '2026-01-12',
        conversionRatio: '1.5',
      }),
    ).toBe(true);
    const tasks = (
      await a.http.get('/v1/bo/tasks?status=OPEN').set(bearer(a.tokens.market)).expect(200)
    ).body.items;
    const task = tasks.find((t: { data: { oldSymbol: string } }) => t.data.oldSymbol === 'ELET6');
    expect(task.data.corporateAction).toBe(true);
    const res = await a.http
      .post(`/v1/bo/tasks/${task.id}/confirm`)
      .set(bearer(a.tokens.market))
      .expect(422);
    expect(res.body.code).toBe('CONVERSION_IS_CORPORATE_ACTION');
    await a.http
      .post(`/v1/bo/tasks/${task.id}/resolve`)
      .set(bearer(a.tokens.market))
      .send({ status: 'DISMISSED' })
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('DISMISSED'));
    expect(
      (await a.http.get('/v1/instruments/by-symbol/ELET6').set(bearer(a.tokens.customer))).body
        .notice,
    ).toBeUndefined();
  });
});

describe('renomeação direta (RN-INS-030)', () => {
  it('duas renomeações encadeiam o histórico e o ticker mais antigo aponta para o atual', async () => {
    const id = await idOf(a, 'BRFS3');
    await a.http
      .post(`/v1/bo/instruments/${id}/rename`)
      .set(bearer(a.tokens.market))
      .send({ newSymbol: 'MBRF3', effectiveDate: '2026-02-02' })
      .expect(200);
    await a.http
      .post(`/v1/bo/instruments/${id}/rename`)
      .set(bearer(a.tokens.market))
      .send({ newSymbol: 'MBRF4', effectiveDate: '2026-03-02' })
      .expect(200);
    const history = await a.http
      .get(`/v1/instruments/${id}/symbol-history`)
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(history.body.items).toEqual([
      { symbol: 'MBRF3', validFrom: '2026-02-02', validTo: '2026-03-01', conversionRatio: null },
      { symbol: 'BRFS3', validFrom: '2026-01-05', validTo: '2026-02-01', conversionRatio: null },
    ]);
    const oldest = await a.http
      .get('/v1/instruments/by-symbol/BRFS3')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(oldest.body.notice).toBe('Ticker alterado de BRFS3 para MBRF4 em 02/02/2026');
  });

  it('recusa ticker em uso por outro instrumento', async () => {
    const id = await idOf(a, 'JBSS3');
    const res = await a.http
      .post(`/v1/bo/instruments/${id}/rename`)
      .set(bearer(a.tokens.market))
      .send({ newSymbol: 'AXIA3', effectiveDate: '2026-02-02' })
      .expect(422);
    expect(res.body.code).toBe('SYMBOL_ALREADY_EXISTS');
  });
});
