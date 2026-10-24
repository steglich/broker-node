import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const RoutineFailedV1 = defineEvent({
  eventType: 'routine.failed',
  eventVersion: 1,
  payload: Type.Object({
    routineName: Type.String({ pattern: '^[a-z][a-z0-9_]*$' }),
    businessDate: Type.String({ format: 'date' }),
    executionId: Type.String({ format: 'uuid' }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    stats: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
});

export default defineEventContract({
  definition: RoutineFailedV1,
  // Qualquer serviço dono de rotina, cada um no próprio tópico.
  producer: 'routine-owner',
  context: '*',
  consumers: ['scheduler-service'],
  summary:
    'A rotina falhou na data; as dependentes continuam esperando até um novo disparo dar certo.',
});
