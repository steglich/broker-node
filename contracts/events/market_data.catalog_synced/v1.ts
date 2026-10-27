import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Text = Type.Optional(Type.Union([Type.String(), Type.Null()]));

export const MarketDataCatalogSyncedV1 = defineEvent({
  eventType: 'market_data.catalog_synced',
  eventVersion: 1,
  payload: Type.Object({
    /** Tickers novos desde a última sincronização, já normalizados pela ACL da brapi. */
    newSymbols: Type.Array(
      Type.Object({
        symbol: Type.String({ pattern: '^[A-Z][A-Z0-9]{3,5}\\d{1,2}$' }),
        shortName: Text,
        longName: Text,
        /** Ausente: o reference-data deduz pelo sufixo do ticker. */
        assetType: Type.Optional(
          Type.Union(['STOCK', 'UNIT', 'REIT', 'ETF', 'BDR'].map((t) => Type.Literal(t))),
        ),
        sector: Text,
        logoUrl: Text,
      }),
    ),
    /** Tickers que saíram do catálogo da fonte. */
    inactiveSymbols: Type.Array(Type.String()),
    syncedAt: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: MarketDataCatalogSyncedV1,
  producer: 'market-data-service',
  context: 'market-data',
  consumers: ['reference-data-service'],
  summary: 'Catálogo diário de tickers da brapi sincronizado (RN-INS-010).',
});
