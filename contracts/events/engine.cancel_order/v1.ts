import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Id = Type.String({ format: 'uuid' });

export const EngineCancelOrderV1 = defineEvent({
  eventType: 'engine.cancel_order',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Id,
    orderId: Id,
    reason: Type.String({ minLength: 1 }),
  }),
});

export default defineEventContract({
  definition: EngineCancelOrderV1,
  producer: 'oms-service',
  context: 'engine',
  kind: 'commands',
  consumers: ['matching-engine'],
  summary: 'Comando `CancelOrder`; o FMS também publica (Catálogo de eventos §6).',
});
