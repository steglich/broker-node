import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const SmmInstrumentActivatedV1 = defineEvent({
  eventType: 'smm.instrument_activated',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    symbol: Type.String(),
    accountId: Type.String({ format: 'uuid' }),
    /** Emissão simulada `ISSUER_SECURITIES` → `SMM_SECURITIES`: limite de inventário × lote. */
    initialStock: Type.Integer({ minimum: 1 }),
    activatedAt: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: SmmInstrumentActivatedV1,
  producer: 'market-maker-service',
  context: 'market-maker',
  consumers: ['custody-service'],
  summary:
    'Instrumento ativado no FMS, uma vez só: a custódia registra o estoque inicial, retroativo na Fase 3 (RN-SMM-020, RN-INS-014).',
});
