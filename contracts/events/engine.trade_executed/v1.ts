import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { Board, SessionPrice } from '../../src/schemas/session.js';

const Participant = Type.Union(['CUSTOMER', 'MARKET_MAKER', 'SYSTEM'].map((p) => Type.Literal(p)));

export const EngineTradeExecutedV1 = defineEvent({
  eventType: 'engine.trade_executed',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    board: Board,
    engineSeq: Type.Integer({ minimum: 1 }),
    inputSeq: Type.Integer({ minimum: 1 }),
    tradeId: Type.String({ format: 'uuid' }),
    price: SessionPrice,
    quantity: Type.Integer({ minimum: 1 }),
    buyOrderId: Type.String({ format: 'uuid' }),
    sellOrderId: Type.String({ format: 'uuid' }),
    buyAccountId: Type.String({ format: 'uuid' }),
    sellAccountId: Type.String({ format: 'uuid' }),
    buyParticipantType: Participant,
    sellParticipantType: Participant,
    aggressorSide: Type.Union(['BUY', 'SELL', 'NONE'].map((s) => Type.Literal(s))),
    executedAt: Type.String({ format: 'date-time' }),
    tradingDate: Type.String({ format: 'date' }),
    /** Só em negócios de leilão (RN-AUC-022). */
    auctionId: Type.Optional(Type.String({ format: 'uuid' })),
  }),
});

export default defineEventContract({
  definition: EngineTradeExecutedV1,
  producer: 'matching-engine',
  consumers: [
    'oms-service',
    'clearing-service',
    'market-data-service',
    'risk-service',
    'market-maker-service',
    'trading-session-service',
  ],
  summary:
    'Negócio executado (RN-ME-021); a sessão usa o último do contínuo no fechamento (RN-FCH-001).',
});
