import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Money = Type.String({ pattern: '^-?\\d+(\\.\\d{1,2})?$' });

export const LedgerBalanceChangedV1 = defineEvent({
  eventType: 'ledger.balance_changed',
  eventVersion: 1,
  payload: Type.Object({
    accountId: Type.String({ format: 'uuid' }),
    settled: Money,
    projected: Type.Object({ d0: Money, d1: Money, d2: Money }),
    projectedTotal: Money,
    withdrawable: Money,
    /** Sequência da última entrada da CUST_CASH: o consumidor descarta saldo mais velho. */
    lastSequence: Type.Integer({ minimum: 0 }),
    asOf: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: LedgerBalanceChangedV1,
  producer: 'ledger-service',
  consumers: ['risk-service', 'realtime-gateway', 'bff-web', 'bff-mobile', 'bff-desktop'],
  summary: 'Saldos da conta recalculados depois de um lançamento (Financeiro §4, RN-LED-031).',
});
