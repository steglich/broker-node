import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { SessionScope } from '../../src/schemas/session.js';

export const SessionHaltEndedV1 = defineEvent({
  eventType: 'session.halt_ended',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    haltId: Type.String({ format: 'uuid' }),
    scope: SessionScope,
    reasonCode: Type.String(),
  }),
});

export default defineEventContract({
  definition: SessionHaltEndedV1,
  producer: 'trading-session-service',
  consumers: [
    'oms-service',
    'market-maker-service',
    'market-data-service',
    'realtime-gateway',
    'risk-service',
  ],
  summary: 'Fim de uma suspensão; a retomada segue por leilão (RN-HLT-002).',
});
