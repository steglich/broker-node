import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { BookOutput } from '../../src/schemas/engine.js';

const Id = Type.String({ format: 'uuid' });

export const EngineOrderCanceledV1 = defineEvent({
  eventType: 'engine.order_canceled',
  eventVersion: 1,
  payload: Type.Object({
    ...BookOutput,
    orderId: Id,
    canceledQuantity: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 1 }),
  }),
});

export default defineEventContract({
  definition: EngineOrderCanceledV1,
  producer: 'matching-engine',
  consumers: ['oms-service', 'market-maker-service'],
  summary: 'Ordem cancelada no Motor, por comando ou regra (RN-CAN-003).',
});
