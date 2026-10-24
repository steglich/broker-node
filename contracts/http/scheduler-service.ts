import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const RoutineName = Type.String({ pattern: '^[a-z][a-z0-9_]*$' });
const DateParam = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

export const ClockView = Type.Object({
  mode: Type.Union([Type.Literal('REAL'), Type.Literal('ACCELERATED'), Type.Literal('VIRTUAL')]),
  now: Type.String({ format: 'date-time' }),
  businessDate: Type.String({ format: 'date' }),
  speedFactor: Type.Number(),
  /** Esta instância é a líder (a única que dispara e publica o relógio, RN-ENV-021). */
  leader: Type.Boolean(),
});

export const RoutineView = Type.Object({
  name: RoutineName,
  owner: Type.String(),
  schedule: Type.Union([
    Type.Object({ at: Type.String() }),
    Type.Object({ phase: Type.String(), offsetMinutes: Type.Optional(Type.Integer()) }),
  ]),
  days: Type.Union([Type.Literal('TRADING'), Type.Literal('FIRST_BUSINESS_DAY_OF_MONTH')]),
  dependsOn: Type.Array(RoutineName),
  enabled: Type.Boolean(),
});

export const ExecutionView = Type.Object({
  routineName: RoutineName,
  businessDate: Type.String({ format: 'date' }),
  status: Type.Union([
    Type.Literal('TRIGGERED'),
    Type.Literal('COMPLETED'),
    Type.Literal('FAILED'),
  ]),
  executionId: Type.String({ format: 'uuid' }),
  attempt: Type.Integer(),
  scheduledFor: Type.String({ format: 'date-time' }),
  triggeredAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  failureReason: Type.Union([Type.String(), Type.Null()]),
  catchUp: Type.Boolean(),
});

export const schedulerServiceHttp = defineHttpContract({
  service: 'scheduler-service',
  title: 'scheduler-service',
  version: '1.0.0',
  routes: {
    getClock: {
      method: 'get',
      path: '/v1/clock',
      summary: 'O relógio do ambiente (RN-CLK-002).',
      auth: 'public',
      responses: { 200: { description: 'Modo e instante atual.', body: ClockView } },
    },
    advanceClock: {
      method: 'post',
      path: '/v1/clock/advance',
      summary: 'advance_to(t): só no modo VIRTUAL; dispara as rotinas do caminho em ordem. Admin.',
      auth: 'public',
      body: Type.Object({ to: Type.String({ format: 'date-time' }) }),
      responses: {
        200: { description: 'Relógio no instante pedido.', body: ClockView },
        409: { description: 'CLOCK_MODE_NOT_VIRTUAL ou CLOCK_CANNOT_GO_BACK.' },
        503: { description: 'NOT_LEADER: a instância está em espera.' },
      },
    },
    listRoutines: {
      method: 'get',
      path: '/v1/routines',
      summary: 'A tabela de rotinas (Pregão §8).',
      auth: 'public',
      responses: {
        200: { description: 'Rotinas.', body: Type.Object({ routines: Type.Array(RoutineView) }) },
      },
    },
    listExecutions: {
      method: 'get',
      path: '/v1/routine-executions',
      summary: 'Execuções por período de datas de negócio (até 1 ano).',
      auth: 'public',
      query: Type.Object({ from: DateParam, to: DateParam }),
      responses: {
        200: {
          description: 'Execuções.',
          body: Type.Object({ executions: Type.Array(ExecutionView) }),
        },
      },
    },
    retryExecution: {
      method: 'post',
      path: '/v1/routine-executions/:routineName/:businessDate/retry',
      summary: 'Novo disparo de uma rotina FAILED (executionId novo). Admin.',
      auth: 'public',
      params: Type.Object({ routineName: RoutineName, businessDate: DateParam }),
      responses: {
        202: { description: 'Disparada de novo.', body: ExecutionView },
        409: { description: 'ROUTINE_NOT_FAILED.' },
      },
    },
    reportResult: {
      method: 'post',
      path: '/v1/routine-executions/:routineName/:businessDate/result',
      summary:
        'Registra o resultado de uma execução à mão, como se fosse o routine.completed/failed do dono. Admin.',
      auth: 'public',
      params: Type.Object({ routineName: RoutineName, businessDate: DateParam }),
      body: Type.Object({
        executionId: Type.String({ format: 'uuid' }),
        status: Type.Union([Type.Literal('COMPLETED'), Type.Literal('FAILED')]),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      }),
      responses: {
        204: { description: 'Registrado.' },
        404: { description: 'Execução inexistente.' },
        409: { description: 'EXECUTION_STALE: executionId de uma tentativa anterior.' },
      },
    },
  },
});

export default schedulerServiceHttp;
