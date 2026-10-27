import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { TradingRulesValues } from '../../src/schemas/reference.js';

export const InstrumentTradingRulesChangedV1 = defineEvent({
  eventType: 'instrument.trading_rules_changed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    ruleId: Type.String({ format: 'uuid' }),
    /** `null` = padrão global. */
    instrumentId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    /** Global: todos os campos; sobrescrita: só os campos sobrescritos. */
    rules: Type.Partial(TradingRulesValues),
    validFrom: Type.String({ format: 'date-time' }),
    approvalRequestId: Type.String({ format: 'uuid' }),
  }),
});

export default defineEventContract({
  definition: InstrumentTradingRulesChangedV1,
  producer: 'reference-data-service',
  context: 'reference',
  consumers: ['oms-service', 'trading-session-service', 'market-maker-service'],
  summary: 'Nova vigência de parâmetros de negociação, global ou por instrumento (Ativos §7).',
});
