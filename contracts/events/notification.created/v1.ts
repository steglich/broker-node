import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
const Priority = Type.Union(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => Type.Literal(p)));
const Channel = Type.Union(
  ['IN_APP', 'PUSH', 'EMAIL', 'SMS', 'DESKTOP'].map((c) => Type.Literal(c)),
);

export const NotificationCreatedV1 = defineEvent({
  eventType: 'notification.created',
  eventVersion: 1,
  payload: Type.Object({
    notificationId: Uuid,
    userId: Uuid,
    accountId: Type.Union([Uuid, Type.Null()]),
    code: Type.String({ pattern: '^[A-Z][A-Z0-9_]*$' }),
    /** Já renderizado (pt-BR); nunca com CPF nem dado sensível completo (RN-NOT-G-003). */
    title: Type.String(),
    priority: Priority,
    channels: Type.Array(Channel),
    /** Rota do deep link, igual em todos os canais (RN-NOT-G-009, RN-FE-050). */
    deepLink: Type.String(),
  }),
});

export default defineEventContract({
  definition: NotificationCreatedV1,
  producer: 'notification-service',
  consumers: ['realtime-gateway'],
  summary: 'Notificação gerada; aparece na central in-app (Notificações §7, RN-NOT-G-001).',
});
