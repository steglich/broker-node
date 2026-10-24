import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const AccountStatus = Type.String({ pattern: '^[A-Z_]+$' });

export const AccountStatusChangedV1 = defineEvent({
  eventType: 'account.status_changed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    accountId: Type.String({ format: 'uuid' }),
    from: AccountStatus,
    /** Ex.: `ACTIVE`, `BLOCKED`, `CLOSED`. */
    to: AccountStatus,
    reasonCode: Type.String(),
    restrictions: Type.Optional(Type.Array(Type.String())),
    actor: Type.Object({ type: Type.String(), id: Type.String() }),
  }),
});

export default defineEventContract({
  definition: AccountStatusChangedV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: [
    'identity-service',
    'oms-service',
    'risk-service',
    'ledger-service',
    'notification-service',
  ],
  summary: 'Status da conta mudou; BLOCKED revoga as assinaturas do titular (RN-AUTH-014).',
});
