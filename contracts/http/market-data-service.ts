import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
const Dec = Type.String({ pattern: '^-?\\d+(\\.\\d+)?$' });
const OptDec = Type.Union([Dec, Type.Null()]);
const DateTime = Type.String({ format: 'date-time' });
const Date_ = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Symbol_ = Type.Object({ symbol: Type.String({ pattern: '^\\^?[A-Za-z0-9.]{2,12}$' }) });
const Level = Type.Union(['NORMAL', 'SAVING', 'CRITICAL', 'EXHAUSTED'].map((l) => Type.Literal(l)));

export const ExternalQuote = Type.Object({
  symbol: Type.String(),
  instrumentId: Type.Union([Uuid, Type.Null()]),
  kind: Type.Union([Type.Literal('INSTRUMENT'), Type.Literal('INDEX')]),
  quote: Type.Object({
    symbol: Type.String(),
    requestedSymbol: Type.String(),
    changed: Type.Boolean(),
    lastPrice: Dec,
    quoteTime: DateTime,
    open: OptDec,
    high: OptDec,
    low: OptDec,
    previousClose: OptDec,
    change: OptDec,
    changePercent: OptDec,
    volume: OptDec,
    marketCap: OptDec,
    week52Low: OptDec,
    week52High: OptDec,
    currency: Type.Literal('BRL'),
    shortName: Type.Union([Type.String(), Type.Null()]),
    longName: Type.Union([Type.String(), Type.Null()]),
    logoUrl: Type.Union([Type.String(), Type.Null()]),
  }),
  fetchedAt: DateTime,
  provider: Type.String(),
  stale: Type.Boolean(),
  staleSince: Type.Union([DateTime, Type.Null()]),
});

const Candle = Type.Object({
  date: Date_,
  open: Dec,
  high: Dec,
  low: Dec,
  close: Dec,
  adjustedClose: OptDec,
  volume: Dec,
  /** `HISTORY` (E3) ou `CLOSE_SNAPSHOT` (leitura das 18:00, RN-BRP-062). */
  source: Type.String(),
});

const Alert = Type.Object({
  id: Uuid,
  kind: Type.String(),
  severity: Type.Union(['INFO', 'WARNING', 'CRITICAL'].map((s) => Type.Literal(s))),
  message: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
  createdAt: DateTime,
});

export const marketDataServiceHttp = defineHttpContract({
  service: 'market-data-service',
  title: 'market-data-service',
  version: '1.0.0',
  routes: {
    // ------------------------------------------------------------ consulta
    externalQuote: {
      method: 'get',
      path: '/v1/market-data/external-quotes/:symbol',
      summary:
        'Cotação externa de qualquer ticker (P3): cache de 30 min, fila coalescida com espera de 5 s e, se a fonte demorar, a última gravada com aviso (RN-BRP-042/043, RN-BRP-006).',
      auth: 'user',
      params: Symbol_,
      responses: {
        200: {
          description: 'Cotação, de onde veio e a atribuição "Fonte: brapi.dev".',
          body: Type.Object({
            quote: ExternalQuote,
            servedFrom: Type.Union(['PROVIDER', 'CACHE', 'STORED'].map((s) => Type.Literal(s))),
            attribution: Type.String(),
            warning: Type.Optional(Type.String()),
          }),
        },
        404: { description: 'QUOTE_NOT_FOUND: a fonte não tem o ticker.' },
        503: { description: 'QUOTE_UNAVAILABLE: sem cotação gravada e a fonte indisponível.' },
      },
    },
    externalQuotes: {
      method: 'get',
      path: '/v1/market-data/external-quotes',
      summary:
        'Cotações externas em lote (até 50 tickers, para os BFFs sem N+1): cada item é a cotação ou o erro daquele ticker.',
      auth: 'user',
      query: Type.Object({
        symbols: Type.String({
          pattern: '^\\^?[A-Za-z0-9.]{2,12}(,\\^?[A-Za-z0-9.]{2,12}){0,49}$',
        }),
      }),
      responses: {
        200: {
          description: 'Na ordem pedida, sem repetidos.',
          body: Type.Object({
            items: Type.Array(
              Type.Union([
                Type.Object({
                  symbol: Type.String(),
                  quote: ExternalQuote,
                  servedFrom: Type.Union(
                    ['PROVIDER', 'CACHE', 'STORED'].map((s) => Type.Literal(s)),
                  ),
                  attribution: Type.String(),
                  warning: Type.Optional(Type.String()),
                }),
                Type.Object({
                  symbol: Type.String(),
                  error: Type.Object({ code: Type.String(), message: Type.String() }),
                }),
              ]),
            ),
          }),
        },
      },
    },
    dailyHistory: {
      method: 'get',
      path: '/v1/market-data/history/:symbol',
      summary: 'Candles diários externos (E3, cache de 24 h; em SAVING só o gravado).',
      auth: 'user',
      params: Symbol_,
      query: Type.Object({ from: Type.Optional(Date_), to: Type.Optional(Date_) }),
      responses: {
        200: {
          description: 'Candles em ordem de data.',
          body: Type.Object({
            symbol: Type.String(),
            items: Type.Array(Candle),
            fetchedAt: Type.Union([DateTime, Type.Null()]),
            fromCache: Type.Boolean(),
            attribution: Type.String(),
            warning: Type.Optional(Type.String()),
          }),
        },
      },
    },
    referencePrice: {
      method: 'get',
      path: '/v1/market-data/reference-prices/:instrumentId',
      summary: 'Último preço de referência publicado do instrumento (Brapi §8).',
      auth: 'user',
      params: Type.Object({ instrumentId: Uuid }),
      responses: {
        200: {
          description: 'Referência.',
          body: Type.Object({
            instrumentId: Uuid,
            price: Type.Union([Type.String(), Type.Null()]),
            origin: Type.Union([Type.String(), Type.Null()]),
            anchorPrice: Type.String(),
            externalQuoteTime: Type.Union([DateTime, Type.Null()]),
            seq: Type.Integer(),
            tradingDate: Date_,
            noiseEnabled: Type.Boolean(),
          }),
        },
        404: { description: 'REFERENCE_NOT_FOUND.' },
      },
    },

    // ------------------------------------------------------------ backoffice
    providerState: {
      method: 'get',
      path: '/v1/bo/market-data/provider',
      summary:
        'Painel do provedor: orçamento (nível, restante, projeção), disjuntor, fila por prioridade e liderança (Brapi §11).',
      auth: 'user',
      responses: {
        200: {
          description: 'Estado.',
          body: Type.Object({
            provider: Type.String(),
            leader: Type.Boolean(),
            budget: Type.Object({
              level: Level,
              metered: Type.Boolean(),
              remaining: Type.Union([Type.Integer(), Type.Null()]),
              reserve: Type.Union([Type.Integer(), Type.Null()]),
              businessDayBudget: Type.Union([Type.Integer(), Type.Null()]),
              nonBusinessDayBudget: Type.Union([Type.Integer(), Type.Null()]),
              projectedExhaustion: Type.Union([DateTime, Type.Null()]),
              planLimit: Type.Union([Type.Integer(), Type.Null()]),
              windowEnd: Type.Union([DateTime, Type.Null()]),
              usageReadAt: Type.Union([DateTime, Type.Null()]),
            }),
            circuit: Type.Union(['CLOSED', 'OPEN', 'HALF_OPEN'].map((s) => Type.Literal(s))),
            queueDepth: Type.Record(Type.String(), Type.Integer()),
            staleInstruments: Type.Integer(),
          }),
        },
      },
    },
    providerAlerts: {
      method: 'get',
      path: '/v1/bo/market-data/alerts',
      summary:
        'Alertas do provedor (401, cota, quarentena, descontinuação, esquema), do mais novo.',
      auth: 'user',
      query: Type.Object({ limit: Type.Optional(Type.String({ pattern: '^\\d+$' })) }),
      responses: {
        200: { description: 'Alertas.', body: Type.Object({ items: Type.Array(Alert) }) },
      },
    },
    createReferenceOverride: {
      method: 'post',
      path: '/v1/bo/market-data/reference-overrides',
      summary: 'Fixa o preço de referência por um período (origin = MANUAL, RN-SYN-006).',
      auth: 'user',
      idempotent: true,
      body: Type.Object({
        instrumentId: Uuid,
        price: Type.String({ pattern: '^\\d+(\\.\\d{1,4})?$' }),
        durationMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
        reason: Type.String({ minLength: 3, maxLength: 500 }),
      }),
      responses: {
        201: {
          description: 'Override criado.',
          body: Type.Object({
            overrideId: Uuid,
            instrumentId: Uuid,
            price: Type.String(),
            validFrom: DateTime,
            validUntil: DateTime,
          }),
        },
        404: { description: 'INSTRUMENT_NOT_FOUND.' },
        422: { description: 'NOT_TRADABLE: só o universo negociável tem referência.' },
      },
    },
    setReferenceNoise: {
      method: 'put',
      path: '/v1/bo/market-data/reference-noise/:instrumentId',
      summary: 'Liga ou desliga o ruído sintético de um instrumento (RN-SYN-004).',
      auth: 'user',
      params: Type.Object({ instrumentId: Uuid }),
      body: Type.Object({ enabled: Type.Boolean() }),
      responses: {
        200: {
          description: 'Configurado.',
          body: Type.Object({ instrumentId: Uuid, enabled: Type.Boolean() }),
        },
      },
    },
    clearAuthBlock: {
      method: 'post',
      path: '/v1/bo/market-data/provider/auth-block/clear',
      summary:
        'Libera as requisições autenticadas depois de um 401 (após trocar o token, RN-BRP-094).',
      auth: 'user',
      responses: { 204: { description: 'Liberado.' } },
    },
  },
});

export default marketDataServiceHttp;
