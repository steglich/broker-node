import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const OrderCanceledV1 = defineEvent({
  eventType: 'order.canceled',
  eventVersion: 1,
  payload: Type.Object({
    orderId: Uuid,
    accountId: Uuid,
    canceledQuantity: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 1 }),
  }),
});

export default defineEventContract({
  definition: OrderCanceledV1,
  producer: 'oms-service',
  context: 'oms',
  consumers: ['risk-service', 'notification-service'],
  summary: 'Ordem cancelada; o Risco libera a parte cancelada do hold (RN-HLD-004).',
});
