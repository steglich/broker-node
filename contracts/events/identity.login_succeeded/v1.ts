import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const IdentityLoginSucceededV1 = defineEvent({
  eventType: 'identity.login_succeeded',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    userId: Type.String({ format: 'uuid' }),
    sessionId: Type.String({ format: 'uuid' }),
    deviceId: Type.String({ format: 'uuid' }),
    channel: Type.String(),
    ipHash: Type.Optional(Type.String()),
    newDevice: Type.Boolean(),
  }),
});

export default defineEventContract({
  definition: IdentityLoginSucceededV1,
  producer: 'identity-service',
  consumers: ['notification-service', 'audit-service'],
  summary: 'Login concluído: sessão criada (Autenticação §4).',
});
