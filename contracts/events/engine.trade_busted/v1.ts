import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { BookOutput } from '../../src/schemas/engine.js';

const Id = Type.String({ format: 'uuid' });

export const EngineTradeBustedV1 = defineEvent({
  eventType: 'engine.trade_busted',
  eventVersion: 1,
  payload: Type.Object({
    ...BookOutput,
    tradeId: Id,
    approvalRequestId: Id,
  }),
});

export default defineEventContract({
  definition: EngineTradeBustedV1,
  producer: 'matching-engine',
  consumers: [
    'oms-service',
    'clearing-service',
    'custody-service',
    'risk-service',
    'market-data-service',
  ],
  summary: 'Negócio cancelado; as ordens não voltam ao livro (RN-BST-001..003).',
});
