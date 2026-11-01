import { defineEvent } from '@broker/messaging';
import { defineEventContract } from '../../src/define.js';
import { HoldEventPayload } from '../../src/schemas/risk.js';

export const RiskHoldAdjustedV1 = defineEvent({
  eventType: 'risk.hold_adjusted',
  eventVersion: 1,
  payload: HoldEventPayload,
});

export default defineEventContract({
  definition: RiskHoldAdjustedV1,
  producer: 'risk-service',
  consumers: ['ledger-service', 'realtime-gateway'],
  summary:
    'Reserva reduzida por execução ou cancelamento parcial, ou refeita numa alteração (RN-HLD-004).',
});
