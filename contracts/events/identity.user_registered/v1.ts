import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const IdentityUserRegisteredV1 = defineEvent({
  eventType: 'identity.user_registered',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    userId: Type.String({ format: 'uuid' }),
    realm: Type.Union([Type.Literal('customers'), Type.Literal('backoffice')]),
    /** HMAC do e-mail normalizado (o e-mail em si não trafega, RN-MSG-B-013). */
    emailHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    registeredAt: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: IdentityUserRegisteredV1,
  producer: 'identity-service',
  consumers: ['customer-service', 'audit-service'],
  summary: 'Credenciais criadas no realm (cadastro do cliente ou convite do backoffice).',
});
