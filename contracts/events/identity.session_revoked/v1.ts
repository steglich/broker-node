import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const IdentitySessionRevokedV1 = defineEvent({
  eventType: 'identity.session_revoked',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    userId: Type.String({ format: 'uuid' }),
    sessionId: Type.String({ format: 'uuid' }),
    /** `USER`, `REFRESH_REUSE`, `PASSWORD_RECOVERY`, `ADMIN`, `LOGOUT`. */
    reason: Type.String(),
  }),
});

export default defineEventContract({
  definition: IdentitySessionRevokedV1,
  producer: 'identity-service',
  consumers: ['realtime-gateway', 'audit-service'],
  summary: 'Sessão encerrada: os tokens dela deixam de valer (RN-AUTH-013).',
});
