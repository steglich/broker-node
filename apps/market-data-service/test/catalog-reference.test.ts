import { BusinessDate, Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { testClock } from '@broker/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadFixture } from '../src/adapters/brapi/fixtures.js';
import { SchemaCheck, compareShapes, isoWeek } from '../src/application/schema-check.js';
import {
  app,
  bearer,
  instrument,
  outbox,
  quoteFixture,
  reset,
  startEnv,
  stopEnv,
  type Env,
} from './helpers.js';

const at = (iso: string) => Instant.parse(iso);

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => stopEnv(env));
beforeEach(async () => reset(env.db));

/** Dispara a rotina como o agendador e deixa o líder executar. */
async function routine(
  a: Awaited<ReturnType<typeof app>>,
  routineName: string,
  date = '2026-10-27',
) {
  await a.store.transaction((tx) =>
    a.jobs.onTriggered(tx, { routineName, businessDate: date, executionId: uuidv7() }),
  );
  await a.jobs.runPending();
}

describe('catálogo, renomeações e histórico diário (Brapi §4, task 17.5)', () => {
  it('market_data.catalog_synced com as fixtures: novos tickers, depois só o que mudou', async () => {
    const a = await app(env, { clock: testClock({ date: '2026-10-27', time: '06:00' }) });
    expect(await a.catalog.syncIfDue()).toBeNull();
    a.clock.advanceTo(Instant.parse('2026-10-27T09:31:00Z'));
    const stats = await a.catalog.syncIfDue();
    expect(stats).toMatchObject({ pages: 2, received: 10, skipped: 2, newSymbols: 10, events: 1 });
    // Uma vez por dia.
    expect(await a.catalog.syncIfDue()).toBeNull();
    const [synced] = await outbox(env.db, 'market_data.catalog_synced');
    const p = synced!.payload as {
      newSymbols: { symbol: string; assetType: string }[];
      inactiveSymbols: string[];
    };
    expect(p.newSymbols.map((e) => e.symbol)).toEqual([
      'BBAS3',
      'B3SA3',
      'BBDC4',
      'BPAC11',
      'MXRF11',
      'ITUB4',
      'PETR4',
      'VALE3',
      'SMAL11',
      'ROXO34',
    ]);
    expect(p.newSymbols.find((e) => e.symbol === 'MXRF11')!.assetType).toBe('REIT');
    expect(p.inactiveSymbols).toEqual([]);
    expect(JSON.stringify(p)).not.toMatch(/subType|isActive|regularMarket/);

    // No dia seguinte a página 2 sumiu: os tickers dela saem do catálogo.
    a.fetch.set('/v2/tickers?page=1&limit=2000', () => {
      const f = structuredClone(loadFixture('tickers-page-1'));
      (f.response.body as { pagination: { hasNextPage: boolean } }).pagination.hasNextPage = false;
      return f;
    });
    a.clock.advanceTo(Instant.parse('2026-10-28T09:31:00Z'));
    await a.catalog.syncIfDue();
    const second = (await outbox(env.db, 'market_data.catalog_synced'))[1]!.payload as typeof p;
    expect(second.newSymbols).toEqual([]);
    expect(second.inactiveSymbols.sort()).toEqual(['ITUB4', 'PETR4', 'ROXO34', 'SMAL11', 'VALE3']);
  });

  it('RN-INS-030: resolve do universo publica a renomeação uma vez', async () => {
    const a = await app(env);
    await instrument(a, 'ELET3');
    await instrument(a, 'PETR4');
    a.fetch.set('/v2/tickers/resolve?symbols=ELET3,PETR4', loadFixture('resolve'));
    expect(await a.catalog.resolveUniverse()).toBe(1);
    expect(await a.catalog.resolveUniverse()).toBe(0);
    const [rename] = await outbox(env.db, 'market_data.symbol_rename_detected');
    expect(rename!.payload).toEqual({
      oldSymbol: 'ELET3',
      newSymbol: 'AXIA3',
      effectiveDate: '2025-11-10',
    });
  });

  it('histórico diário (E3): carga na entrada do universo e cache de 24 h', async () => {
    const a = await app(env);
    await instrument(a, 'PETR4');
    expect(await a.catalog.backfillHistory()).toBe(1);
    const calls = a.fetch.calls.filter((c) => c.url.includes('historical')).length;
    expect(calls).toBe(1);
    const res = await a.http
      .get('/v1/market-data/history/PETR4')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(res.body).toMatchObject({
      symbol: 'PETR4',
      fromCache: true,
      attribution: 'Fonte: brapi.dev',
    });
    expect(res.body.items.map((c: { date: string }) => c.date)).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-26',
    ]);
    expect(a.fetch.calls.filter((c) => c.url.includes('historical')).length).toBe(1);
    expect(await a.catalog.backfillHistory()).toBe(0);
  });

  it('Brapi §10: 403 desliga a capacidade por 24 h, sem novas tentativas', async () => {
    const a = await app(env);
    a.fetch.set(
      '/v2/stocks/historical?symbols=VALE3&range=3mo&interval=1d',
      loadFixture('error-403'),
    );
    const h = await a.catalog.history('VALE3');
    expect(h.warning).toMatch(/403/);
    expect(a.alerts.map((x) => x.kind)).toContain('CAPABILITY_UNAVAILABLE');
    const before = a.fetch.calls.length;
    await a.catalog.history('ITUB4');
    expect(a.fetch.calls.length).toBe(before);
  });
});

describe('preço de referência (task 17.6)', () => {
  it('cotação aceita publica BRAPI e o ruído segue no contínuo, com origin', async () => {
    const clock = testClock('2026-10-27T14:00:00Z');
    const a = await app(env, { clock });
    const id = await instrument(a, 'PETR4');
    a.fetch.set(
      '/v2/stocks/quote?symbols=PETR4',
      quoteFixture('PETR4', 38.45, at('2026-10-27T13:37:00Z')),
    );
    await a.poller.read('PETR4', 1, null);
    let events = await outbox(env.db, 'market_data.reference_price_updated');
    // Dia novo aberto às 14:00 com a âncora 38,45: só o ruído do último minuto é publicado (o resto
    // do dia só evolui o estado).
    expect(events.length).toBeGreaterThan(3);
    for (const e of events)
      expect(e.payload).toMatchObject({
        instrumentId: id,
        origin: 'SYNTHETIC_NOISE',
        anchorPrice: '38.4500',
      });
    expect(events.every((e) => (e.payload['at'] as string) >= '2026-10-27T13:59:00.000Z')).toBe(
      true,
    );
    const opened = events.length;

    clock.advanceTo(at('2026-10-27T14:01:00Z'));
    expect(await a.references.tick()).toBeGreaterThan(3);
    events = await outbox(env.db, 'market_data.reference_price_updated');
    expect(events.slice(opened).every((e) => e.payload['origin'] === 'SYNTHETIC_NOISE')).toBe(true);
    const seqs = events.map((e) => e.payload['seq'] as number);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));

    // Novo preço real: glide em passos de 15 s até a nova âncora.
    a.fetch.set(
      '/v2/stocks/quote?symbols=PETR4',
      quoteFixture('PETR4', 38.7, at('2026-10-27T14:07:00Z')),
    );
    await a.poller.read('PETR4', 1, null);
    // O laço do líder roda a cada segundo; aqui, a cada 10 s.
    for (
      let t = at('2026-10-27T14:01:10Z');
      !t.isAfter(at('2026-10-27T14:06:30Z'));
      t = t.plusMillis(10_000)
    ) {
      clock.advanceTo(t);
      await a.references.tick();
    }
    const glide = (await outbox(env.db, 'market_data.reference_price_updated')).filter(
      (e) => e.payload['origin'] === 'GLIDE',
    );
    expect(glide.length).toBe(20);
    expect(glide.at(-1)!.payload['anchorPrice']).toBe('38.7000');

    const view = await a.http
      .get(`/v1/market-data/reference-prices/${id}`)
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(view.body).toMatchObject({ instrumentId: id, anchorPrice: '38.7', noiseEnabled: true });
  });

  it('RN-SYN-006: override do backoffice fixa 30,00 por 10 minutos com origin MANUAL', async () => {
    const clock = testClock('2026-10-27T14:00:00Z');
    const a = await app(env, { clock });
    const id = await instrument(a, 'PETR4');
    a.fetch.set(
      '/v2/stocks/quote?symbols=PETR4',
      quoteFixture('PETR4', 38.45, at('2026-10-27T13:37:00Z')),
    );
    await a.poller.read('PETR4', 1, null);
    const before = (await outbox(env.db, 'market_data.reference_price_updated')).length;
    const res = await a.http
      .post('/v1/bo/market-data/reference-overrides')
      .set(bearer(a.tokens.market))
      .set('Idempotency-Key', uuidv7())
      .send({ instrumentId: id, price: '30.00', durationMinutes: 10, reason: 'teste de leilão' })
      .expect(201);
    expect(res.body).toMatchObject({ price: '30.0000', validUntil: '2026-10-27T14:10:00.000Z' });
    clock.advanceTo(at('2026-10-27T14:09:00Z'));
    await a.references.tick();
    const during = (await outbox(env.db, 'market_data.reference_price_updated'))
      .slice(before)
      .filter((e) => (e.payload['at'] as string) < '2026-10-27T14:10:00.000Z');
    expect(during.length).toBeGreaterThan(5);
    expect(
      during.every((e) => e.payload['origin'] === 'MANUAL' && e.payload['price'] === '30.0000'),
    ).toBe(true);
    clock.advanceTo(at('2026-10-27T14:11:00Z'));
    await a.references.tick();
    const after = (await outbox(env.db, 'market_data.reference_price_updated')).filter(
      (e) => (e.payload['at'] as string) >= '2026-10-27T14:10:00.000Z',
    );
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((e) => e.payload['origin'] !== 'MANUAL')).toBe(true);
  });

  it('RN-SYN-004: ruído desligado no instrumento; RN-SYN-001: fora do contínuo nada de ruído', async () => {
    const clock = testClock('2026-10-27T14:00:00Z');
    const a = await app(env, { clock });
    const id = await instrument(a, 'VALE3');
    await a.http
      .put(`/v1/bo/market-data/reference-noise/${id}`)
      .set(bearer(a.tokens.market))
      .send({ enabled: false })
      .expect(200);
    a.fetch.set(
      '/v2/stocks/quote?symbols=VALE3',
      quoteFixture('VALE3', 61.42, at('2026-10-27T13:37:00Z')),
    );
    await a.poller.read('VALE3', 1, null);
    clock.advanceTo(at('2026-10-27T14:05:00Z'));
    expect(await a.references.tick()).toBe(0);

    // Outro instrumento com ruído, depois do fechamento do contínuo.
    const other = await instrument(a, 'ITUB4');
    clock.advanceTo(at('2026-10-27T20:30:00Z'));
    a.fetch.set(
      '/v2/stocks/quote?symbols=ITUB4',
      quoteFixture('ITUB4', 38.15, at('2026-10-27T20:07:00Z')),
    );
    await a.poller.read('ITUB4', 1, null);
    clock.advanceTo(at('2026-10-27T21:00:00Z'));
    await a.references.tick();
    const itub = (await outbox(env.db, 'market_data.reference_price_updated')).filter(
      (e) => e.payload['instrumentId'] === other,
    );
    expect(itub.map((e) => [e.payload['origin'], e.payload['price']])).toEqual([
      ['BRAPI', '38.1500'],
    ]);
  });

  it('rotina daily_close responde routine.completed', async () => {
    const a = await app(env);
    await routine(a, 'daily_close');
    const [done] = await outbox(env.db, 'routine.completed');
    expect(done!.payload).toMatchObject({ routineName: 'daily_close', businessDate: '2026-10-27' });
  });
});

describe('segurança do token e verificação do esquema (task 17.7)', () => {
  it('RN-BRP-091: o log da requisição tem a URL, sem Authorization e sem o token', async () => {
    const a = await app(env, { metered: true, tokens: ['segredo-super-123'], logLevel: 'info' });
    await instrument(a, 'BBAS3');
    a.fetch.set(
      '/v2/stocks/quote?symbols=BBAS3',
      quoteFixture('BBAS3', 20, at('2026-10-27T13:30:00Z')),
    );
    await a.poller.read('BBAS3', 1, null);
    expect(a.fetch.calls.at(-1)!.headers['Authorization']).toBe('Bearer segredo-super-123');
    const lines = a.log.filter((l) => l.includes('brapi.request'));
    expect(lines.length).toBeGreaterThan(0);
    expect(
      lines.some((l) => l.includes('https://brapi.dev/api/v2/stocks/quote?symbols=BBAS3')),
    ).toBe(true);
    const all = a.log.join('\n');
    expect(all).not.toMatch(/authorization/i);
    expect(all).not.toContain('segredo-super-123');
    // Nem em eventos ou alertas.
    expect(JSON.stringify(await outbox(env.db))).not.toContain('segredo-super-123');
  });

  it('401: alerta crítico e requisições autenticadas param até liberar', async () => {
    const a = await app(env, { metered: true, tokens: ['vencido'] });
    await instrument(a, 'BBAS3');
    a.fetch.set('/v2/stocks/quote?symbols=BBAS3', loadFixture('error-401'));
    await a.poller.read('BBAS3', 1, null);
    expect(a.alerts.find((x) => x.kind === 'UNAUTHORIZED')?.severity).toBe('CRITICAL');
    const calls = a.fetch.quoteCalls('BBAS3');
    await a.poller.read('BBAS3', 1, null);
    expect(a.fetch.quoteCalls('BBAS3')).toBe(calls);
    // Ticker sem token continua.
    await a.poller.read('PETR4', 1, null);
    expect(a.fetch.quoteCalls('PETR4')).toBe(1);
    await a.http
      .post('/v1/bo/market-data/provider/auth-block/clear')
      .set(bearer(a.tokens.market))
      .expect(204);
    a.fetch.set(
      '/v2/stocks/quote?symbols=BBAS3',
      quoteFixture('BBAS3', 20, at('2026-10-27T13:30:00Z')),
    );
    await a.poller.read('BBAS3', 1, null);
    expect(a.fetch.quoteCalls('BBAS3')).toBe(calls + 1);
  });

  it('RN-BRP-100: verificação semanal desligada por padrão; ligada, roda uma vez por semana e alerta deriva', async () => {
    const a = await app(env, { clock: testClock({ date: '2026-10-26', time: '07:30' }) });
    expect(await a.schemaCheck.runIfDue()).toBeNull();
    let calls = 0;
    const probes = [
      {
        name: 'stocks/quote',
        fetch: async () => {
          calls++;
          const body = structuredClone(loadFixture('quote-petr4').response.body) as {
            results: { data: Record<string, unknown> }[];
          };
          // A brapi trocou o tipo de um campo e removeu outro.
          body.results[0]!.data['regularMarketPrice'] = '53.88';
          delete body.results[0]!.data['regularMarketTime'];
          return JSON.stringify(body);
        },
        expected: loadFixture('quote-petr4').response.body,
      },
    ];
    const check = new SchemaCheck(
      {
        ...a.store,
        store: a.store,
        clock: a.clock,
        newId: uuidv7,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        onAlert: (x) => a.alerts.push(x),
      } as never,
      a.queue,
      { enabled: true, weekday: 1, at: '07:00' },
      probes,
    );
    const drifts = await check.runIfDue();
    expect(drifts![0]!.changed).toEqual([
      { path: '/results[]/data/regularMarketPrice', expected: 'number', actual: 'string' },
      { path: '/results[]/data/regularMarketTime', expected: 'string', actual: 'missing' },
    ]);
    expect(a.alerts.map((x) => x.kind)).toContain('SCHEMA_DRIFT');
    expect(await check.runIfDue()).toBeNull();
    expect(calls).toBe(1);
    expect(isoWeek(BusinessDate.parse('2026-10-26').atLocalTime('07:30'))).toBe('2026-W44');
    expect(compareShapes('x', { a: 1, b: null }, { a: 2, b: 'agora tem', c: true })).toEqual({
      probe: 'x',
      changed: [],
      added: ['/c'],
    });
  });
});
