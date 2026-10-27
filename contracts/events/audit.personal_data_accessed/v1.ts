import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const AuditPersonalDataAccessedV1 = defineEvent({
  eventType: 'audit.personal_data_accessed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    /** O que foi lido (ex.: `customer_profile`, `withdrawal_account`), sem os valores. */
    resourceType: Type.String({ pattern: '^[a-z][a-z0-9_]*$' }),
    /** Dono dos dados: o usuário (canal do cliente) ou o cliente consultado (backoffice). */
    resourceId: Type.String({ minLength: 1 }),
    route: Type.String(),
    channel: Type.Union([
      Type.Literal('WEB'),
      Type.Literal('MOBILE'),
      Type.Literal('DESKTOP'),
      Type.Literal('BACKOFFICE'),
    ]),
    actorRoles: Type.Optional(Type.Array(Type.String())),
    justification: Type.Optional(Type.String({ maxLength: 500 })),
    ip: Type.Optional(Type.String()),
    userAgent: Type.Optional(Type.String()),
  }),
});

export default defineEventContract({
  definition: AuditPersonalDataAccessedV1,
  // Cada BFF publica no próprio tópico (`bff-web.events`, `bff-backoffice.events`...).
  producer: 'bff',
  context: '*',
  consumers: ['audit-service'],
  summary: 'Consulta a dados pessoais por um canal (Segurança de aplicação §3, RN-AUD-BO-001).',
});
