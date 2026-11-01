import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Id = Type.String({ format: 'uuid' });

export const EngineTradeBustV1 = defineEvent({
  eventType: 'engine.trade_bust',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Id,
    tradeId: Id,
    approvalRequestId: Id,
  }),
});

export default defineEventContract({
  definition: EngineTradeBustV1,
  producer: 'trading-session-service',
  context: 'engine',
  kind: 'commands',
  consumers: ['matching-engine'],
  summary: 'Comando `TradeBust`, vindo da dupla aprovação (RN-BST-001).',
});
