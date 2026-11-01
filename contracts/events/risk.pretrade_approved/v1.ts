import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { Classification, PreTradeFigures } from '../../src/schemas/risk.js';

const Uuid = Type.String({ format: 'uuid' });

export const RiskPretradeApprovedV1 = defineEvent({
  eventType: 'risk.pretrade_approved',
  eventVersion: 1,
  payload: Type.Object({
    requestId: Type.String({ minLength: 1 }),
    accountId: Uuid,
    orderId: Uuid,
    holdId: Uuid,
    classification: Classification,
    figures: PreTradeFigures,
  }),
});

export default defineEventContract({
  definition: RiskPretradeApprovedV1,
  producer: 'risk-service',
  consumers: ['audit-service'],
  summary: 'Ordem aprovada no pré-trade, com o hold criado (Risco §11).',
});
