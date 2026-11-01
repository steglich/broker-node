import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { SessionPhase, SessionScope } from '../../src/schemas/session.js';

export const SessionPhaseChangedV1 = defineEvent({
  eventType: 'session.phase_changed',
  eventVersion: 1,
  payload: Type.Object({
    scope: SessionScope,
    /** Com `scope` de instrumento, a fase efetiva dele (RN-SES-001). */
    from: SessionPhase,
    /** Igual a `from` quando só o fim previsto mudou (prorrogação de leilão, RN-AUC-003). */
    to: SessionPhase,
    reason: Type.String(),
    effectiveAt: Type.String({ format: 'date-time' }),
    expectedEndAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    auctionId: Type.Optional(Type.String({ format: 'uuid' })),
  }),
});

export default defineEventContract({
  definition: SessionPhaseChangedV1,
  producer: 'trading-session-service',
  consumers: [
    'oms-service',
    'market-maker-service',
    'market-data-service',
    'realtime-gateway',
    'risk-service',
  ],
  summary:
    'Fase do mercado (`MARKET`) ou fase efetiva do instrumento que tem estado próprio mudou (RN-SES-002).',
});
