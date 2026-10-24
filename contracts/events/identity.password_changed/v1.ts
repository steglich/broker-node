import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const IdentityPasswordChangedV1 = defineEvent({
  eventType: 'identity.password_changed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    userId: Type.String({ format: 'uuid' }),
    at: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: IdentityPasswordChangedV1,
  producer: 'identity-service',
  consumers: ['notification-service', 'audit-service'],
  summary: 'Senha trocada (troca ou recuperação de acesso).',
});
