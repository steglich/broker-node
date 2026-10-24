import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const OnboardingApprovedV1 = defineEvent({
  eventType: 'onboarding.approved',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    applicationId: Uuid,
    customerId: Type.Optional(Uuid),
    reasonCode: Type.Optional(Type.String()),
    decidedBy: Type.Optional(Type.String()),
  }),
});

export default defineEventContract({
  definition: OnboardingApprovedV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: ['notification-service', 'audit-service'],
  summary: 'Abertura aprovada (automática ou pelo backoffice).',
});
