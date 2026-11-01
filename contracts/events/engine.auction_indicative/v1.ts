import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { Board, SessionPrice } from '../../src/schemas/session.js';

export const EngineAuctionIndicativeV1 = defineEvent({
  eventType: 'engine.auction_indicative',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    board: Board,
    engineSeq: Type.Integer({ minimum: 1 }),
    inputSeq: Type.Integer({ minimum: 1 }),
    auctionId: Type.String({ format: 'uuid' }),
    theoreticalPrice: Type.Union([SessionPrice, Type.Null()]),
    theoreticalQuantity: Type.Integer({ minimum: 0 }),
    imbalanceSide: Type.Union([Type.Literal('BUY'), Type.Literal('SELL'), Type.Null()]),
    imbalanceQuantity: Type.Integer({ minimum: 0 }),
  }),
});

export default defineEventContract({
  definition: EngineAuctionIndicativeV1,
  producer: 'matching-engine',
  consumers: ['market-data-service', 'trading-session-service'],
  summary:
    'Preço teórico do leilão a cada mudança no livro (RN-AUC-002/023); a sessão o compara ao túnel estático no fim previsto (RN-AUC-003).',
});
