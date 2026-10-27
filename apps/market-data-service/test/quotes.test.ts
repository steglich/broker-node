import { Instant } from '@broker/domain-kernel';
import { testClock } from '@broker/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadFixture } from '../src/adapters/brapi/fixtures.js';
import { ReplayProvider } from '../src/adapters/replay-provider.js';
import {
  app,
  bearer,
  history,
  instrument,
  outbox,
  quoteFixture,
  reset,
  startEnv,
  stopEnv,
  type Env,
} from './helpers.js';

const at = (iso: string) => Instant.parse(iso);
const BRAPI_FIELDS = /regularMarket|fiftyTwoWeek|logourl|requestedAt/;

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => stopEnv(env));
beforeEach(async () => reset(env.db));

describe('leituras, histórico, cache e corpo bruto (RN-BRP-060/061, Brapi §7)', () => {
  it('RN-BRP-060: leitura aceita grava histórico com hash, external_quote, cache, MinIO e evento sem nomes da brapi', async () => {
    const a = await app(env);
    const id = await instrument(a, 'PETR4');
    const r = await a.poller.read('PETR4', 1, null);
    expect(r?.disposition).toBe('ACCEPTED');

    const h = await history(env.db, 'PETR4');
    expect(h.at(-1)).toMatchObject({ disposition: 'ACCEPTED', provider: 'fixture' });
    expect(h.at(-1)!.raw_sha256).toMatch(/^[0-9a-f]{64}$/);
    const stored = await a.store.transaction((tx) => tx.quote('PETR4'));
    expect(stored).toMatchObject({ instrumentId: id, kind: 'INSTRUMENT', stale: false });
    expect(stored!.quote.lastPrice).toBe('53.88');
    expect([...a.raw.objects.keys()]).toEqual([`2026-10-27/PETR4/${h.at(-1)!.raw_sha256}.json`]);

    const [event] = await outbox(env.db, 'market_data.external_quote_received');
    expect(event!.partition_key).toBe(id);
    expect(event!.payload).toMatchObject({
      instrumentId: id,
      symbol: 'PETR4',
      kind: 'INSTRUMENT',
      lastPrice: '53.88',
      quoteTime: '2026-10-27T12:37:30.000Z',
      stale: false,
      source: 'fixture',
    });
    expect(JSON.stringify(event!.payload)).not.toMatch(BRAPI_FIELDS);

    // Consulta seguinte vem do cache, sem requisição.
    const before = a.fetch.quoteCalls('PETR4');
    const res = await a.http
      .get('/v1/market-data/external-quotes/PETR4')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(res.body).toMatchObject({ servedFrom: 'CACHE' });
    expect(res.body.attribution).toMatch(/^Fonte: brapi\.dev/);
    expect(a.fetch.quoteCalls('PETR4')).toBe(before);
  });

  it('RN-BRP-072: leitura com quote_time mais antigo é descartada sem publicar', async () => {
    const a = await app(env);
    await instrument(a, 'WEGE3');
    a.fetch.set(
      '/v2/stocks/quote?symbols=WEGE3',
      quoteFixture('WEGE3', 50, at('2026-10-27T13:37:00Z')),
    );
    await a.poller.read('WEGE3', 1, null);
    a.fetch.set(
      '/v2/stocks/quote?symbols=WEGE3',
      quoteFixture('WEGE3', 49, at('2026-10-27T13:07:00Z')),
    );
    const r = await a.poller.read('WEGE3', 1, null);
    expect(r?.disposition).toBe('DISCARDED_OUT_OF_ORDER');
    expect(await outbox(env.db, 'market_data.external_quote_received')).toHaveLength(1);
    expect((await a.store.transaction((tx) => tx.quote('WEGE3')))!.quote.lastPrice).toBe('50');
    expect((await history(env.db, 'WEGE3')).map((x) => x.disposition)).toEqual(
      expect.arrayContaining(['ACCEPTED', 'DISCARDED_OUT_OF_ORDER']),
    );
  });

  it('RN-BRP-071: salto de 8% fica em quarentena até a leitura seguinte confirmar', async () => {
    const a = await app(env);
    await instrument(a, 'SUZB3');
    const q = (price: number, t: string) =>
      a.fetch.set('/v2/stocks/quote?symbols=SUZB3', quoteFixture('SUZB3', price, at(t)));
    q(50, '2026-10-27T13:07:00Z');
    await a.poller.read('SUZB3', 1, null);
    q(54, '2026-10-27T13:37:00Z');
    expect((await a.poller.read('SUZB3', 1, null))?.disposition).toBe('QUARANTINED');
    // A âncora não muda e nada é publicado.
    expect((await a.store.transaction((tx) => tx.quote('SUZB3')))!.quote.lastPrice).toBe('50');
    expect(await outbox(env.db, 'market_data.external_quote_received')).toHaveLength(1);
    expect(a.alerts.map((x) => x.kind)).toContain('QUOTE_QUARANTINED');
    q(54.2, '2026-10-27T14:07:00Z');
    expect((await a.poller.read('SUZB3', 1, null))?.disposition).toBe('ACCEPTED');
    expect((await a.store.transaction((tx) => tx.quote('SUZB3')))!.quote.lastPrice).toBe('54.2');
    expect(await a.store.transaction((tx) => tx.quarantine('SUZB3'))).toBeNull();
  });

  it('RN-BRP-070: 50 minutos no pregão marca defasado e publica instrument_stale uma vez', async () => {
    const clock = testClock('2026-10-27T14:20:00Z');
    const a = await app(env, { clock });
    const id = await instrument(a, 'RENT3');
    a.fetch.set(
      '/v2/stocks/quote?symbols=RENT3',
      quoteFixture('RENT3', 40, at('2026-10-27T14:10:00Z')),
    );
    await a.poller.read('RENT3', 1, null);
    expect(await a.quotes.checkStale()).toBe(0);
    clock.advanceTo(at('2026-10-27T15:00:00Z'));
    expect(await a.quotes.checkStale()).toBe(1);
    expect(await a.quotes.checkStale()).toBe(0);
    const stale = await outbox(env.db, 'market_data.instrument_stale');
    expect(stale.map((e) => e.payload)).toEqual([
      { instrumentId: id, staleSince: '2026-10-27T14:10:00.000Z' },
    ]);
    // A cotação continua valendo (RN-BRP-081), marcada como defasada.
    expect(await a.store.transaction((tx) => tx.quote('RENT3'))).toMatchObject({ stale: true });
  });

  it('Ibovespa: leitura de ^BVSP publica external_quote_received do índice (RN-MD-020/021)', async () => {
    const a = await app(env);
    await a.poller.read('^BVSP', 2, null);
    const [event] = await outbox(env.db, 'market_data.external_quote_received');
    expect(event!.payload).toMatchObject({
      instrumentId: null,
      symbol: '^BVSP',
      kind: 'INDEX',
      lastPrice: '146512',
    });
    expect(event!.partition_key).toBe('^BVSP');
  });
});

describe('agendamento adaptativo (RN-BRP-050..053)', () => {
  it('RN-BRP-050: depois da leitura, a próxima é quote_time + 30 min + folga', async () => {
    const a = await app(env);
    await instrument(a, 'PETR4');
    a.fetch.set(
      '/v2/stocks/quote?symbols=PETR4',
      quoteFixture('PETR4', 38, at('2026-10-27T13:55:00Z')),
    );
    expect(await a.poller.tick()).toBe(2);
    await new Promise((r) => setTimeout(r, 300));
    const s = new Map(
      (await a.store.transaction((tx) => tx.schedules())).map((x) => [x.symbol, x]),
    );
    // Folga fixa do teste: 120 s.
    expect(s.get('PETR4')!.nextReadAt.toString()).toBe('2026-10-27T14:27:00.000Z');
    // Nada vencido: a rodada seguinte não pede nada.
    expect(await a.poller.tick()).toBe(0);
  });

  it('RN-BRP-053: nenhuma requisição de cotação no sábado', async () => {
    const a = await app(env, { clock: testClock('2026-10-31T14:00:00Z') });
    await instrument(a, 'PETR4');
    expect(await a.poller.tick()).toBe(0);
    expect(a.fetch.calls).toHaveLength(0);
  });

  it('RN-BRP-051: antes de 10:05 não há leitura; o pós-fechamento das 18:00 grava o candle do dia', async () => {
    const clock = testClock({ date: '2026-10-27', time: '10:02' });
    const a = await app(env, { clock });
    await instrument(a, 'ITUB4');
    expect(await a.poller.tick()).toBe(0);
    clock.advanceTo(at('2026-10-27T21:00:00Z'));
    a.fetch.set(
      '/v2/stocks/quote?symbols=ITUB4',
      quoteFixture('ITUB4', 38.15, at('2026-10-27T20:07:00Z')),
    );
    const stats = await a.poller.closeSnapshot();
    expect(stats).toMatchObject({ read: 2, failed: 0 });
    const candles = await a.store.transaction((tx) => tx.candles('ITUB4'));
    expect(candles.map((c) => [c.date.toString(), c.close, c.source])).toEqual([
      ['2026-10-27', '38.15', 'CLOSE_SNAPSHOT'],
    ]);
  });
});

describe('orçamento e degradação (RN-BRP-030..035)', () => {
  it('RN-BRP-030/032: lê o E9, conta cada envio e recalcula o orçamento', async () => {
    const a = await app(env, { metered: true });
    await a.work();
    await new Promise((r) => setTimeout(r, 200));
    const state = await a.http
      .get('/v1/bo/market-data/provider')
      .set(bearer(a.tokens.market))
      .expect(200);
    expect(state.body.budget).toMatchObject({ level: 'NORMAL', metered: true, planLimit: 15000 });
    expect(state.body.budget.remaining).toBeLessThanOrEqual(10_800);
    await instrument(a, 'PETR4');
    await a.poller.read('PETR4', 1, null);
    expect((await a.store.transaction((tx) => tx.usage())).sentSinceUsage).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('cota esgotada: 429 por cota → EXHAUSTED, evento, alerta crítico, nenhuma cotação e preços defasados', async () => {
    const a = await app(env, { metered: true });
    const id = await instrument(a, 'BBAS3');
    a.fetch.set(
      '/v2/stocks/quote?symbols=BBAS3',
      quoteFixture('BBAS3', 20, at('2026-10-27T13:30:00Z')),
    );
    await a.poller.read('BBAS3', 1, null);
    a.fetch.set('/v2/stocks/quote?symbols=BBAS3', loadFixture('error-429-quota'));
    await a.poller.read('BBAS3', 1, null);
    expect(a.budget.level()).toBe('EXHAUSTED');
    const [changed] = await outbox(env.db, 'market_data.provider_budget_level_changed');
    expect(changed!.payload).toMatchObject({ from: 'NORMAL', to: 'EXHAUSTED' });
    expect(a.alerts.find((x) => x.kind === 'QUOTA_EXHAUSTED')?.severity).toBe('CRITICAL');

    const calls = a.fetch.quoteCalls();
    await a.poller.read('BBAS3', 1, null);
    expect(a.fetch.quoteCalls()).toBe(calls);
    expect(await a.quotes.checkStale()).toBe(1);
    expect((await outbox(env.db, 'market_data.instrument_stale'))[0]!.payload).toMatchObject({
      instrumentId: id,
    });
  });
});

describe('troca de provedor (RN-BRP-003)', () => {
  it('o replay serve as leituras gravadas, sem chamadas à brapi', async () => {
    const recorder = await app(env);
    await instrument(recorder, 'ABEV3');
    // Leituras "reais" gravadas há uma semana.
    await env.db.transaction().execute(async (trx) => {
      for (const [price, t] of [
        [12.1, '2026-10-20T13:37:00Z'],
        [12.3, '2026-10-20T14:07:00Z'],
      ] as const) {
        await sql`INSERT INTO external_quote_history (id, symbol, provider, fetched_at, quote_time, data, raw_sha256, disposition)
          VALUES (gen_random_uuid(), 'ABEV3', 'brapi', ${t}, ${t},
            ${JSON.stringify({ ...(await recorder.brapi.getQuote('PETR4')).value, symbol: 'ABEV3', requestedSymbol: 'ABEV3', lastPrice: String(price), quoteTime: t })},
            'x', 'ACCEPTED')`.execute(trx);
      }
    });
    const a = await app(env, {
      clock: testClock('2026-10-27T14:00:00Z'),
      provider: (store) =>
        new ReplayProvider({
          source: store,
          clock: recorder.clock,
          offsetMs: 7 * 86_400_000,
          fallback: recorder.brapi,
        }),
    });
    await instrument(a, 'ABEV3');
    const before = recorder.fetch.calls.length;
    const r = await a.poller.read('ABEV3', 1, null);
    expect(r?.disposition).toBe('ACCEPTED');
    expect(r?.quote.lastPrice).toBe('12.1');
    expect(r?.quote.quoteTime.toString()).toBe('2026-10-27T13:37:00.000Z');
    expect(recorder.fetch.calls.length).toBe(before);
    expect(
      (await outbox(env.db, 'market_data.external_quote_received')).at(-1)!.payload,
    ).toMatchObject({ source: 'replay' });
  });
});

describe('consulta sob demanda (P3, RN-BRP-042/043, RN-BRP-081)', () => {
  it('lê na fonte, serve do cache; com a fonte fora, a última gravada com aviso; ticker inexistente é 404', async () => {
    const a = await app(env);
    a.fetch.set(
      '/v2/stocks/quote?symbols=KLBN11',
      quoteFixture('KLBN11', 21.3, at('2026-10-27T13:37:00Z')),
    );
    const first = await a.http
      .get('/v1/market-data/external-quotes/klbn11')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(first.body).toMatchObject({
      servedFrom: 'PROVIDER',
      quote: { symbol: 'KLBN11', instrumentId: null },
    });
    expect(first.body.quote.quote.lastPrice).toBe('21.3');

    // 30 min depois o cache venceu e a brapi responde 503: a retentativa com backoff passa dos 5 s
    // de espera, e sai a última gravada, com aviso.
    a.clock.advanceTo(at('2026-10-27T14:31:00Z'));
    a.fetch.set('/v2/stocks/quote?symbols=KLBN11', loadFixture('error-503'));
    const fallback = await a.http
      .get('/v1/market-data/external-quotes/KLBN11')
      .set(bearer(a.tokens.customer))
      .expect(200);
    expect(fallback.body).toMatchObject({ servedFrom: 'STORED' });
    expect(fallback.body.warning).toMatch(/última cotação disponível/);

    const missing = await a.http
      .get('/v1/market-data/external-quotes/ZZZZ3')
      .set(bearer(a.tokens.customer))
      .expect(404);
    expect(missing.body.code).toBe('QUOTE_NOT_FOUND');
  });
});
