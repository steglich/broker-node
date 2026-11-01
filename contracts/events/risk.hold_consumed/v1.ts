import { defineEvent } from '@broker/messaging';
import { defineEventContract } from '../../src/define.js';
import { HoldEventPayload } from '../../src/schemas/risk.js';

export const RiskHoldConsumedV1 = defineEvent({
  eventType: 'risk.hold_consumed',
  eventVersion: 1,
  payload: HoldEventPayload,
});

export default defineEventContract({
  definition: RiskHoldConsumedV1,
  producer: 'risk-service',
  consumers: ['ledger-service', 'realtime-gateway'],
  summary:
    'Reserva consumida: ordem totalmente executada ou saque concluído (RN-HLD-004, RN-LED-032).',
});
