import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const TermsAcceptedV1 = defineEvent({
  eventType: 'terms.accepted',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    userId: Uuid,
    termsCode: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    acceptedAt: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: TermsAcceptedV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: ['risk-service', 'audit-service'],
  summary: 'Aceite de termo (RN-TER-002).',
});
