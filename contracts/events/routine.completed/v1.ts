import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const RoutineCompletedV1 = defineEvent({
  eventType: 'routine.completed',
  eventVersion: 1,
  payload: Type.Object({
    routineName: Type.String({ pattern: '^[a-z][a-z0-9_]*$' }),
    businessDate: Type.String({ format: 'date' }),
    /** O `executionId` do `routine.triggered` que esta conclusão responde. */
    executionId: Type.String({ format: 'uuid' }),
    stats: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
});

export default defineEventContract({
  definition: RoutineCompletedV1,
  // Qualquer serviço dono de rotina, cada um no próprio tópico.
  producer: 'routine-owner',
  context: '*',
  consumers: ['scheduler-service'],
  summary: 'A rotina terminou na data; libera as rotinas que dependem dela (RN-ROT-002).',
});
