import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const DateTime = Type.String({ format: 'date-time' });
const NullableString = Type.Union([Type.String(), Type.Null()]);

export const AuditRecordView = Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  eventId: Type.String({ format: 'uuid' }),
  actorType: Type.String(),
  actorId: Type.String(),
  actorRoles: Type.Array(Type.String()),
  action: Type.String(),
  resourceType: Type.String(),
  resourceId: NullableString,
  /** Com os dados sensíveis trocados por `***` (RN-AUD-003). */
  before: Type.Unknown(),
  after: Type.Unknown(),
  /** O que mudou entre `before` e `after`, inclusive campos mascarados. */
  changedFields: Type.Array(Type.String()),
  justification: NullableString,
  approvalRequestId: NullableString,
  ip: NullableString,
  userAgent: NullableString,
  source: Type.String(),
  occurredAt: DateTime,
  recordedAt: DateTime,
  correlationId: Type.String(),
  prevHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  hash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
});

export const auditServiceHttp = defineHttpContract({
  service: 'audit-service',
  title: 'audit-service',
  version: '1.0.0',
  routes: {
    listRecords: {
      method: 'get',
      path: '/v1/audit-records',
      summary:
        'Consulta a trilha por ator, ação, recurso e período (até 1 ano). Só BO_AUDITOR e BO_ADMIN; a consulta também é auditada (RN-AUD-005).',
      auth: 'user',
      query: Type.Object({
        from: DateTime,
        to: DateTime,
        actorId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        action: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        resourceType: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        resourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        limit: Type.Optional(Type.String({ pattern: '^[0-9]{1,3}$' })),
        cursor: Type.Optional(Type.String({ maxLength: 64 })),
      }),
      responses: {
        200: {
          description: 'Registros, do mais novo ao mais antigo.',
          body: Type.Object({
            items: Type.Array(AuditRecordView),
            nextCursor: Type.Optional(Type.String()),
          }),
        },
        401: { description: 'Sem token válido.' },
        403: { description: 'Papel sem acesso à trilha (ex.: BO_FINANCE).' },
      },
    },
  },
});

export default auditServiceHttp;
