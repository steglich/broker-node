import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { BookOutput } from '../../src/schemas/engine.js';
import { SessionPrice } from '../../src/schemas/session.js';

const Side = Type.Union([Type.Literal('BUY'), Type.Literal('SELL')]);

export const EngineBookChangedV1 = defineEvent({
  eventType: 'engine.book_changed',
  eventVersion: 1,
  payload: Type.Object({
    ...BookOutput,
    side: Side,
    price: SessionPrice,
    /** Só a parte aparente; 0 quando o nível acabou. */
    newQuantity: Type.Integer({ minimum: 0 }),
    ordersCount: Type.Integer({ minimum: 0 }),
  }),
});

export default defineEventContract({
  definition: EngineBookChangedV1,
  producer: 'matching-engine',
  consumers: ['market-data-service'],
  summary: 'Delta de um nível do livro (Motor §9).',
});
