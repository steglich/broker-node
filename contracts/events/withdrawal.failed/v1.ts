import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const WithdrawalFailedV1 = defineEvent({
  eventType: 'withdrawal.failed',
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
  definition: WithdrawalFailedV1,
  producer: 'ledger-service',
  context: 'ledger',
  consumers: ['notification-service', 'reporting-service'],
  summary:
    'Saque não realizado (recusa do PIX ou tentativas esgotadas); hold liberado (RN-SAQ-007).',
});
