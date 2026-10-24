import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
/** Dinheiro como string decimal (API §2); pode ser negativo. */
const Money = Type.String({ pattern: '^-?\\d+(\\.\\d{1,2})?$' });

export const CustomerUpdatedV1 = defineEvent({
  eventType: 'customer.updated',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    customerId: Uuid,
    /** Só os nomes dos campos, sem valores sensíveis. */
    changedFields: Type.Array(Type.String()),
    declaredNetWorth: Type.Optional(Money),
  }),
});

export default defineEventContract({
  definition: CustomerUpdatedV1,
  producer: 'customer-service',
  consumers: ['risk-service'],
  summary: 'Dados cadastrais alterados (RN-CAD-004).',
});
