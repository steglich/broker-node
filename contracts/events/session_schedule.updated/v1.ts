import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { CalendarDataSchema } from '../../src/schemas/reference.js';

export const SessionScheduleUpdatedV1 = defineEvent({
  eventType: 'session_schedule.updated',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    /** Vigência da nova grade (inclusiva; `to = null` sem fim). */
    from: Type.String({ format: 'date' }),
    to: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
    calendar: CalendarDataSchema,
  }),
});

export default defineEventContract({
  definition: SessionScheduleUpdatedV1,
  producer: 'reference-data-service',
  context: 'reference',
  consumers: ['scheduler-service', 'trading-session-service', 'ledger-service'],
  summary: 'Nova grade horária com vigência (RN-CAL-003).',
});
