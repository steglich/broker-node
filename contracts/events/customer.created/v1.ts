import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const CustomerCreatedV1 = defineEvent({
  eventType: 'customer.created',
  eventVersion: 1,
  payload: Type.Object({
    customerId: Type.String({ format: 'uuid' }),
    userId: Type.String({ format: 'uuid' }),
    displayName: Type.String(),
    /** Dinheiro como string decimal (API §2). */
    declaredNetWorth: Type.String({ pattern: '^\\d+(\\.\\d{1,2})?$' }),
    pep: Type.Boolean(),
  }),
});

export default defineEventContract({
  definition: CustomerCreatedV1,
  producer: 'customer-service',
  consumers: ['risk-service', 'tax-service', 'notification-service', 'identity-service'],
  summary: 'Cliente criado na aprovação do cadastro; liga o usuário ao cliente.',
});
