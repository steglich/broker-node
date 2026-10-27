import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });

export const NotificationReadV1 = defineEvent({
  eventType: 'notification.read',
  eventVersion: 1,
  payload: Type.Object({
    userId: Uuid,
    /** As que passaram a lidas nesta marcação (as já lidas ficam de fora). */
    notificationIds: Type.Array(Uuid),
    readAt: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: NotificationReadV1,
  producer: 'notification-service',
  consumers: ['realtime-gateway'],
  summary: 'Notificações marcadas como lidas: os outros canais atualizam o contador.',
});
