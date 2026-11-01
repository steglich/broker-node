import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const OrderRejectedV1 = defineEvent({
  eventType: 'order.rejected',
  eventVersion: 1,
  payload: Type.Object({
    orderId: Uuid,
    accountId: Uuid,
    rejectCode: Type.String({ minLength: 1 }),
    figures: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
});

export default defineEventContract({
  definition: OrderRejectedV1,
  producer: 'oms-service',
  context: 'oms',
  consumers: ['risk-service', 'notification-service', 'realtime-gateway', 'audit-service'],
  summary:
    'Ordem recusada pelo OMS, Risco ou Motor; sem execução, o Risco libera o hold (RN-FLX-002).',
});
