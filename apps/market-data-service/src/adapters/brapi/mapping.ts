// Camada anticorrupção da brapi (RN-BRP-002, Brapi §9.1): os nomes de campo da brapi existem só
// neste arquivo. Cada resposta é conferida contra o esquema da v2 antes do mapeamento; o que não
// bate vira INVALID_BODY (não repetir na hora, registrar o corpo bruto, Brapi §10).
import { BusinessDate, Decimal, Instant } from '@broker/domain-kernel';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import Type, { type Static, type TSchema } from 'typebox';
import type { ProviderUsage } from '../../domain/budget.js';
import type { ExternalQuote } from '../../domain/quote.js';
import {
  ProviderError,
  type CatalogEntry,
  type CatalogPage,
  type DailyCandle,
  type SymbolResolution,
} from '../../application/provider.js';

const Num = Type.Union([Type.Number(), Type.Null()]);
const OptNum = Type.Optional(Num);
const OptText = Type.Optional(Type.Union([Type.String(), Type.Null()]));

const QuoteData = Type.Object({
  shortName: OptText,
  longName: OptText,
  currency: OptText,
  regularMarketPrice: OptNum,
  regularMarketDayHigh: OptNum,
  regularMarketDayLow: OptNum,
  regularMarketChange: OptNum,
  regularMarketChangePercent: OptNum,
  regularMarketTime: OptText,
  marketCap: OptNum,
  regularMarketVolume: OptNum,
  regularMarketPreviousClose: OptNum,
  regularMarketOpen: OptNum,
  fiftyTwoWeekLow: OptNum,
  fiftyTwoWeekHigh: OptNum,
  logourl: OptText,
});

export const QuoteResponse = Type.Object({
  results: Type.Array(
    Type.Object({
      requestedSymbol: Type.String(),
      symbol: Type.String(),
      changed: Type.Optional(Type.Boolean()),
      data: Type.Union([QuoteData, Type.Null()]),
    }),
  ),
});

export const TickersResponse = Type.Object({
  results: Type.Array(
    Type.Object({
      symbol: Type.String(),
      name: OptText,
      longName: OptText,
      assetType: OptText,
      subType: OptText,
      sector: OptText,
      logoUrl: OptText,
      isActive: Type.Optional(Type.Boolean()),
    }),
  ),
  indexes: Type.Optional(
    Type.Array(Type.Object({ symbol: Type.String(), name: OptText, assetType: OptText })),
  ),
  pagination: Type.Object({ hasNextPage: Type.Boolean() }),
});

export const HistoricalResponse = Type.Object({
  results: Type.Array(
    Type.Object({
      symbol: Type.String(),
      data: Type.Object({
        historicalDataPrice: Type.Array(
          Type.Object({
            /** Unix timestamp em segundos (Brapi §3). */
            date: Type.Number(),
            open: Num,
            high: Num,
            low: Num,
            close: Num,
            volume: OptNum,
            adjustedClose: OptNum,
          }),
        ),
      }),
    }),
  ),
});

export const ResolveResponse = Type.Object({
  results: Type.Array(
    Type.Object({
      requestedSymbol: Type.String(),
      symbol: Type.String(),
      status: Type.String(),
      effectiveDate: OptText,
      conversionRatio: OptNum,
    }),
  ),
});

export const UsageResponse = Type.Object({
  planName: OptText,
  planLimit: Type.Number(),
  currentUsage: Type.Number(),
  remainingUsage: Type.Number(),
  usageWindow: Type.Object({
    type: Type.String(),
    start: Type.String(),
    end: Type.String(),
  }),
});

// Tolerant reader: campos novos da brapi são ignorados; só o que o mapeamento usa é conferido.
const ajv = new Ajv2020({ allErrors: false, strict: false });
const compiled = new WeakMap<object, ValidateFunction>();

/** Confere o corpo contra o esquema; fora dele, INVALID_BODY. */
export function parseBody<T extends TSchema>(
  schema: T,
  body: unknown,
  endpoint: string,
): Static<T> {
  let check = compiled.get(schema);
  if (!check) {
    check = ajv.compile(schema as object);
    compiled.set(schema, check);
  }
  if (!check(body)) {
    const first = check.errors?.[0];
    throw new ProviderError(
      'INVALID_BODY',
      `${endpoint}: corpo fora do esquema esperado (${first?.instancePath || '/'} ${first?.message ?? ''})`.trim(),
    );
  }
  return body as Static<T>;
}

/** Número JSON → decimal em texto, sem notação exponencial. */
const dec = (v: number | null | undefined): string | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : new Decimal(String(v)).toFixed();

/** `2026-10-27T12:37:30.000Z` (ou com offset) → Instant em UTC. */
function instantOf(iso: string): Instant {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms))
    throw new ProviderError('INVALID_BODY', `regularMarketTime inválido: ${iso}`);
  return Instant.ofEpochMillis(ms);
}

/**
 * E2 → `external_quote` (Brapi §9.1): `last_price > 0` e `quote_time` obrigatórios, moeda `BRL`
 * (outra moeda rejeita), volume ≥ 0; os demais campos podem vir nulos.
 */
export function mapQuote(body: unknown, requested: string): ExternalQuote {
  const parsed = parseBody(QuoteResponse, body, 'stocks/quote');
  const r = parsed.results.find((x) => x.requestedSymbol === requested) ?? parsed.results[0];
  if (!r || !r.data) throw new ProviderError('NOT_FOUND', `sem cotação para ${requested}`);
  const d = r.data;
  const last = dec(d.regularMarketPrice);
  if (last === null || !new Decimal(last).gt(0))
    throw new ProviderError('INVALID_BODY', `${requested}: preço ausente ou não positivo`);
  if (!d.regularMarketTime)
    throw new ProviderError('INVALID_BODY', `${requested}: horário da cotação ausente`);
  const currency = d.currency ?? 'BRL';
  if (currency !== 'BRL')
    throw new ProviderError('INVALID_BODY', `${requested}: moeda ${currency} não suportada`);
  const volume = dec(d.regularMarketVolume);
  if (volume !== null && new Decimal(volume).lt(0))
    throw new ProviderError('INVALID_BODY', `${requested}: volume negativo`);
  return {
    symbol: r.symbol,
    requestedSymbol: r.requestedSymbol,
    changed: r.changed ?? r.symbol !== r.requestedSymbol,
    lastPrice: last,
    quoteTime: instantOf(d.regularMarketTime),
    open: dec(d.regularMarketOpen),
    high: dec(d.regularMarketDayHigh),
    low: dec(d.regularMarketDayLow),
    previousClose: dec(d.regularMarketPreviousClose),
    change: dec(d.regularMarketChange),
    changePercent: dec(d.regularMarketChangePercent),
    volume,
    marketCap: dec(d.marketCap),
    week52Low: dec(d.fiftyTwoWeekLow),
    week52High: dec(d.fiftyTwoWeekHigh),
    currency: 'BRL',
    shortName: d.shortName ?? null,
    longName: d.longName ?? null,
    logoUrl: d.logourl ?? null,
  };
}

/** `subType` da brapi → tipo do instrumento (Ativos §2.2). Os demais fundos ficam de fora. */
const ASSET_TYPES: Record<string, CatalogEntry['assetType']> = {
  stock: 'STOCK',
  unit: 'UNIT',
  fii: 'REIT',
  etf: 'ETF',
  bdr: 'BDR',
};
const TICKER = /^[A-Z][A-Z0-9]{3,5}\d{1,2}$/;

/** E1 → catálogo. Só ativos ativos, de tipo suportado e com ticker no padrão da B3. */
export function mapCatalog(body: unknown): CatalogPage {
  const parsed = parseBody(TickersResponse, body, 'tickers');
  const entries: CatalogEntry[] = [];
  let skipped = 0;
  for (const t of parsed.results) {
    const type = ASSET_TYPES[t.subType ?? t.assetType ?? ''];
    if (!type || t.isActive === false || !TICKER.test(t.symbol)) {
      skipped++;
      continue;
    }
    entries.push({
      symbol: t.symbol,
      shortName: t.name ?? null,
      longName: t.longName ?? null,
      assetType: type,
      sector: t.sector ?? null,
      logoUrl: t.logoUrl ?? null,
    });
  }
  return {
    entries,
    indexes: (parsed.indexes ?? []).map((i) => ({ symbol: i.symbol, name: i.name ?? i.symbol })),
    skipped,
    hasNextPage: parsed.pagination.hasNextPage,
  };
}

/** E3 → candles diários. `date` em segundos Unix; a data é a de São Paulo. */
export function mapHistory(body: unknown, requested: string): DailyCandle[] {
  const parsed = parseBody(HistoricalResponse, body, 'stocks/historical');
  const r = parsed.results[0];
  if (!r) throw new ProviderError('NOT_FOUND', `sem histórico para ${requested}`);
  const out: DailyCandle[] = [];
  for (const p of r.data.historicalDataPrice) {
    const [open, high, low, close] = [dec(p.open), dec(p.high), dec(p.low), dec(p.close)];
    if (open === null || high === null || low === null || close === null) continue;
    out.push({
      date: Instant.ofEpochMillis(Math.round(p.date * 1000)).businessDate(),
      open,
      high,
      low,
      close,
      adjustedClose: dec(p.adjustedClose),
      volume: dec(p.volume) ?? '0',
    });
  }
  return out.sort((a, b) => a.date.compare(b.date));
}

/** E6 → resolução de tickers (RN-INS-030..033). */
export function mapResolve(body: unknown): SymbolResolution[] {
  const parsed = parseBody(ResolveResponse, body, 'tickers/resolve');
  return parsed.results.map((r) => ({
    requestedSymbol: r.requestedSymbol,
    symbol: r.symbol,
    status: r.status.toLowerCase() === 'renamed' ? 'RENAMED' : 'ACTIVE',
    effectiveDate: r.effectiveDate
      ? BusinessDate.parse(r.effectiveDate.slice(0, 10)).toString()
      : null,
    conversionRatio: dec(r.conversionRatio),
  }));
}

/** E9 → uso da cota (RN-BRP-030). */
export function mapUsage(body: unknown): ProviderUsage {
  const u = parseBody(UsageResponse, body, 'user/usage');
  return {
    planName: u.planName ?? null,
    planLimit: u.planLimit,
    currentUsage: u.currentUsage,
    remaining: u.remainingUsage,
    window: {
      type: /billing/i.test(u.usageWindow.type) ? 'BILLING_CYCLE' : 'ROLLING_30D',
      start: instantOf(u.usageWindow.start),
      end: instantOf(u.usageWindow.end),
    },
  };
}
