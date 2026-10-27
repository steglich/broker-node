import { defineEvent } from '@broker/messaging';
import { defineEventContract } from '../../src/define.js';
import { InstrumentState } from '../../src/schemas/reference.js';

export const InstrumentCreatedV1 = defineEvent({
  eventType: 'instrument.created',
  eventVersion: 1,
  payload: InstrumentState,
});

export default defineEventContract({
  definition: InstrumentCreatedV1,
  producer: 'reference-data-service',
  context: 'reference',
  consumers: [
    'market-data-service',
    'oms-service',
    'risk-service',
    'custody-service',
    'engagement-service',
  ],
  summary: 'Instrumento cadastrado (brapi ou manual), com o estado completo (Ativos §2).',
});
