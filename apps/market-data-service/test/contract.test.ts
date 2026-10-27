import { createLogger } from '@broker/service-kit';
import { testClock } from '@broker/testing';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  asResponse,
  fixtureFetch,
  loadFixture,
  loadFixtures,
  type BrapiFixture,
} from '../src/adapters/brapi/fixtures.js';
import { BrapiProvider, type FetchLike } from '../src/adapters/brapi/provider.js';
import { StaticTokenSource } from '../src/adapters/brapi/tokens.js';
import { ProviderError, type ProviderErrorKind } from '../src/application/provider.js';

const clock = testClock('2026-10-27T13:00:00Z');
const silent = () => new Writable({ write: (_c, _e, cb) => cb() });
const logger = createLogger({
  service: 'market-data-service',
  environment: 'test',
  version: '0',
  level: 'fatal',
  clock,
  destination: silent(),
});

/** Serve sempre a mesma fixture e guarda o que foi pedido. */
function serving(f: BrapiFixture) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return asResponse(f);
  };
  return { fetch, calls };
}

const provider = (fetch: FetchLike, tokens: string[] = ['tok-a']) =>
  new BrapiProvider({
    baseUrl: 'https://brapi.dev/api',
    tokens: new StaticTokenSource(tokens),
    tokenlessSymbols: ['PETR4', 'MGLU3', 'VALE3', 'ITUB4'],
    capabilities: {
      symbolsPerRequest: 1,
      maxHistoryRange: '3mo',
      allowedIntervals: ['1d'],
      dividends: false,
      metered: true,
    },
    clock,
    logger,
    fetch,
  });

/** Nomes de campo da brapi que não podem passar da ACL (RN-BRP-002). */
const BRAPI_FIELDS =
  /regularMarket|fiftyTwoWeek|logourl|historicalDataPrice|requestedAt|usageWindow|remainingUsage/;

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error('esperava falha');
}

describe('contrato do adaptador brapi com as fixtures gravadas (RN-BRP-002/003, RN-BRP-100, RN-QA-022)', () => {
  it('as fixtures têm origem, data e requisição; as gravadas vieram da brapi real', () => {
    const all = loadFixtures();
    expect(all.length).toBeGreaterThanOrEqual(20);
    for (const f of all) {
      expect(['recorded', 'synthetic']).toContain(f.origin);
      expect(f.request.path).toMatch(/^\/v2\//);
    }
    expect(all.filter((f) => f.origin === 'recorded').length).toBeGreaterThanOrEqual(6);
  });

  it('E2 sucesso: PETR4 normalizada para external_quote, sem token (ticker de teste)', async () => {
    const s = serving(loadFixture('quote-petr4'));
    const { value, raw } = await provider(s.fetch).getQuote('PETR4');
    expect(value).toMatchObject({
      symbol: 'PETR4',
      requestedSymbol: 'PETR4',
      changed: false,
      lastPrice: '53.88',
      open: '51.2',
      high: '54.23',
      low: '51.17',
      previousClose: '58.68',
      change: '-4.8',
      changePercent: '-8.18',
      volume: '141338400',
      marketCap: '738658540249',
      week52Low: '29.53',
      week52High: '59.79',
      currency: 'BRL',
      logoUrl: 'https://icons.brapi.dev/icons/PETR4.svg',
    });
    expect(value.quoteTime.toString()).toBe('2026-10-27T12:37:30.000Z');
    expect(JSON.stringify(value)).not.toMatch(BRAPI_FIELDS);
    expect(raw.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(raw.deprecation).toBeNull();
    expect(s.calls[0]!.url).toBe('https://brapi.dev/api/v2/stocks/quote?symbols=PETR4');
    expect(s.calls[0]!.headers['Authorization']).toBeUndefined();
  });

  it('E2 com token para ticker fora da lista de teste', async () => {
    const s = serving(loadFixture('quote-petr4'));
    await provider(s.fetch)
      .getQuote('BBAS3')
      .catch(() => undefined);
    expect(s.calls[0]!.headers['Authorization']).toBe('Bearer tok-a');
  });

  it('E2 changed=true: ticker antigo devolvido com o atual (RN-INS-033)', async () => {
    const { value } = await provider(serving(loadFixture('quote-changed-elet3')).fetch).getQuote(
      'ELET3',
    );
    expect(value).toMatchObject({ requestedSymbol: 'ELET3', symbol: 'AXIA3', changed: true });
  });

  it('E2 com nulos: só preço e horário obrigatórios', async () => {
    const { value } = await provider(serving(loadFixture('quote-nulls-mglu3')).fetch).getQuote(
      'MGLU3',
    );
    expect(value).toMatchObject({
      lastPrice: '9.87',
      open: null,
      high: null,
      low: null,
      previousClose: null,
      volume: null,
      marketCap: null,
      logoUrl: null,
      longName: null,
    });
  });

  it('Ibovespa (^BVSP) pelo mesmo endpoint', async () => {
    const { value } = await provider(serving(loadFixture('quote-ibovespa')).fetch).getQuote(
      '^BVSP',
    );
    expect(value).toMatchObject({ symbol: '^BVSP', lastPrice: '146512' });
  });

  it.each<[string, ProviderErrorKind, Partial<ProviderError['details']>]>([
    ['error-400', 'BAD_REQUEST', { status: 400 }],
    ['error-401', 'UNAUTHORIZED', { status: 401 }],
    ['error-403', 'FORBIDDEN', { status: 403 }],
    ['error-404', 'NOT_FOUND', { status: 404 }],
    ['error-429-quota', 'RATE_LIMITED', { status: 429, quota: true, retryAfterMs: 3_600_000 }],
    ['error-429-concurrency', 'RATE_LIMITED', { status: 429, quota: false, retryAfterMs: 2000 }],
    ['error-500', 'SERVER_ERROR', { status: 500 }],
    ['error-503', 'SERVER_ERROR', { status: 503 }],
    ['invalid-body', 'INVALID_BODY', { status: 200 }],
    ['invalid-schema', 'INVALID_BODY', { status: 200 }],
  ])('Brapi §10: %s → %s', async (name, kind, details) => {
    const err = await failure(provider(serving(loadFixture(name)).fetch).getQuote('BBAS3'));
    expect(err.kind).toBe(kind);
    expect(err.details).toMatchObject(details);
    expect(err.details.raw?.body).toBeDefined();
    expect(err.transient).toBe(kind === 'SERVER_ERROR');
  });

  it('timeout de 10 s vira TIMEOUT (tratado como 5xx)', async () => {
    const slow: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      );
    const p = new BrapiProvider({
      baseUrl: 'https://brapi.dev/api',
      tokens: new StaticTokenSource([]),
      tokenlessSymbols: ['PETR4'],
      capabilities: provider(slow).capabilities(),
      clock,
      logger,
      fetch: slow,
      timeoutMs: 20,
    });
    const err = await failure(p.getQuote('PETR4'));
    expect(err.kind).toBe('TIMEOUT');
    expect(err.transient).toBe(true);
  });

  it('E1 catálogo: tipos suportados, fundos fora do modelo ignorados, paginação', async () => {
    const fetch = fixtureFetch();
    const p = provider(fetch);
    const page1 = (await p.listInstruments(1, 2000)).value;
    const page2 = (await p.listInstruments(2, 2000)).value;
    expect(page1.hasNextPage).toBe(true);
    expect(page2.hasNextPage).toBe(false);
    expect(page1.entries.map((e) => [e.symbol, e.assetType])).toEqual([
      ['BBAS3', 'STOCK'],
      ['B3SA3', 'STOCK'],
      ['BBDC4', 'STOCK'],
      ['BPAC11', 'UNIT'],
      ['MXRF11', 'REIT'],
    ]);
    expect(page1.skipped).toBe(1);
    expect(page2.entries.map((e) => e.assetType)).toEqual([
      'STOCK',
      'STOCK',
      'STOCK',
      'ETF',
      'BDR',
    ]);
    expect(page2.skipped).toBe(1);
    expect(page1.indexes).toContainEqual({ symbol: '^BVSP', name: 'IBOVESPA' });
    expect(JSON.stringify(page1)).not.toMatch(/subType|isActive/);
  });

  it('E3 histórico: data em segundos Unix → data de São Paulo, em ordem', async () => {
    const { value } = await provider(fixtureFetch()).getDailyHistory('PETR4', '3mo');
    expect(value.map((c) => c.date.toString())).toEqual(['2026-10-22', '2026-10-23', '2026-10-26']);
    expect(value[2]).toMatchObject({ close: '53.88', adjustedClose: '53.88', volume: '141338400' });
  });

  it('E6 resolve: renomeação com data efetiva', async () => {
    const { value } = await provider(fixtureFetch()).resolveSymbols(['PETR4', 'ELET3']);
    expect(value).toEqual([
      {
        requestedSymbol: 'PETR4',
        symbol: 'PETR4',
        status: 'ACTIVE',
        effectiveDate: null,
        conversionRatio: null,
      },
      {
        requestedSymbol: 'ELET3',
        symbol: 'AXIA3',
        status: 'RENAMED',
        effectiveDate: '2025-11-10',
        conversionRatio: null,
      },
    ]);
  });

  it('E9 uso: janela do ciclo de cobrança', async () => {
    const { value } = await provider(fixtureFetch()).getUsage();
    expect(value).toMatchObject({ planLimit: 15_000, currentUsage: 4200, remaining: 10_800 });
    expect(value!.window.type).toBe('BILLING_CYCLE');
    expect(value!.window.end.toString()).toBe('2026-11-10T00:00:00.000Z');
  });

  it('fixtures: pedido sem fixture responde 404 da brapi, sem rede', async () => {
    const err = await failure(provider(fixtureFetch()).getQuote('ZZZZ3'));
    expect(err.kind).toBe('NOT_FOUND');
  });

  it('RN-BRP-094: 401 com o token atual tenta o próximo e passa a preferi-lo', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      calls.push(init.headers['Authorization'] ?? '');
      return asResponse(
        init.headers['Authorization'] === 'Bearer novo'
          ? loadFixture('quote-petr4')
          : loadFixture('error-401'),
      );
    };
    const p = provider(fetch, ['antigo', 'novo']);
    await p.getQuote('BBAS3').catch(() => undefined);
    await p.getQuote('BBAS3').catch(() => undefined);
    expect(calls).toEqual(['Bearer antigo', 'Bearer novo', 'Bearer novo']);
  });
});
