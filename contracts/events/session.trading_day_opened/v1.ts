import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const SessionTradingDayOpenedV1 = defineEvent({
  eventType: 'session.trading_day_opened',
  eventVersion: 1,
  payload: Type.Object({ businessDate: Type.String({ format: 'date' }) }),
});

export default defineEventContract({
  definition: SessionTradingDayOpenedV1,
  producer: 'trading-session-service',
  consumers: ['all-services'],
  summary: 'Abertura lógica do dia de negociação pela rotina das 07:00 (Pregão §8).',
});
