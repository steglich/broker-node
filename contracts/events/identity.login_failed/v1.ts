import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const IdentityLoginFailedV1 = defineEvent({
  eventType: 'identity.login_failed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    emailHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    /** `INVALID_CREDENTIALS`, `LOCKED`, `INVALID_MFA`. */
    reason: Type.String(),
    ipHash: Type.Optional(Type.String()),
    /** Falhas seguidas do usuário (0 quando o e-mail não existe). */
    attemptCount: Type.Integer({ minimum: 0 }),
  }),
});

export default defineEventContract({
  definition: IdentityLoginFailedV1,
  producer: 'identity-service',
  consumers: ['audit-service'],
  summary: 'Tentativa de login recusada (RN-AUTH-002).',
});
