import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const InstrumentTradabilityChangedV1 = defineEvent({
  eventType: 'instrument.tradability_changed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    symbol: Type.String(),
    oddLotSymbol: Type.Union([Type.String(), Type.Null()]),
    lotSize: Type.Integer({ minimum: 1 }),
    tradable: Type.Boolean(),
    /** Solicitação aprovada que incluiu ou retirou o instrumento (RN-MC-BO-004). */
    approvalRequestId: Type.String({ format: 'uuid' }),
  }),
});

export default defineEventContract({
  definition: InstrumentTradabilityChangedV1,
  producer: 'reference-data-service',
  context: 'reference',
  consumers: [
    'market-data-service',
    'market-maker-service',
    'trading-session-service',
    'oms-service',
  ],
  summary:
    'Entrada ou saída do universo negociável: dispara histórico, primeira cotação, livros e FMS (RN-INS-014).',
});
