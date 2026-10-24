import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const IdentityMfaEnabledV1 = defineEvent({
  eventType: 'identity.mfa_enabled',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    userId: Type.String({ format: 'uuid' }),
    at: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: IdentityMfaEnabledV1,
  producer: 'identity-service',
  consumers: ['notification-service', 'audit-service'],
  summary: 'Fator de MFA ativado (RN-AUTH-003).',
});
