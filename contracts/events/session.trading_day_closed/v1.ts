import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const SessionTradingDayClosedV1 = defineEvent({
  eventType: 'session.trading_day_closed',
  eventVersion: 1,
  payload: Type.Object({ businessDate: Type.String({ format: 'date' }) }),
});

export default defineEventContract({
  definition: SessionTradingDayClosedV1,
  producer: 'trading-session-service',
  consumers: ['all-services'],
  summary: 'Fim do dia de negociação, depois do pós-fechamento (Pregão §8).',
});
