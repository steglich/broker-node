import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Status = Type.Union(
  ['PENDING', 'ACTIVE', 'SUSPENDED', 'DELISTED'].map((s) => Type.Literal(s)),
);

export const InstrumentStatusChangedV1 = defineEvent({
  eventType: 'instrument.status_changed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    symbol: Type.String(),
    from: Status,
    to: Status,
    /** Ex.: `FIRST_QUOTE`, `STALE_REFERENCE_PRICE`, `BACKOFFICE`, `REMOVED_FROM_CATALOG`. */
    reason: Type.String(),
  }),
});

export default defineEventContract({
  definition: InstrumentStatusChangedV1,
  producer: 'reference-data-service',
  context: 'reference',
  consumers: ['oms-service', 'trading-session-service', 'market-maker-service', 'risk-service'],
  summary: 'Status do instrumento mudou (Ativos §5, RN-INS-020).',
});
