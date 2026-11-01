import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { BookOutput } from '../../src/schemas/engine.js';

const Id = Type.String({ format: 'uuid' });

export const EngineOrderRejectedV1 = defineEvent({
  eventType: 'engine.order_rejected',
  eventVersion: 1,
  payload: Type.Object({
    ...BookOutput,
    orderId: Id,
    /** Subcódigo de `ENGINE_REJECTED` (Motor §4.3). */
    reason: Type.Union(
      [
        'BOOK_NOT_OPEN',
        'PRICE_OUTSIDE_REJECTION_BAND',
        'DUPLICATE_ORDER_ID',
        'UNKNOWN_ORDER',
        'INVALID_REPLACE',
      ].map((r) => Type.Literal(r)),
    ),
  }),
});

export default defineEventContract({
  definition: EngineOrderRejectedV1,
  producer: 'matching-engine',
  consumers: ['oms-service', 'market-maker-service'],
  summary: 'O Motor recusou uma entrada pelo estado do livro (Motor §4.3).',
});
