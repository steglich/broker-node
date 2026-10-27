import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const InstrumentSymbolChangedV1 = defineEvent({
  eventType: 'instrument.symbol_changed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    oldSymbol: Type.String(),
    newSymbol: Type.String(),
    effectiveDate: Type.String({ format: 'date' }),
  }),
});

export default defineEventContract({
  definition: InstrumentSymbolChangedV1,
  producer: 'reference-data-service',
  context: 'reference',
  consumers: ['market-data-service', 'oms-service', 'custody-service', 'engagement-service'],
  summary: 'Ticker renomeado; o instrument_id não muda (RN-INS-030).',
});
