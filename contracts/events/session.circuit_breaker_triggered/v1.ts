import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const SessionCircuitBreakerTriggeredV1 = defineEvent({
  eventType: 'session.circuit_breaker_triggered',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    level: Type.Integer({ minimum: 1, maximum: 3 }),
    /** Variação do Ibovespa externo sobre o fechamento anterior; `null` se foi manual sem leitura. */
    indexChangePercent: Type.Union([Type.String({ pattern: '^-?\\d+(\\.\\d+)?$' }), Type.Null()]),
    resumesAt: Type.String({ format: 'date-time' }),
    origin: Type.Union(['INDEX', 'BACKOFFICE', 'SANDBOX'].map((o) => Type.Literal(o))),
  }),
});

export default defineEventContract({
  definition: SessionCircuitBreakerTriggeredV1,
  producer: 'trading-session-service',
  consumers: [
    'oms-service',
    'market-maker-service',
    'market-data-service',
    'realtime-gateway',
    'risk-service',
    'notification-service',
  ],
  summary: 'Circuit breaker simulado disparado (Pregão §6, RN-CB-001..004).',
});
