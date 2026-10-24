import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const IdentityNewDeviceDetectedV1 = defineEvent({
  eventType: 'identity.new_device_detected',
  eventVersion: 1,
  payload: Type.Object({
    userId: Type.String({ format: 'uuid' }),
    deviceId: Type.String({ format: 'uuid' }),
    channel: Type.String(),
  }),
});

export default defineEventContract({
  definition: IdentityNewDeviceDetectedV1,
  producer: 'identity-service',
  consumers: ['notification-service'],
  summary: 'Login num dispositivo nunca visto: notificação SECURITY_NEW_DEVICE (RN-AUTH-013).',
});
