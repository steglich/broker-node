import Type from 'typebox';

/** Esquemas compartilhados pelos eventos do reference-data-service (Ativos §2, Pregão §3). */

const Rate = Type.String({ pattern: '^\\d+(\\.\\d{1,8})?$' });
const Date_ = Type.String({ format: 'date' });

/** Estado completo do instrumento (`instrument.created`/`instrument.updated`, Catálogo §4). */
export const InstrumentState = Type.Object({
  instrumentId: Type.String({ format: 'uuid' }),
  symbol: Type.String({ pattern: '^[A-Z][A-Z0-9]{3,5}\\d{1,2}$' }),
  /** `symbol + "F"` quando `lotSize > 1`; `null` sem fracionário (RN-INS-002, RN-INS-006). */
  oddLotSymbol: Type.Union([Type.String(), Type.Null()]),
  isin: Type.Union([Type.String(), Type.Null()]),
  shortName: Type.Union([Type.String(), Type.Null()]),
  longName: Type.Union([Type.String(), Type.Null()]),
  assetType: Type.Union(['STOCK', 'UNIT', 'REIT', 'ETF', 'BDR'].map((t) => Type.Literal(t))),
  shareClass: Type.String(),
  sector: Type.Union([Type.String(), Type.Null()]),
  subsector: Type.Union([Type.String(), Type.Null()]),
  currency: Type.Literal('BRL'),
  lotSize: Type.Integer({ minimum: 1 }),
  tickSize: Rate,
  oddLotEnabled: Type.Boolean(),
  shortSaleEnabled: Type.Boolean(),
  dayTradeEnabled: Type.Boolean(),
  collateralEligible: Type.Boolean(),
  /** Fração (0,30 = 30%); `null` quando não é garantia. */
  haircut: Type.Union([Rate, Type.Null()]),
  taxCategory: Type.Union(['STOCK', 'REIT', 'ETF_EQUITY', 'BDR'].map((t) => Type.Literal(t))),
  status: Type.Union(['PENDING', 'ACTIVE', 'SUSPENDED', 'DELISTED'].map((t) => Type.Literal(t))),
  tradable: Type.Boolean(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  source: Type.Union([Type.Literal('BRAPI'), Type.Literal('MANUAL')]),
  updatedAt: Type.String({ format: 'date-time' }),
});

/** Parâmetros de negociação (Ativos §7); percentuais como fração (0,20 = 20%). */
export const TradingRulesValues = Type.Object({
  rejectionBandPct: Rate,
  staticAuctionBandPct: Rate,
  dynamicAuctionBandPct: Rate,
  volatilityAuctionDurationS: Type.Integer({ minimum: 1 }),
  volatilityAuctionExtensionS: Type.Integer({ minimum: 0 }),
  auctionRandomEndMaxS: Type.Integer({ minimum: 0 }),
  maxOrderQuantity: Type.Integer({ minimum: 1 }),
  maxOrderNotional: Type.String({ pattern: '^\\d+(\\.\\d{1,2})?$' }),
  marketProtectionPct: Rate,
  smmSpreadBps: Type.Integer({ minimum: 1 }),
});

/** Dados do calendário como o `@broker/calendar` os lê (D15): base da cópia local. */
export const CalendarDataSchema = Type.Object({
  coverage: Type.Object({ from: Date_, to: Date_ }),
  days: Type.Array(
    Type.Object({
      date: Date_,
      type: Type.Union(['HOLIDAY', 'NO_TRADING', 'LATE_OPEN'].map((t) => Type.Literal(t))),
      description: Type.String(),
    }),
  ),
  schedules: Type.Array(
    Type.Object({
      validFrom: Date_,
      validTo: Type.Union([Date_, Type.Null()]),
      dayType: Type.Union([Type.Literal('BUSINESS_DAY'), Type.Literal('LATE_OPEN')]),
      phases: Type.Array(
        Type.Object({
          phase: Type.Union(
            [
              'PRE_TRADING',
              'PRE_OPENING',
              'CONTINUOUS',
              'CLOSING_CALL',
              'POST_CLOSE',
              'CLOSED',
            ].map((p) => Type.Literal(p)),
          ),
          start: Type.String({ pattern: '^\\d{2}:\\d{2}$' }),
        }),
      ),
    }),
  ),
  allDaysBusiness: Type.Optional(Type.Boolean()),
});
