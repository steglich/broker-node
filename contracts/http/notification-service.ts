// notification-service (catálogo de serviços §17, Contratos §8): central in-app, preferências e
// tokens de push. As notificações nascem dos eventos (Notificações §3); a API só lê e configura.
import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Code = Type.String({ pattern: '^[A-Z][A-Z0-9_]*$' });
export const NotificationChannel = Type.Union(
  ['IN_APP', 'PUSH', 'EMAIL', 'SMS', 'DESKTOP'].map((c) => Type.Literal(c)),
);
export const NotificationPriority = Type.Union(
  ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => Type.Literal(p)),
);
const Hhmm = Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' });
const QuietHours = Type.Object({ start: Hhmm, end: Hhmm });

export const Notification = Type.Object({
  id: Uuid,
  code: Code,
  title: Type.String(),
  body: Type.String(),
  /** Deep link (`deepLink`, RN-NOT-G-009) e os identificadores do recurso. */
  data: Type.Record(Type.String(), Type.String()),
  priority: NotificationPriority,
  channels: Type.Array(NotificationChannel),
  createdAt: DateTime,
  readAt: Type.Union([DateTime, Type.Null()]),
});

const Preference = Type.Object({
  code: Code,
  priority: NotificationPriority,
  /** `false`: obrigatória, a preferência não vale (Notificações §3). */
  canDisable: Type.Boolean(),
  channels: Type.Array(Type.Object({ channel: NotificationChannel, enabled: Type.Boolean() })),
});

const Preferences = Type.Object({
  items: Type.Array(Preference),
  /** Adia PUSH e EMAIL de prioridade baixa e média (RN-NOT-G-006); `null` = desligado. */
  quietHours: Type.Union([QuietHours, Type.Null()]),
  /** Push com texto genérico, sem valores (RN-NOT-G-003). */
  hideValues: Type.Boolean(),
});

export const notificationServiceHttp = defineHttpContract({
  service: 'notification-service',
  title: 'Notificações',
  version: '1.0.0',
  routes: {
    list: {
      method: 'get',
      path: '/v1/me/notifications',
      summary: 'Central in-app: mais recentes primeiro, 90 dias (RN-NOT-G-008).',
      auth: 'user',
      query: Type.Object({
        cursor: Type.Optional(Type.String()),
        limit: Type.Optional(Type.String({ pattern: '^\\d+$' })),
        unread: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
      }),
      responses: {
        200: {
          description: 'Página da central e o total de não lidas.',
          body: Type.Object({
            items: Type.Array(Notification),
            nextCursor: Type.Optional(Type.String()),
            unreadCount: Type.Integer({ minimum: 0 }),
          }),
        },
      },
    },
    markRead: {
      method: 'post',
      path: '/v1/me/notifications/read',
      summary: 'Marca como lidas: uma lista de IDs ou todas.',
      auth: 'user',
      body: Type.Union([
        Type.Object({ ids: Type.Array(Uuid, { minItems: 1, maxItems: 200 }) }),
        Type.Object({ all: Type.Literal(true) }),
      ]),
      responses: {
        200: {
          description: 'Quantas passaram a lidas.',
          body: Type.Object({ updated: Type.Integer({ minimum: 0 }) }),
        },
      },
    },
    getPreferences: {
      method: 'get',
      path: '/v1/me/notification-preferences',
      summary: 'Preferências por código e canal, horário de silêncio e "ocultar valores".',
      auth: 'user',
      responses: { 200: { description: 'Preferências.', body: Preferences } },
    },
    putPreferences: {
      method: 'put',
      path: '/v1/me/notification-preferences',
      summary:
        'Atualiza as preferências; sem `channel`, vale para todos os canais padrão do código.',
      auth: 'user',
      body: Type.Object({
        preferences: Type.Optional(
          Type.Array(
            Type.Object({
              code: Code,
              channel: Type.Optional(NotificationChannel),
              enabled: Type.Boolean(),
            }),
            { maxItems: 200 },
          ),
        ),
        quietHours: Type.Optional(Type.Union([QuietHours, Type.Null()])),
        hideValues: Type.Optional(Type.Boolean()),
      }),
      responses: {
        200: { description: 'Preferências atualizadas.', body: Preferences },
        422: {
          description:
            '`NOTIFICATION_NOT_OPTIONAL` (obrigatória), `UNKNOWN_NOTIFICATION_CODE` ou canal fora dos padrões.',
        },
      },
    },
    registerPushDevice: {
      method: 'post',
      path: '/v1/me/push-devices',
      summary: 'Registra (ou renova) o token de push do aparelho; cifrado no banco.',
      auth: 'user',
      body: Type.Object({
        platform: Type.Union([Type.Literal('IOS'), Type.Literal('ANDROID')]),
        token: Type.String({ minLength: 8, maxLength: 4096 }),
      }),
      responses: {
        201: { description: 'Registrado.', body: Type.Object({ id: Uuid }) },
        200: { description: 'Já registrado: renovado.', body: Type.Object({ id: Uuid }) },
      },
    },
  },
});

export default notificationServiceHttp;
