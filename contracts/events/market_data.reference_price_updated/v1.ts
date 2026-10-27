import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const MarketDataReferencePriceUpdatedV1 = defineEvent({
  eventType: 'market_data.reference_price_updated',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    /** Crescente por instrumento: o consumidor descarta o que já viu. */
    seq: Type.Integer({ minimum: 1 }),
    /** 4 casas; o tick é aplicado só pelo FMS (RN-SYN-003). */
    price: Type.String({ pattern: '^\\d+\\.\\d{4}$' }),
    origin: Type.Union(
      ['BRAPI', 'GLIDE', 'SYNTHETIC_NOISE', 'SANDBOX_MODEL', 'MANUAL'].map((o) => Type.Literal(o)),
    ),
    anchorPrice: Type.String({ pattern: '^\\d+\\.\\d{4}$' }),
    externalQuoteTime: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /** Instante do valor no tempo do ambiente (o mesmo na reprodução do dia). */
    at: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: MarketDataReferencePriceUpdatedV1,
  producer: 'market-data-service',
  context: 'market-data',
  consumers: ['market-maker-service', 'risk-service', 'trading-session-service'],
  summary:
    'Preço de referência: âncora real com glide e ruído semeado só no contínuo, ou override manual (Brapi §8, RN-SYN-001..004/006).',
});
