import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const OrderExpiredV1 = defineEvent({
  eventType: 'order.expired',
  eventVersion: 1,
  payload: Type.Object({
    orderId: Uuid,
    accountId: Uuid,
    canceledQuantity: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 1 }),
  }),
});

export default defineEventContract({
  definition: OrderExpiredV1,
  producer: 'oms-service',
  context: 'oms',
  consumers: ['risk-service', 'notification-service'],
  summary: 'Validade da ordem terminou; o Risco libera o que restava do hold (RN-HLD-004).',
});
