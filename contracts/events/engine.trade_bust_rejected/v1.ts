import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { BookOutput } from '../../src/schemas/engine.js';

const Id = Type.String({ format: 'uuid' });

export const EngineTradeBustRejectedV1 = defineEvent({
  eventType: 'engine.trade_bust_rejected',
  eventVersion: 1,
  payload: Type.Object({
    ...BookOutput,
    tradeId: Id,
    approvalRequestId: Id,
    reason: Type.Union(
      ['TRADE_NOT_FOUND', 'NOTES_ALREADY_GENERATED', 'ALREADY_BUSTED'].map((r) => Type.Literal(r)),
    ),
  }),
});

export default defineEventContract({
  definition: EngineTradeBustRejectedV1,
  producer: 'matching-engine',
  consumers: ['trading-session-service'],
  summary: 'Pedido de trade bust recusado (RN-BST-001).',
});
