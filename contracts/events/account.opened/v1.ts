import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const AccountOpenedV1 = defineEvent({
  eventType: 'account.opened',
  eventVersion: 1,
  payload: Type.Object({
    accountId: Type.String({ format: 'uuid' }),
    customerId: Type.String({ format: 'uuid' }),
    accountNumber: Type.String(),
    openedAt: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: AccountOpenedV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: [
    'ledger-service',
    'custody-service',
    'risk-service',
    'engagement-service',
    'notification-service',
    'identity-service',
  ],
  summary: 'Conta aberta; o identity passa a pôr o account_id no token do usuário.',
});
