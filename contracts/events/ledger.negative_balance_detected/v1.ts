import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
/** Dinheiro como string decimal (API §2); pode ser negativo. */
const Money = Type.String({ pattern: '^-?\\d+(\\.\\d{1,2})?$' });

export const LedgerNegativeBalanceDetectedV1 = defineEvent({
  eventType: 'ledger.negative_balance_detected',
  eventVersion: 1,
  payload: Type.Object({ accountId: Uuid, settledBalance: Money }),
});

export default defineEventContract({
  definition: LedgerNegativeBalanceDetectedV1,
  producer: 'ledger-service',
  consumers: ['customer-service', 'risk-service', 'notification-service'],
  summary: 'Saldo liquidado negativo (RN-DEV-002).',
});
