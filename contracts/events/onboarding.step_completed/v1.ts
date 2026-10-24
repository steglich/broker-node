import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const OnboardingStepCompletedV1 = defineEvent({
  eventType: 'onboarding.step_completed',
  eventVersion: 1,
  payload: Type.Object({ applicationId: Uuid, step: Type.String() }),
});

export default defineEventContract({
  definition: OnboardingStepCompletedV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: ['reporting-service'],
  summary: 'Etapa do onboarding concluída (funil).',
});
