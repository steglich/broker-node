import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const NotificationFailedV1 = defineEvent({
  eventType: 'notification.failed',
  eventVersion: 1,
  payload: Type.Object({
    notificationId: Uuid,
    userId: Uuid,
    code: Type.String(),
    channel: Type.Union(['PUSH', 'EMAIL', 'SMS'].map((c) => Type.Literal(c))),
    attempts: Type.Integer({ minimum: 0 }),
    /** Ex.: `NO_EMAIL`, `UNREGISTERED_DEVICE`, `DEADLINE_EXCEEDED`. */
    reason: Type.String(),
  }),
});

export default defineEventContract({
  definition: NotificationFailedV1,
  producer: 'notification-service',
  summary: 'Falha definitiva da entrega num canal, depois das retentativas (RN-NOT-G-007).',
});
