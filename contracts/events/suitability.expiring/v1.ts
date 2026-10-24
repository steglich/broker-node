import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const SuitabilityExpiringV1 = defineEvent({
  eventType: 'suitability.expiring',
  eventVersion: 1,
  payload: Type.Object({ customerId: Uuid, validUntil: Type.String({ format: 'date' }) }),
});

export default defineEventContract({
  definition: SuitabilityExpiringV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: ['notification-service', 'risk-service'],
  summary: 'Faltam 30 dias para o suitability vencer (RN-SUI-012).',
});
