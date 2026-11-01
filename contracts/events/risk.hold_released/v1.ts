import { defineEvent } from '@broker/messaging';
import { defineEventContract } from '../../src/define.js';
import { HoldEventPayload } from '../../src/schemas/risk.js';

export const RiskHoldReleasedV1 = defineEvent({
  eventType: 'risk.hold_released',
  eventVersion: 1,
  payload: HoldEventPayload,
});

export default defineEventContract({
  definition: RiskHoldReleasedV1,
  producer: 'risk-service',
  consumers: ['ledger-service', 'realtime-gateway'],
  summary: 'Reserva liberada: cancelamento, expiração, saque desfeito ou órfã (RN-HLD-007).',
});
