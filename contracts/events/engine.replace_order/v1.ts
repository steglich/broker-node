import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { SessionPrice } from '../../src/schemas/session.js';

const Id = Type.String({ format: 'uuid' });

export const EngineReplaceOrderV1 = defineEvent({
  eventType: 'engine.replace_order',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Id,
    orderId: Id,
    /** Quantidade total da ordem, já executado incluído (RN-ALT-002). */
    newQuantity: Type.Optional(Type.Integer({ minimum: 1 })),
    newLimitPrice: Type.Optional(SessionPrice),
    /** Versão da ordem no Motor: 1 ao entrar, +1 a cada alteração aceita. */
    expectedVersion: Type.Integer({ minimum: 1 }),
  }),
});

export default defineEventContract({
  definition: EngineReplaceOrderV1,
  producer: 'oms-service',
  context: 'engine',
  kind: 'commands',
  consumers: ['matching-engine'],
  summary: 'Comando `ReplaceOrder`; a perda de prioridade segue RN-ALT-003.',
});
