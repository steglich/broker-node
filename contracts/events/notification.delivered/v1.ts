import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const NotificationDeliveredV1 = defineEvent({
  eventType: 'notification.delivered',
  eventVersion: 1,
  payload: Type.Object({
    notificationId: Uuid,
    userId: Uuid,
    code: Type.String(),
    channel: Type.Union(['PUSH', 'EMAIL', 'SMS'].map((c) => Type.Literal(c))),
    attempts: Type.Integer({ minimum: 1 }),
    deliveredAt: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: NotificationDeliveredV1,
  producer: 'notification-service',
  summary: 'Entregue num canal externo (Mailpit ou message-sink no local, RN-NOT-G-007).',
});
