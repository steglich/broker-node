import { defineEvent } from '@broker/messaging';
import { defineEventContract } from '../../src/define.js';
import { InstrumentState } from '../../src/schemas/reference.js';

export const InstrumentUpdatedV1 = defineEvent({
  eventType: 'instrument.updated',
  eventVersion: 1,
  payload: InstrumentState,
});

export default defineEventContract({
  definition: InstrumentUpdatedV1,
  producer: 'reference-data-service',
  context: 'reference',
  consumers: [
    'market-data-service',
    'oms-service',
    'risk-service',
    'custody-service',
    'engagement-service',
  ],
  summary: 'Instrumento alterado; traz o estado completo para a cópia local dos consumidores.',
});
