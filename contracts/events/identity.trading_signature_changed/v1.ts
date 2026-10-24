import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const IdentityTradingSignatureChangedV1 = defineEvent({
  eventType: 'identity.trading_signature_changed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    userId: Type.String({ format: 'uuid' }),
    at: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: IdentityTradingSignatureChangedV1,
  producer: 'identity-service',
  consumers: ['notification-service', 'audit-service'],
  summary: 'Assinatura eletrônica cadastrada ou redefinida (RN-SIG-001).',
});
