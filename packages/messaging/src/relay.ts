import type { Clock } from '@broker/clock';
import type { DatabaseConfig } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import type { Envelope } from './envelope.js';
import type { PartitionedProducer } from './stream/producer.js';

interface OutboxRow {
  id: string;
  seq: bigint;
  event_type: string;
  event_version: number;
  partition_key: string;
  payload: Record<string, unknown>;
  headers: {
    source: string;
    environment: string;
    correlationId: string;
    causationId?: string;
    actor: Envelope['actor'];
    traceparent?: string;
    auditable: boolean;
  };
  occurred_at: Date;
}

export interface OutboxRelayOptions {
  /** Conexão da aplicação (`<svc>_app`). */
  db: Kysely<unknown>;
  /** Mesma credencial, para a conexão dedicada do LISTEN. */
  listenConfig: DatabaseConfig;
  producer: PartitionedProducer;
  clock: Clock;
  batchSize?: number;
  /** Polling de segurança, caso um NOTIFY se perca (padrão 1 s). */
  pollIntervalMs?: number;
  /** Publicados há mais que isto são apagados (padrão 7 dias, D7). */
  retentionDays?: number;
  cleanupIntervalMs?: number;
  onError?: (err: unknown) => void;
  /** Gancho de teste: roda depois de o broker confirmar e antes de marcar `published_at`. */
  afterPublish?: (eventIds: string[]) => void | Promise<void>;
}

/** Monta o envelope do barramento a partir da linha da outbox. */
export function toEnvelope(row: OutboxRow, publishedAt: string): Envelope {
  const h = row.headers;
  return {
    eventId: row.id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    source: h.source,
    environment: h.environment,
    occurredAt: row.occurred_at.toISOString(),
    publishedAt,
    partitionKey: row.partition_key,
    correlationId: h.correlationId,
    ...(h.causationId ? { causationId: h.causationId } : {}),
    actor: h.actor,
    ...(h.traceparent ? { traceparent: h.traceparent } : {}),
    auditable: h.auditable,
    payload: row.payload,
  };
}

/**
 * Relay da outbox (ADR-0008, D7). Lê os eventos pendentes em ordem de inserção (`seq`) com
 * `FOR UPDATE SKIP LOCKED`, publica com confirmação do broker e só então marca `published_at`,
 * tudo na mesma transação.
 *
 * - Acordado por `LISTEN outbox_event` (o `EventPublisher` faz `pg_notify` no commit), com polling
 *   de segurança.
 * - Ordem por chave (RN-PAD-022): o lote é enviado em ordem de `seq`, e cada chave vai sempre para
 *   a mesma partição. Rode um único relay ativo por serviço (use `LeaderElector`), senão dois relays
 *   poderiam publicar lotes da mesma chave em paralelo.
 * - Se cair entre publicar e marcar, a transação é desfeita e o lote é republicado: o broker
 *   descarta pelo `publishingId` (= `seq`) e a inbox do consumidor garante o efeito único.
 */
export class OutboxRelay {
  private listener: pg.Client | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private again = false;
  private stopped = true;

  constructor(private readonly options: OutboxRelayOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    const listener = new pg.Client({
      ...this.options.listenConfig,
      application_name: 'outbox-relay',
    });
    listener.on('notification', () => this.wake());
    listener.on('error', (err) => this.options.onError?.(err));
    await listener.connect();
    await listener.query('LISTEN outbox_event');
    this.listener = listener;
    this.pollTimer = setInterval(() => this.wake(), this.options.pollIntervalMs ?? 1000);
    this.cleanupTimer = setInterval(
      () => void this.cleanup().catch((e) => this.options.onError?.(e)),
      this.options.cleanupIntervalMs ?? 3_600_000,
    );
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.cleanupTimer);
    await this.draining;
    await this.listener?.end().catch(() => undefined);
    this.listener = undefined;
  }

  /** Publica tudo o que está pendente. Chamadas concorrentes viram uma só rodada extra. */
  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.again = false;
          while (!this.stopped && (await this.publishBatch()) > 0);
        } while (this.again && !this.stopped);
      } catch (err) {
        this.options.onError?.(err);
      } finally {
        this.draining = undefined;
      }
    })();
    return this.draining;
  }

  /** Publica um lote; devolve quantos eventos publicou. */
  async publishBatch(): Promise<number> {
    return this.options.db.transaction().execute(async (trx) => {
      const rows = (
        await sql<OutboxRow>`
          SELECT id, seq, event_type, event_version, partition_key, payload, headers, occurred_at
          FROM outbox_event
          WHERE published_at IS NULL
          ORDER BY seq
          LIMIT ${this.options.batchSize ?? 100}
          FOR UPDATE SKIP LOCKED`.execute(trx)
      ).rows;
      if (rows.length === 0) return 0;

      const publishedAt = this.options.clock.now().toString();
      await this.options.producer.sendAll(
        rows.map((row) => ({
          partitionKey: row.partition_key,
          publishingId: row.seq,
          messageId: row.id,
          body: Buffer.from(JSON.stringify(toEnvelope(row, publishedAt))),
          applicationProperties: { eventType: row.event_type, eventVersion: row.event_version },
        })),
      );
      const ids = rows.map((r) => r.id);
      await this.options.afterPublish?.(ids);
      await sql`UPDATE outbox_event SET published_at = now() WHERE id = ANY(${ids}::uuid[])`.execute(
        trx,
      );
      return rows.length;
    });
  }

  /** Apaga eventos publicados há mais de `retentionDays` (D7). Devolve quantos apagou. */
  async cleanup(): Promise<number> {
    const days = this.options.retentionDays ?? 7;
    const result = await sql`
      DELETE FROM outbox_event
      WHERE published_at IS NOT NULL AND published_at < now() - make_interval(days => ${days})`.execute(
      this.options.db,
    );
    return Number(result.numAffectedRows ?? 0n);
  }
}
