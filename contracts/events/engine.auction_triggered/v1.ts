import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { AuctionType, Board } from '../../src/schemas/session.js';

export const EngineAuctionTriggeredV1 = defineEvent({
  eventType: 'engine.auction_triggered',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    board: Board,
    engineSeq: Type.Integer({ minimum: 1 }),
    inputSeq: Type.Integer({ minimum: 1 }),
    auctionId: Type.String({ format: 'uuid' }),
    type: AuctionType,
    reason: Type.String(),
    expectedEndAt: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: EngineAuctionTriggeredV1,
  producer: 'matching-engine',
  consumers: ['trading-session-service', 'market-data-service'],
  summary: 'O Motor abriu um leilão por volatilidade (RN-AUC-030..032).',
});
