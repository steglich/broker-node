import { defineEvent } from '@broker/messaging';
import { defineEventContract } from '../../src/define.js';
import { HoldEventPayload } from '../../src/schemas/risk.js';

export const RiskHoldCreatedV1 = defineEvent({
  eventType: 'risk.hold_created',
  eventVersion: 1,
  payload: HoldEventPayload,
});

export default defineEventContract({
  definition: RiskHoldCreatedV1,
  producer: 'risk-service',
  consumers: ['ledger-service', 'realtime-gateway'],
  summary: 'Reserva criada sobre saldo ou ativo da conta (RN-HLD-001, RN-RSK-001).',
});
