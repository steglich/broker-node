import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { SessionScope } from '../../src/schemas/session.js';

export const SessionHaltStartedV1 = defineEvent({
  eventType: 'session.halt_started',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    haltId: Type.String({ format: 'uuid' }),
    scope: SessionScope,
    /** `BACKOFFICE`, `STALE_REFERENCE_PRICE`, `CORPORATE_ACTION`, `MARKET_DATA_UNAVAILABLE`, `ENGINE_RECOVERY`, `CIRCUIT_BREAKER_L{n}`. */
    reasonCode: Type.String(),
    /** Decisão do backoffice de cancelar as ordens abertas do escopo: o OMS executa (RN-HLT-001). */
    cancelAllOnHalt: Type.Boolean(),
    resumesAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  }),
});

export default defineEventContract({
  definition: SessionHaltStartedV1,
  producer: 'trading-session-service',
  consumers: [
    'oms-service',
    'market-maker-service',
    'market-data-service',
    'realtime-gateway',
    'risk-service',
  ],
  summary: 'Suspensão de um instrumento ou do mercado (Pregão §5).',
});
