import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const RoutineTriggeredV1 = defineEvent({
  eventType: 'routine.triggered',
  eventVersion: 1,
  payload: Type.Object({
    routineName: Type.String({ pattern: '^[a-z][a-z0-9_]*$' }),
    /** Data de negócio da rotina; com `routineName`, a chave de idempotência (RN-ROT-001). */
    businessDate: Type.String({ format: 'date' }),
    /** Muda a cada tentativa (re-disparo de uma rotina que falhou). */
    executionId: Type.String({ format: 'uuid' }),
    attempt: Type.Integer({ minimum: 1 }),
    /** Horário previsto pela tabela de rotinas (tempo do ambiente). */
    scheduledFor: Type.String({ format: 'date-time' }),
    /** Disparo atrasado, de uma data anterior (RN-ROT-003). */
    catchUp: Type.Boolean(),
  }),
});

export default defineEventContract({
  definition: RoutineTriggeredV1,
  producer: 'scheduler-service',
  context: 'scheduler',
  consumers: ['routine-owner'],
  summary:
    'Hora de executar a rotina na data. O dono executa uma vez por (routineName, businessDate) e responde com routine.completed ou routine.failed.',
});
