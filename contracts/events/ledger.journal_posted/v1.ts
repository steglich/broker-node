import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

/** Dinheiro como string decimal (API §2); com sinal: positivo = crédito ao titular. */
const Signed = Type.String({ pattern: '^-?\\d+(\\.\\d{1,2})?$' });
const Date_ = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

export const LedgerJournalPostedV1 = defineEvent({
  eventType: 'ledger.journal_posted',
  eventVersion: 1,
  payload: Type.Object({
    journalId: Type.String({ format: 'uuid' }),
    type: Type.String(),
    referenceType: Type.String(),
    referenceId: Type.String(),
    bookingDate: Date_,
    entries: Type.Array(
      Type.Object({
        accountCode: Type.String(),
        /** `account_id` do cliente; `null` nas contas da casa. */
        ownerId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
        amount: Signed,
        valueDate: Date_,
        status: Type.Union([Type.Literal('PENDING'), Type.Literal('SETTLED')]),
        sequence: Type.Integer({ minimum: 1 }),
      }),
      { minItems: 2 },
    ),
  }),
});

export default defineEventContract({
  definition: LedgerJournalPostedV1,
  producer: 'ledger-service',
  consumers: ['risk-service', 'reporting-service', 'audit-service'],
  summary: 'Lançamento contábil gravado, com as entradas e as sequências por conta (RN-LED-031).',
});
