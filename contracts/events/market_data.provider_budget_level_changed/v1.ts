import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Level = Type.Union(['NORMAL', 'SAVING', 'CRITICAL', 'EXHAUSTED'].map((l) => Type.Literal(l)));

export const MarketDataProviderBudgetLevelChangedV1 = defineEvent({
  eventType: 'market_data.provider_budget_level_changed',
  eventVersion: 1,
  payload: Type.Object({
    from: Level,
    to: Level,
    /** Requisições restantes na janela (E9 menos o enviado depois dele). */
    remaining: Type.Integer({ minimum: 0 }),
    projectedExhaustion: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  }),
});

export default defineEventContract({
  definition: MarketDataProviderBudgetLevelChangedV1,
  producer: 'market-data-service',
  context: 'market-data',
  consumers: ['bff-backoffice', 'notification-service'],
  summary: 'Nível do orçamento da brapi mudou (Brapi §5.3, RN-BRP-035).',
});
