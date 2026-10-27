import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { CalendarDataSchema } from '../../src/schemas/reference.js';

export const CalendarUpdatedV1 = defineEvent({
  eventType: 'calendar.updated',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    /** Intervalo afetado (inclusivo). */
    from: Type.String({ format: 'date' }),
    to: Type.String({ format: 'date' }),
    /** O calendário inteiro depois da mudança: a cópia local é substituída por ele (D15). */
    calendar: CalendarDataSchema,
  }),
});

export default defineEventContract({
  definition: CalendarUpdatedV1,
  producer: 'reference-data-service',
  context: 'reference',
  consumers: ['scheduler-service', 'trading-session-service', 'ledger-service', 'clearing-service'],
  summary: 'Dias do calendário ou período carregado mudaram (RN-CAL-001).',
});
