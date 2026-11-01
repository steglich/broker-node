import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { Board, SessionPrice } from '../../src/schemas/session.js';

const Id = Type.String({ format: 'uuid' });
const Participant = Type.Union(['CUSTOMER', 'MARKET_MAKER', 'SYSTEM'].map((p) => Type.Literal(p)));
const Side = Type.Union([Type.Literal('BUY'), Type.Literal('SELL')]);
const StpPolicy = Type.Union(
  ['CANCEL_AGGRESSOR', 'CANCEL_RESTING', 'CANCEL_BOTH'].map((p) => Type.Literal(p)),
);

export const EngineNewOrderV1 = defineEvent({
  eventType: 'engine.new_order',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Id,
    orderId: Id,
    accountId: Id,
    participantType: Participant,
    board: Board,
    side: Side,
    type: Type.Union([Type.Literal('LIMIT'), Type.Literal('MARKET')]),
    quantity: Type.Integer({ minimum: 1 }),
    limitPrice: Type.Optional(SessionPrice),
    protectionPrice: Type.Optional(SessionPrice),
    timeInForce: Type.Union(['DAY', 'GTC', 'GTD', 'IOC', 'FOK'].map((t) => Type.Literal(t))),
    /** Só a parte aparente vai ao livro; o resto recarrega com nova prioridade (RN-ICE-001). */
    displayQuantity: Type.Optional(Type.Integer({ minimum: 1 })),
    stpPolicy: StpPolicy,
  }),
});

export default defineEventContract({
  definition: EngineNewOrderV1,
  producer: 'oms-service',
  context: 'engine',
  kind: 'commands',
  consumers: ['matching-engine'],
  summary:
    'Comando `NewOrder`: ordem nova para o livro; o FMS também publica (Catálogo de eventos §6).',
});
