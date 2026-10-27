// 16.1: cadastro, padrões por tipo, fracionário derivado, status e catálogo da brapi.
import { uuidv7 } from '@broker/ids';
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
    { symbol: 'PETR4', shortName: 'PETROBRAS PN' },
    { symbol: 'VALE3', shortName: 'VALE ON' },
    { symbol: 'HGLG11', assetType: 'REIT', shortName: 'CSHG LOGISTICA' },
    { symbol: 'BOVA11', assetType: 'ETF', shortName: 'ISHARES BOVA' },
    { symbol: 'AAPL34', shortName: 'APPLE DRN' },
  ]);
}, 180_000);
afterAll(() => stopEnv(env));

describe('catálogo (RN-INS-010)', () => {
  it('Novo ticker na brapi: criado com tradable = false e source = BRAPI, e instrument.created publicado', async () => {
    const res = await a.http
      .get('/v1/instruments/by-symbol/PETR4')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(res.body.instrument).toMatchObject({
      symbol: 'PETR4',
      assetType: 'STOCK',
      shareClass: 'PN',
      lotSize: 100,
      oddLotEnabled: true,
      oddLotSymbol: 'PETR4F',
      tradable: false,
      source: 'BRAPI',
      status: 'PENDING',
      currency: 'BRL',
      haircut: '0.30',
    });
    const created = await outbox(env.db, 'instrument.created');
    expect(created.map((e) => e.payload['symbol'])).toEqual([
      'PETR4',
      'VALE3',
      'HGLG11',
      'BOVA11',
      'AAPL34',
    ]);
    expect(created[0]!.partition_key).toBe(res.body.instrument.instrumentId);
  });

  it('sincronizar de novo não duplica; quem saiu da fonte (fora do universo) é deslistado', async () => {
    const again = await syncCatalog(a, [{ symbol: 'PETR4' }, { symbol: 'MGLU3' }], ['VALE3']);
    expect(again).toEqual({ created: 1, delisted: 1 });
    // Continua consultável pelo ticker exato, como DELISTED; some da busca por prefixo e nome.
    const vale = await a.http
      .get('/v1/instruments/search?q=VALE3')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(vale.body.items).toHaveLength(1);
    expect(vale.body.items[0].instrument).toMatchObject({ symbol: 'VALE3', status: 'DELISTED' });
    const prefix = await a.http
      .get('/v1/instruments/search?q=VAL')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(prefix.body.items).toEqual([]);
    const changed = await outbox(env.db, 'instrument.status_changed');
    expect(changed.at(-1)!.payload).toMatchObject({
      symbol: 'VALE3',
      from: 'PENDING',
      to: 'DELISTED',
      reason: 'REMOVED_FROM_CATALOG',
    });
  });
});

describe('padrões por tipo (Ativos §2.2)', () => {
  it('Padrão de FII: lote 1, sem fracionário e short_sale_enabled = false', async () => {
    const res = await a.http
      .get('/v1/instruments/by-symbol/HGLG11')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(res.body.instrument).toMatchObject({
      assetType: 'REIT',
      lotSize: 1,
      oddLotEnabled: false,
      oddLotSymbol: null,
      shortSaleEnabled: false,
      taxCategory: 'REIT',
      haircut: '0.40',
    });
  });

  it('o backoffice altera o padrão do tipo: vale para os próximos cadastros', async () => {
    const res = await a.http
      .put('/v1/bo/instrument-type-defaults/ETF')
      .set(bearer(a.tokens.market))
      .send({ haircut: '0.25' })
      .expect(200);
    expect(res.body).toMatchObject({ assetType: 'ETF', haircut: '0.25', lotSize: 1 });
    const created = await a.http
      .post('/v1/bo/instruments')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({ symbol: 'ivvb11', assetType: 'ETF', attributes: { shortName: 'ISHARES S&P500' } })
      .expect(201);
    expect(created.body).toMatchObject({
      symbol: 'IVVB11',
      haircut: '0.25',
      source: 'MANUAL',
      tradable: false,
    });
    const bova = await a.http
      .get('/v1/instruments/by-symbol/BOVA11')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(bova.body.instrument.haircut).toBe('0.20');
  });

  it('cadastro e edição exigem BO_MARKET; o fracionário acompanha o lote', async () => {
    await a.http.get('/v1/bo/instrument-type-defaults').set(bearer(a.tokens.support)).expect(403);
    const id = await idOf(a, 'AAPL34');
    const res = await a.http
      .patch(`/v1/bo/instruments/${id}`)
      .set(bearer(a.tokens.market))
      .send({ lotSize: 10, sector: 'Tecnologia' })
      .expect(200);
    expect(res.body).toMatchObject({
      assetType: 'BDR',
      lotSize: 10,
      oddLotEnabled: true,
      oddLotSymbol: 'AAPL34F',
      sector: 'Tecnologia',
    });
    const updated = await outbox(env.db, 'instrument.updated');
    expect(updated.at(-1)!.payload).toMatchObject({
      symbol: 'AAPL34',
      lotSize: 10,
      oddLotSymbol: 'AAPL34F',
    });
    await a.http
      .post('/v1/bo/instruments')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({ symbol: 'PETR4', assetType: 'STOCK' })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('SYMBOL_ALREADY_EXISTS'));
  });
});

describe('busca (RN-INS-002, RN-INS-006)', () => {
  it('Busca do fracionário: PETR4F devolve PETR4 no quadro ODD_LOT', async () => {
    const res = await a.http
      .get('/v1/instruments/search?q=petr4f')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(res.body.items[0]).toMatchObject({
      board: 'ODD_LOT',
      tradingSymbol: 'PETR4F',
      instrument: { symbol: 'PETR4' },
    });
    const exact = await a.http
      .get('/v1/instruments/by-symbol/PETR4F')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(exact.body).toMatchObject({ board: 'ODD_LOT', instrument: { symbol: 'PETR4' } });
  });

  it('prefixo traz o principal e o fracionário; nome também encontra', async () => {
    const res = await a.http
      .get('/v1/instruments/search?q=PETR')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(res.body.items.map((i: { tradingSymbol: string }) => i.tradingSymbol)).toEqual([
      'PETR4',
      'PETR4F',
    ]);
    const byName = await a.http
      .get('/v1/instruments/search?q=logistica')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(byName.body.items[0].instrument.symbol).toBe('HGLG11');
  });

  it('RN-INS-006: com lote 1 não há fracionário (HGLG11F não resolve)', async () => {
    const res = await a.http
      .get('/v1/instruments/by-symbol/HGLG11F')
      .set(bearer(a.tokens.customer))
      .expect(404);
    expect(res.body.code).toBe('INSTRUMENT_NOT_FOUND');
  });
});

describe('status (Ativos §5, RN-INS-020)', () => {
  it('suspender e retomar pelo backoffice publica instrument.status_changed', async () => {
    const id = await idOf(a, 'MGLU3');
    await a.http
      .post(`/v1/bo/instruments/${id}/status`)
      .set(bearer(a.tokens.market))
      .send({ status: 'SUSPENDED', reason: 'Fato relevante' })
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({ status: 'SUSPENDED', statusReason: 'Fato relevante' }),
      );
    await a.http
      .post(`/v1/bo/instruments/${id}/status`)
      .set(bearer(a.tokens.market))
      .send({ status: 'ACTIVE', reason: 'Retomada' })
      .expect(200);
    const changed = (await outbox(env.db, 'instrument.status_changed')).filter(
      (e) => e.payload['instrumentId'] === id,
    );
    expect(changed.map((e) => `${e.payload['from']}→${e.payload['to']}`)).toEqual([
      'PENDING→SUSPENDED',
      'SUSPENDED→ACTIVE',
    ]);
  });

  it('a primeira cotação leva PENDING a ACTIVE', async () => {
    const id = await idOf(a, 'PETR4');
    await a.store.transaction((tx) => a.instruments.onQuoteReceived(tx, id));
    expect((await a.instruments.get(id)).status).toBe('ACTIVE');
  });

  it('Cotação defasada: 2 dias úteis sem cotação válida → SUSPENDED com STALE_REFERENCE_PRICE', async () => {
    const id = await idOf(a, 'PETR4');
    // Última cotação na segunda (05/01): na terça é 1 dia útil, ainda não suspende.
    a.clock.advanceTo(a.clock.now().plusMillis(24 * 3_600_000));
    await a.store.transaction((tx) =>
      a.instruments.onInstrumentStale(tx, { instrumentId: id, staleSince: '2026-01-05T20:00:00Z' }),
    );
    expect((await a.instruments.get(id)).status).toBe('ACTIVE');
    // Quarta (07/01): 2 dias úteis → a rotina diária suspende.
    a.clock.advanceTo(a.clock.now().plusMillis(24 * 3_600_000));
    const stats = await a.daily();
    expect(stats.suspended).toBe(1);
    const i = await a.instruments.get(id);
    expect(i).toMatchObject({ status: 'SUSPENDED', statusReason: 'STALE_REFERENCE_PRICE' });
    const last = (await outbox(env.db, 'instrument.status_changed')).at(-1)!;
    expect(last.payload).toMatchObject({
      instrumentId: id,
      to: 'SUSPENDED',
      reason: 'STALE_REFERENCE_PRICE',
    });
    // A cotação volta: sai da suspensão por defasagem.
    await a.store.transaction((tx) => a.instruments.onQuoteReceived(tx, id));
    expect((await a.instruments.get(id)).status).toBe('ACTIVE');
  });
});
