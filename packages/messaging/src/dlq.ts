import type { IncomingMessage, ServerResponse } from 'node:http';
import { sql, type Kysely } from 'kysely';
import type { EventConsumer } from './consumer.js';
import type { Envelope } from './envelope.js';
import { InvalidMessageError } from './errors.js';
import { defineEvent } from './events.js';
import type { EventPublisher } from './publisher.js';
import Type from 'typebox';

export interface DeadLetterSummary {
  id: string;
  consumer: string;
  eventType: string | null;
  partitionKey: string | null;
  error: string;
  attempts: number;
  status: 'PENDING' | 'REPROCESSED' | 'DISCARDED';
  createdAt: string;
  /** A chave está bloqueada por esta mensagem (consumidor ordenado). */
  blocking: boolean;
  parkedBehind: number;
}

export interface DeadLetterDetail extends DeadLetterSummary {
  stream: string;
  partition: number | null;
  offset: string | null;
  eventId: string | null;
  payload: unknown;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

/** Evento de auditoria do descarte (vai para a trilha via `auditable`, RN-MSG-B-036). */
export const DeadLetterDiscarded = defineEvent({
  eventType: 'messaging.dead_letter_discarded',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    deadLetterId: Type.String(),
    consumer: Type.String(),
    operator: Type.String(),
    justification: Type.String(),
  }),
});

interface Row {
  id: string;
  consumer: string;
  stream: string;
  partition: number | null;
  offset: bigint | null;
  event_id: string | null;
  event_type: string | null;
  partition_key: string | null;
  payload: unknown;
  error: string;
  attempts: number;
  status: DeadLetterSummary['status'];
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
  blocking: boolean;
  parked_behind: string;
}

const summary = (r: Row): DeadLetterSummary => ({
  id: r.id,
  consumer: r.consumer,
  eventType: r.event_type,
  partitionKey: r.partition_key,
  error: r.error,
  attempts: r.attempts,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  blocking: r.blocking,
  parkedBehind: Number(r.parked_behind),
});

/**
 * Ferramenta de DLQ (RN-MSG-B-036): listar, inspecionar, corrigir/reprocessar e descartar com
 * justificativa auditada. Opera sobre a tabela `dead_letter` do serviço e usa os consumidores
 * registrados para reprocessar (o efeito roda no processo do serviço, com o handler dele).
 */
export class DlqAdmin {
  private readonly consumers: Map<string, EventConsumer>;

  constructor(
    private readonly options: {
      db: Kysely<unknown>;
      consumers: readonly EventConsumer[];
      /** Publicador do serviço: o descarte grava `messaging.dead_letter_discarded` na outbox. */
      publisher?: EventPublisher;
    },
  ) {
    this.consumers = new Map(options.consumers.map((c) => [c.name, c]));
  }

  async list(
    filter: { status?: DeadLetterSummary['status']; consumer?: string; limit?: number } = {},
  ): Promise<DeadLetterSummary[]> {
    const rows = await this.query(sql`
      WHERE (${filter.status ?? null}::text IS NULL OR d.status = ${filter.status ?? null})
        AND (${filter.consumer ?? null}::text IS NULL OR d.consumer = ${filter.consumer ?? null})
      ORDER BY d.created_at, d.id
      LIMIT ${Math.min(filter.limit ?? 50, 200)}`);
    return rows.map(summary);
  }

  async inspect(id: string): Promise<DeadLetterDetail> {
    const r = (await this.query(sql`WHERE d.id = ${id}`))[0];
    if (!r) throw new InvalidMessageError(`mensagem não encontrada na DLQ: ${id}`);
    return {
      ...summary(r),
      stream: r.stream,
      partition: r.partition,
      offset: r.offset === null ? null : r.offset.toString(),
      eventId: r.event_id,
      payload: r.payload,
      resolvedAt: r.resolved_at?.toISOString() ?? null,
      resolvedBy: r.resolved_by,
      resolutionNote: r.resolution_note,
    };
  }

  async reprocess(
    id: string,
    operator: string,
    note: string,
    corrected?: Envelope,
  ): Promise<DeadLetterDetail> {
    const detail = await this.inspect(id);
    await this.consumer(detail.consumer).reprocessDeadLetter(id, operator, note, corrected);
    return this.inspect(id);
  }

  async discard(id: string, operator: string, justification: string): Promise<DeadLetterDetail> {
    const detail = await this.inspect(id);
    const publisher = this.options.publisher;
    await this.consumer(detail.consumer).discardDeadLetter(
      id,
      operator,
      justification,
      async (trx) => {
        await publisher?.publish(
          trx,
          DeadLetterDiscarded,
          { deadLetterId: id, consumer: detail.consumer, operator, justification },
          {
            partitionKey: detail.consumer,
            aggregateType: 'dead_letter',
            aggregateId: id,
            actor: { type: 'BACKOFFICE', id: operator },
          },
        );
      },
    );
    return this.inspect(id);
  }

  private consumer(name: string): EventConsumer {
    const c = this.consumers.get(name);
    if (!c) throw new InvalidMessageError(`consumidor não registrado neste serviço: ${name}`);
    return c;
  }

  private async query(where: ReturnType<typeof sql>): Promise<Row[]> {
    return (
      await sql<Row>`
        SELECT d.*,
               EXISTS (SELECT 1 FROM blocked_key b WHERE b.dead_letter_id = d.id) AS blocking,
               (SELECT count(*) FROM parked_message p
                 WHERE p.consumer = d.consumer AND p.partition_key = d.partition_key) AS parked_behind
        FROM dead_letter d ${where}`.execute(this.options.db)
    ).rows;
  }
}

/**
 * API administrativa da DLQ, sem framework (montável no Express do service-kit):
 *
 *   GET  /admin/dlq?status=PENDING&consumer=x   lista
 *   GET  /admin/dlq/:id                          inspeciona
 *   POST /admin/dlq/:id/reprocess  { operator, note, corrected? }
 *   POST /admin/dlq/:id/discard    { operator, justification }
 *
 * A autenticação e a autorização (papel de operação) ficam por conta de quem monta a rota.
 */
export function createDlqHttpHandler(admin: DlqAdmin, basePath = '/admin/dlq') {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
    });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      : {};
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(basePath)) return false;
    const parts = url.pathname.slice(basePath.length).split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && parts.length === 0) {
        const status = url.searchParams.get('status') as DeadLetterSummary['status'] | null;
        const consumer = url.searchParams.get('consumer');
        send(
          res,
          200,
          await admin.list({ ...(status ? { status } : {}), ...(consumer ? { consumer } : {}) }),
        );
      } else if (req.method === 'GET' && parts.length === 1) {
        send(res, 200, await admin.inspect(parts[0]!));
      } else if (req.method === 'POST' && parts.length === 2 && parts[1] === 'reprocess') {
        const body = await readBody(req);
        send(
          res,
          200,
          await admin.reprocess(
            parts[0]!,
            String(body['operator'] ?? ''),
            String(body['note'] ?? ''),
            body['corrected'] as Envelope | undefined,
          ),
        );
      } else if (req.method === 'POST' && parts.length === 2 && parts[1] === 'discard') {
        const body = await readBody(req);
        send(
          res,
          200,
          await admin.discard(
            parts[0]!,
            String(body['operator'] ?? ''),
            String(body['justification'] ?? ''),
          ),
        );
      } else {
        send(res, 404, { type: 'about:blank', title: 'Not Found', status: 404 });
      }
    } catch (err) {
      const invalid = err instanceof InvalidMessageError;
      send(res, invalid ? 422 : 500, {
        type: 'about:blank',
        title: invalid ? 'Unprocessable Entity' : 'Internal Server Error',
        status: invalid ? 422 : 500,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  };
}
