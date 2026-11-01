import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { RiskSignedAmount } from '../../src/schemas/risk.js';

export const RiskBuyingPowerChangedV1 = defineEvent({
  eventType: 'risk.buying_power_changed',
  eventVersion: 1,
  payload: Type.Object({
    accountId: Type.String({ format: 'uuid' }),
    /** `BP_cash = P2 + U − H` (RN-BP-001). */
    cash: RiskSignedAmount,
    /** `BP_daytrade`, só para quem tem margem (Fase 5, RN-BP-005). */
    dayTrade: Type.Optional(RiskSignedAmount),
    asOf: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: RiskBuyingPowerChangedV1,
  producer: 'risk-service',
  consumers: ['realtime-gateway', 'bff-web', 'bff-mobile', 'bff-desktop'],
  summary: 'Poder de compra mudou, com throttle por conta (Risco §12).',
});
