import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { BookOutput } from '../../src/schemas/engine.js';
import { SessionPrice } from '../../src/schemas/session.js';

const Id = Type.String({ format: 'uuid' });

export const EngineOrderReplacedV1 = defineEvent({
  eventType: 'engine.order_replaced',
  eventVersion: 1,
  payload: Type.Object({
    ...BookOutput,
    orderId: Id,
    quantity: Type.Integer({ minimum: 1 }),
    limitPrice: Type.Union([SessionPrice, Type.Null()]),
    priorityKept: Type.Boolean(),
    version: Type.Integer({ minimum: 2 }),
  }),
});

export default defineEventContract({
  definition: EngineOrderReplacedV1,
  producer: 'matching-engine',
  consumers: ['oms-service', 'market-maker-service'],
  summary: 'Alteração aceita, informando se a prioridade foi mantida (RN-ALT-003).',
});
