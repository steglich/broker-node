import type { Clock } from '@broker/clock';
import type { Envelope, PartitionedProducer } from '@broker/messaging';
import { sql, type Kysely } from 'kysely';

interface Row {
  instrument_id: string;
  seq: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  causation_id: string | null;
  correlation_id: string;
}

export interface OutputRelayOptions {
  db: Kysely<unknown>;
  producer: PartitionedProducer;
  source: string;
  environment: string;
  clock: Clock;
  batchSize?: number;
  /** Polling de segurança; o sequenciador da mesma instância acorda o relay direto. */
  pollIntervalMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Publica `engine_output` em `engine.events` (RN-MSG-B-040, D7, D12). Mesma técnica do `OutboxRelay`:
 * lê em ordem de `seq`, publica com confirmação e marca, tudo numa transação. As saídas regeneradas
 * por um replay nem chegam aqui, porque `engine_output` já tem o `engine_seq`; se o relay cair entre
 * publicar e marcar, o broker descarta pelo `publishingId` e a inbox de quem consome, pelo `eventId`.
 */
export class OutputRelay {
  private timer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private again = false;
  private stopped = true;

  constructor(private readonly o: OutputRelayOptions) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), this.o.pollIntervalMs ?? 500);
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.draining;
  }

  wake(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = (async () => {
      try {
        do {
          this.again = false;
          while (!this.stopped && (await this.publishBatch()) > 0);
        } while (this.again && !this.stopped);
      } catch (err) {
        this.o.onError?.(err);
      } finally {
        this.draining = undefined;
      }
    })();
  }

  async publishBatch(): Promise<number> {
    return this.o.db.transaction().execute(async (trx) => {
      const { rows } = await sql<Row>`
        SELECT instrument_id, seq, event_id, event_type, payload, occurred_at, causation_id,
               correlation_id
        FROM engine_output
        WHERE published_at IS NULL
        ORDER BY seq
        LIMIT ${this.o.batchSize ?? 500}
        FOR UPDATE SKIP LOCKED`.execute(trx);
      if (rows.length === 0) return 0;
      const publishedAt = this.o.clock.now().toString();
      await this.o.producer.sendAll(
        rows.map((row) => {
          const envelope: Envelope = {
            eventId: row.event_id,
            eventType: row.event_type,
            eventVersion: 1,
            source: this.o.source,
            environment: this.o.environment,
            occurredAt: new Date(row.occurred_at).toISOString(),
            publishedAt,
            partitionKey: row.instrument_id,
            correlationId: row.correlation_id,
            ...(row.causation_id ? { causationId: row.causation_id } : {}),
            actor: { type: 'SYSTEM', id: this.o.source },
            auditable: false,
            payload: row.payload,
          };
          return {
            partitionKey: row.instrument_id,
            publishingId: BigInt(row.seq),
            messageId: row.event_id,
            body: Buffer.from(JSON.stringify(envelope)),
            applicationProperties: { eventType: row.event_type, eventVersion: 1 },
          };
        }),
      );
      await sql`
        UPDATE engine_output SET published_at = now()
        WHERE seq = ANY(${rows.map((r) => r.seq)}::bigint[])`.execute(trx);
      return rows.length;
    });
  }
}
