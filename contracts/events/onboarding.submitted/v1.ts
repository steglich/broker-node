import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const OnboardingSubmittedV1 = defineEvent({
  eventType: 'onboarding.submitted',
  eventVersion: 1,
  payload: Type.Object({ applicationId: Uuid }),
});

export default defineEventContract({
  definition: OnboardingSubmittedV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: ['notification-service'],
  summary: 'Solicitação submetida para análise.',
});
