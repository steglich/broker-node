import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { BookOutput } from '../../src/schemas/engine.js';
import { SessionPrice } from '../../src/schemas/session.js';

const Id = Type.String({ format: 'uuid' });

export const EngineOrderBookedV1 = defineEvent({
  eventType: 'engine.order_booked',
  eventVersion: 1,
  payload: Type.Object({
    ...BookOutput,
    orderId: Id,
    price: Type.Union([SessionPrice, Type.Null()]),
    remainingQuantity: Type.Integer({ minimum: 1 }),
    prioritySeq: Type.Integer({ minimum: 1 }),
  }),
});

export default defineEventContract({
  definition: EngineOrderBookedV1,
  producer: 'matching-engine',
  consumers: ['oms-service', 'market-maker-service'],
  summary: 'Ordem entrou (ou voltou) no livro; `price` nulo é `MARKET` em leilão (Motor §9).',
});
