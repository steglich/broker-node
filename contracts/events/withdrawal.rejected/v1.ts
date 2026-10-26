import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const WithdrawalRejectedV1 = defineEvent({
  eventType: 'withdrawal.rejected',
  eventVersion: 1,
  payload: Type.Object({
    withdrawalId: Type.String({ format: 'uuid' }),
    accountId: Type.String({ format: 'uuid' }),
    /** Dinheiro como string decimal (API §2). */
    amount: Type.String({ pattern: '^\\d+(\\.\\d{1,2})?$' }),
    reason: Type.Optional(Type.String()),
  }),
});

export default defineEventContract({
  definition: WithdrawalRejectedV1,
  producer: 'ledger-service',
  context: 'ledger',
  consumers: ['notification-service', 'reporting-service'],
  summary: 'Saque recusado (saldo sacável insuficiente ou reprovado na revisão).',
});
