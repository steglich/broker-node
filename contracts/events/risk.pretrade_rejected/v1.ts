import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { Classification, PreTradeFigures } from '../../src/schemas/risk.js';

const Uuid = Type.String({ format: 'uuid' });

export const RiskPretradeRejectedV1 = defineEvent({
  eventType: 'risk.pretrade_rejected',
  eventVersion: 1,
  payload: Type.Object({
    requestId: Type.String({ minLength: 1 }),
    accountId: Uuid,
    orderId: Uuid,
    classification: Type.Optional(Classification),
    rejectCode: Type.String({ minLength: 1 }),
    figures: Type.Optional(PreTradeFigures),
  }),
});

export default defineEventContract({
  definition: RiskPretradeRejectedV1,
  producer: 'risk-service',
  consumers: ['audit-service'],
  summary: 'Ordem recusada no pré-trade, com o código e os valores usados (RN-PTC-002).',
});
