import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const OnboardingKycCompletedV1 = defineEvent({
  eventType: 'onboarding.kyc_completed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    applicationId: Uuid,
    outcome: Type.Union([
      Type.Literal('APPROVED'),
      Type.Literal('MANUAL_REVIEW'),
      Type.Literal('REJECTED'),
    ]),
    checks: Type.Array(Type.Object({ type: Type.String(), result: Type.String() })),
  }),
});

export default defineEventContract({
  definition: OnboardingKycCompletedV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: ['notification-service', 'audit-service'],
  summary: 'Resultado do KYC simulado (RN-ONB-020..022).',
});
