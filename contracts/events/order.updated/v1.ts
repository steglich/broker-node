import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
const Quantity = Type.Integer({ minimum: 0 });

export const OrderStatus = Type.Union(
  [
    'RECEIVED',
    'SCHEDULED',
    'PENDING_TRIGGER',
    'PENDING_NEW',
    'NEW',
    'PARTIALLY_FILLED',
    'PENDING_REPLACE',
    'PENDING_CANCEL',
    'FILLED',
    'CANCELED',
    'REJECTED',
    'EXPIRED',
  ].map((s) => Type.Literal(s)),
);

export const OrderUpdatedV1 = defineEvent({
  eventType: 'order.updated',
  eventVersion: 1,
  payload: Type.Object({
    orderId: Uuid,
    accountId: Uuid,
    instrumentId: Uuid,
    side: Type.Union([Type.Literal('BUY'), Type.Literal('SELL')]),
    status: OrderStatus,
    quantity: Quantity,
    filledQuantity: Quantity,
    remainingQuantity: Quantity,
    canceledQuantity: Quantity,
    version: Type.Integer({ minimum: 0 }),
  }),
});

export default defineEventContract({
  definition: OrderUpdatedV1,
  producer: 'oms-service',
  context: 'oms',
  consumers: ['risk-service', 'realtime-gateway', 'bff-web', 'reporting-service'],
  summary: 'Ordem depois de qualquer mudança: estado, quantidades e versão (Catálogo §6).',
});
