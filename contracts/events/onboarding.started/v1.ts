import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const OnboardingStartedV1 = defineEvent({
  eventType: 'onboarding.started',
  eventVersion: 1,
  payload: Type.Object({ applicationId: Uuid, userId: Uuid }),
});

export default defineEventContract({
  definition: OnboardingStartedV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: ['notification-service'],
  summary: 'Solicitação de abertura iniciada (login criado).',
});
