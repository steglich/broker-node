import { auditServiceHttp } from '@broker/contracts/http/audit-service';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_PERIOD_DAYS,
  validationError,
  type Service,
} from '@broker/service-kit';
import type { AuditTrail } from '../application/audit-trail.js';

const r = auditServiceHttp.routes;

/** RN-AUD-005: só a auditoria interna e o administrador leem a trilha. */
export const AUDIT_READER_ROLES = ['BO_AUDITOR', 'BO_ADMIN'];

const encodeCursor = (seq: number) => Buffer.from(String(seq)).toString('base64url');
function decodeCursor(cursor: string): number {
  const seq = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw validationError([
      { field: 'cursor', code: 'INVALID_CURSOR', message: 'Cursor inválido ou expirado.' },
    ]);
  }
  return seq;
}

export function registerHttp(service: Service, d: { trail: AuditTrail }): void {
  service.route({
    method: 'get',
    path: '/v1/audit-records',
    auth: { roles: AUDIT_READER_ROLES },
    validate: { query: r.listRecords.query },
    handler: async (req, ctx) => {
      const q = req.query;
      const from = Date.parse(q.from);
      const to = Date.parse(q.to);
      // Consulta limitada (RN-API-022): período obrigatório de até 1 ano.
      if (!(to > from) || (to - from) / 86_400_000 > MAX_PERIOD_DAYS) {
        throw validationError([
          { field: 'to', code: 'INVALID_PERIOD', message: 'Use to depois de from, até 1 ano.' },
        ]);
      }
      const limit = Math.min(Math.max(Number(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
      const records = await d.trail.query(
        {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          ...(q.actorId !== undefined ? { actorId: q.actorId } : {}),
          ...(q.action !== undefined ? { action: q.action } : {}),
          ...(q.resourceType !== undefined ? { resourceType: q.resourceType } : {}),
          ...(q.resourceId !== undefined ? { resourceId: q.resourceId } : {}),
          ...(q.cursor !== undefined ? { beforeSeq: decodeCursor(q.cursor) } : {}),
          limit,
        },
        {
          actor: ctx.actor,
          roles: [...ctx.roles],
          ...(ctx.ip ? { ip: ctx.ip } : {}),
          ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
          correlationId: ctx.correlationId,
        },
      );
      const last = records[records.length - 1];
      return {
        body: {
          items: records,
          ...(records.length === limit && last ? { nextCursor: encodeCursor(last.seq) } : {}),
        },
      };
    },
  });
}
