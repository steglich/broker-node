import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const MarketDataSymbolRenameDetectedV1 = defineEvent({
  eventType: 'market_data.symbol_rename_detected',
  eventVersion: 1,
  payload: Type.Object({
    oldSymbol: Type.String(),
    newSymbol: Type.String(),
    effectiveDate: Type.String({ format: 'date' }),
    /** Razão da conversão; diferente de 1 é evento corporativo (RN-INS-031). */
    conversionRatio: Type.Optional(Type.String({ pattern: '^\\d+(\\.\\d{1,8})?$' })),
  }),
});

export default defineEventContract({
  definition: MarketDataSymbolRenameDetectedV1,
  producer: 'market-data-service',
  context: 'market-data',
  consumers: ['reference-data-service', 'corporate-actions-service'],
  summary: 'A brapi informou troca de ticker (renames/resolve, RN-INS-030..033).',
});
