import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const MarketDataInstrumentStaleV1 = defineEvent({
  eventType: 'market_data.instrument_stale',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    /** Instante da última cotação válida. */
    staleSince: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: MarketDataInstrumentStaleV1,
  producer: 'market-data-service',
  context: 'market-data',
  consumers: ['reference-data-service', 'market-maker-service'],
  summary: 'Sem cotação válida além de max_quote_staleness (RN-INS-020, RN-BRP-07x).',
});
