import { RoutineCompletedV1 } from '@broker/contracts/events/routine.completed/v1';
import { RoutineFailedV1 } from '@broker/contracts/events/routine.failed/v1';
import type { EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type {
  AnchorRow,
  AuditStore,
  AuditTx,
  RecordFilter,
  VerificationRow,
} from '../application/ports.js';
import type { AuditRecord, ChainBreak } from '../domain/record.js';

interface RecordRow {
  seq: string;
  event_id: string;
  actor_type: string;
  actor_id: string;
  actor_roles: string[];
  action: string;
  resource_type: string;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  changed_fields: string[];
  justification: string | null;
  approval_request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  source: string;
  occurred_at: Date;
  recorded_at: Date;
  correlation_id: string;
  prev_hash: string;
  hash: string;
}

const toRecord = (r: RecordRow): AuditRecord => ({
  seq: Number(r.seq),
  eventId: r.event_id,
  actorType: r.actor_type,
  actorId: r.actor_id,
  actorRoles: r.actor_roles,
  action: r.action,
  resourceType: r.resource_type,
  resourceId: r.resource_id,
  before: r.before,
  after: r.after,
  changedFields: r.changed_fields,
  justification: r.justification,
  approvalRequestId: r.approval_request_id,
  ip: r.ip,
  userAgent: r.user_agent,
  source: r.source,
  occurredAt: r.occurred_at.toISOString(),
  recordedAt: r.recorded_at.toISOString(),
  correlationId: r.correlation_id,
  prevHash: r.prev_hash,
  hash: r.hash,
});

interface AnchorDbRow {
  business_date: string;
  seq: string;
  hash: string;
  object_key: string;
  version_id: string | null;
  anchored_at: Date;
}

const toAnchor = (r: AnchorDbRow): AnchorRow => ({
  businessDate: r.business_date,
  seq: Number(r.seq),
  hash: r.hash,
  objectKey: r.object_key,
  versionId: r.version_id,
  anchoredAt: r.anchored_at.toISOString(),
});

const ANCHOR_COLUMNS = sql`business_date::text AS business_date, seq, hash, object_key, version_id, anchored_at`;

/** Chave do advisory lock que serializa os appends na cabeça da cadeia. */
const HEAD_LOCK = 0x41554454; // 'AUDT'

const ACTOR = { type: 'SYSTEM' as const, id: 'audit-service' };

/** Adaptador do banco da auditoria; os eventos vão para a outbox na mesma transação (ADR-0008). */
export class PostgresAuditStore implements AuditStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: AuditTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  /** Unidade de trabalho sobre uma transação já aberta (ex.: a do consumidor, com a inbox). */
  tx(trx: Kysely<unknown>): AuditTx {
    const publisher = this.publisher;
    return {
      async lockHead() {
        await sql`SELECT pg_advisory_xact_lock(${HEAD_LOCK})`.execute(trx);
        const row = (
          await sql<{ seq: string; hash: string }>`
            SELECT seq, hash FROM audit_record ORDER BY seq DESC LIMIT 1`.execute(trx)
        ).rows[0];
        return row ? { seq: Number(row.seq), hash: row.hash } : null;
      },
      async hasEvent(eventId) {
        const { rows } = await sql`SELECT 1 FROM audit_record WHERE event_id = ${eventId}`.execute(
          trx,
        );
        return rows.length > 0;
      },
      async insert(r) {
        await sql`
          INSERT INTO audit_record (seq, event_id, actor_type, actor_id, actor_roles, action,
            resource_type, resource_id, before, after, changed_fields, justification,
            approval_request_id, ip, user_agent, source, occurred_at, recorded_at, correlation_id,
            prev_hash, hash)
          VALUES (${r.seq}, ${r.eventId}, ${r.actorType}, ${r.actorId}, ${r.actorRoles}, ${r.action},
            ${r.resourceType}, ${r.resourceId}, ${JSON.stringify(r.before)}::jsonb,
            ${JSON.stringify(r.after)}::jsonb, ${r.changedFields}, ${r.justification},
            ${r.approvalRequestId}, ${r.ip}, ${r.userAgent}, ${r.source}, ${r.occurredAt},
            ${r.recordedAt}, ${r.correlationId}, ${r.prevHash}, ${r.hash})`.execute(trx);
      },
      async anchorOf(businessDate) {
        const row = (
          await sql<AnchorDbRow>`
            SELECT ${ANCHOR_COLUMNS} FROM audit_anchor WHERE business_date = ${businessDate}`.execute(
            trx,
          )
        ).rows[0];
        return row ? toAnchor(row) : null;
      },
      async insertAnchor(a) {
        await sql`
          INSERT INTO audit_anchor (business_date, seq, hash, object_key, version_id, anchored_at)
          VALUES (${a.businessDate}, ${a.seq}, ${a.hash}, ${a.objectKey}, ${a.versionId}, ${a.anchoredAt})`.execute(
          trx,
        );
      },
      async insertVerification(v) {
        await sql`
          INSERT INTO audit_verification (id, business_date, status, verified_through_seq, broken,
            reason, started_at, finished_at)
          VALUES (${v.id}, ${v.businessDate}, ${v.status}, ${v.verifiedThroughSeq},
            ${v.broken ? JSON.stringify(v.broken) : null}::jsonb, ${v.reason}, ${v.startedAt},
            ${v.finishedAt})`.execute(trx);
      },
      async publish(event) {
        const ctx = {
          // audit.events é particionado pela rotina, como os resultados das outras rotinas.
          partitionKey: event.payload.routineName,
          aggregateType: 'routine_execution',
          aggregateId: `${event.payload.routineName}@${event.payload.businessDate}`,
          actor: ACTOR,
        };
        if (event.type === 'routine.completed') {
          await publisher.publish(trx, RoutineCompletedV1, event.payload, ctx);
        } else {
          await publisher.publish(trx, RoutineFailedV1, event.payload, ctx);
        }
      },
    };
  }

  async recordsFrom(fromSeq: number, limit: number): Promise<AuditRecord[]> {
    const { rows } = await sql<RecordRow>`
      SELECT * FROM audit_record WHERE seq >= ${fromSeq} ORDER BY seq LIMIT ${limit}`.execute(
      this.db,
    );
    return rows.map(toRecord);
  }

  async recordAt(seq: number): Promise<AuditRecord | null> {
    const row = (
      await sql<RecordRow>`SELECT * FROM audit_record WHERE seq = ${seq}`.execute(this.db)
    ).rows[0];
    return row ? toRecord(row) : null;
  }

  async find(f: RecordFilter): Promise<AuditRecord[]> {
    const conditions = [sql`occurred_at >= ${f.from}`, sql`occurred_at < ${f.to}`];
    if (f.actorId !== undefined) conditions.push(sql`actor_id = ${f.actorId}`);
    if (f.action !== undefined) conditions.push(sql`action = ${f.action}`);
    if (f.resourceType !== undefined) conditions.push(sql`resource_type = ${f.resourceType}`);
    if (f.resourceId !== undefined) conditions.push(sql`resource_id = ${f.resourceId}`);
    if (f.beforeSeq !== undefined) conditions.push(sql`seq < ${f.beforeSeq}`);
    const { rows } = await sql<RecordRow>`
      SELECT * FROM audit_record WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY seq DESC LIMIT ${f.limit}`.execute(this.db);
    return rows.map(toRecord);
  }

  async lastAnchor(): Promise<AnchorRow | null> {
    const row = (
      await sql<AnchorDbRow>`
        SELECT ${ANCHOR_COLUMNS} FROM audit_anchor ORDER BY anchored_at DESC, seq DESC LIMIT 1`.execute(
        this.db,
      )
    ).rows[0];
    return row ? toAnchor(row) : null;
  }

  async verifications(limit: number): Promise<VerificationRow[]> {
    const { rows } = await sql<{
      id: string;
      business_date: string | null;
      status: 'OK' | 'BROKEN';
      verified_through_seq: string;
      broken: ChainBreak | null;
      reason: string | null;
      started_at: Date;
      finished_at: Date;
    }>`
      SELECT id, business_date::text AS business_date, status, verified_through_seq, broken, reason,
        started_at, finished_at
      FROM audit_verification ORDER BY finished_at DESC LIMIT ${limit}`.execute(this.db);
    return rows.map((r) => ({
      id: r.id,
      businessDate: r.business_date,
      status: r.status,
      verifiedThroughSeq: Number(r.verified_through_seq),
      broken: r.broken,
      reason: r.reason,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at.toISOString(),
    }));
  }
}
