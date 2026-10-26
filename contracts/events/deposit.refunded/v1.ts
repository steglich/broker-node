import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const DepositRefundedV1 = defineEvent({
  eventType: 'deposit.refunded',
  eventVersion: 1,
  payload: Type.Object({
    depositId: Type.String({ format: 'uuid' }),
    accountId: Type.String({ format: 'uuid' }),
    /** Dinheiro como string decimal (API §2). */
    amount: Type.String({ pattern: '^\\d+(\\.\\d{1,2})?$' }),
    reason: Type.Optional(Type.String()),
  }),
});

export default defineEventContract({
  definition: DepositRefundedV1,
  producer: 'ledger-service',
  context: 'ledger',
  consumers: ['notification-service', 'reporting-service'],
  summary: 'Pagamento devolvido integralmente; reason diz o motivo (RN-DEP-002..004, RN-DEP-007).',
});
