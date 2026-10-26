import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const WithdrawalRequestedV1 = defineEvent({
  eventType: 'withdrawal.requested',
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
  definition: WithdrawalRequestedV1,
  producer: 'ledger-service',
  context: 'ledger',
  consumers: ['notification-service', 'reporting-service'],
  summary: 'Saque pedido; o hold no Risco vem a seguir (RN-LED-032).',
});
