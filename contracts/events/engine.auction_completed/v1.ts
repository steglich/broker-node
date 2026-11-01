import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { Board, SessionPrice } from '../../src/schemas/session.js';

export const EngineAuctionCompletedV1 = defineEvent({
  eventType: 'engine.auction_completed',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    board: Board,
    engineSeq: Type.Integer({ minimum: 1 }),
    inputSeq: Type.Integer({ minimum: 1 }),
    auctionId: Type.String({ format: 'uuid' }),
    /** `null` com o livro não cruzado: sem negócio e sem mudar a referência (RN-AUC-020). */
    price: Type.Union([SessionPrice, Type.Null()]),
    quantity: Type.Integer({ minimum: 0 }),
  }),
});

export default defineEventContract({
  definition: EngineAuctionCompletedV1,
  producer: 'matching-engine',
  consumers: ['trading-session-service', 'market-data-service'],
  summary: 'Leilão concluído no Motor, com preço e quantidade (RN-AUC-020..022).',
});
