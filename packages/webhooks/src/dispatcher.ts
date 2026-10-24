import type { Clock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { signedHeaders } from './signature.js';

/** Backoff do reenvio (RN-SIM-004): 1 s, 5 s, 30 s, 2 min, 10 min, 1 h; depois, de hora em hora. */
export const DEFAULT_RETRY_SCHEDULE_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 3_600_000];

/**
 * Tabela de entregas do simulador. A fila é persistente: um webhook pendente sobrevive ao
 * reinício do simulador e continua sendo reenviado até o receptor responder `2xx`.
 */
export const webhookMigrations: Record<string, Migration> = {
  '0000_webhooks_delivery': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE webhook_delivery (
          id               uuid PRIMARY KEY,
          event_id         text NOT NULL,
          event_type       text NOT NULL,
          url              text NOT NULL,
          body             text NOT NULL,
          status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
          attempts         integer NOT NULL DEFAULT 0,
          next_attempt_at  timestamptz NOT NULL,
          last_status      integer,
          last_error       text,
          created_at       timestamptz NOT NULL,
          delivered_at     timestamptz
        )`.execute(db);
      await sql`CREATE INDEX webhook_delivery_due_idx ON webhook_delivery (next_attempt_at) WHERE status = 'PENDING'`.execute(
        db,
      );
    },
  },
};

export interface EnqueueWebhook {
  /** ID do evento, igual em todas as tentativas (e nas duplicatas forçadas): é a chave de idempotência do receptor. */
  eventId: string;
  eventType: string;
  url: string;
  body: unknown;
  /** Primeira tentativa não antes deste instante (cenário de webhook atrasado, RN-PIXS-003). */
  notBefore?: Instant;
}

export interface WebhookDispatcherOptions {
  db: Kysely<unknown>;
  secret: string;
  clock: Clock;
  newId: () => string;
  retryScheduleMs?: readonly number[];
  /** Sem limite por padrão: reenvia até `2xx` (RN-SIM-004). */
  maxAttempts?: number;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

export interface DeliveryRow {
  id: string;
  event_id: string;
  event_type: string;
  url: string;
  body: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  next_attempt_at: Date;
  last_status: number | null;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
}

/**
 * Entrega pelo menos uma vez (RN-SIM-004). `enqueue` grava na mesma transação da operação do
 * simulador; `runDue` envia o que venceu. Cada tentativa é assinada de novo com o timestamp da
 * hora do envio, senão uma retentativa depois de 5 min seria recusada pelo receptor.
 */
export class WebhookDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;
  private readonly schedule: readonly number[];

  constructor(private readonly options: WebhookDispatcherOptions) {
    this.schedule = options.retryScheduleMs ?? DEFAULT_RETRY_SCHEDULE_MS;
  }

  async enqueue(trx: Kysely<unknown>, webhook: EnqueueWebhook): Promise<string> {
    const id = this.options.newId();
    const now = this.options.clock.now();
    const at = webhook.notBefore && webhook.notBefore.isAfter(now) ? webhook.notBefore : now;
    await sql`
      INSERT INTO webhook_delivery (id, event_id, event_type, url, body, next_attempt_at, created_at)
      VALUES (${id}, ${webhook.eventId}, ${webhook.eventType}, ${webhook.url},
              ${JSON.stringify(webhook.body)}, ${at.toString()}, ${now.toString()})`.execute(trx);
    return id;
  }

  /** Envia as entregas vencidas (até `limit`); devolve quantas tentativas fez. */
  async runDue(limit = 50): Promise<number> {
    let attempts = 0;
    while (attempts < limit && (await this.attemptNext())) attempts++;
    return attempts;
  }

  /** Laço de produção: varre a fila a cada `intervalMs`. */
  start(intervalMs = 500): void {
    const tick = () => {
      this.running = this.runDue().catch((err: unknown) => {
        this.options.onError?.(err);
        return 0;
      });
      void this.running.finally(() => {
        if (this.timer !== undefined) this.timer = setTimeout(tick, intervalMs);
      });
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async list(limit = 100): Promise<DeliveryRow[]> {
    const { rows } = await sql<DeliveryRow>`
      SELECT * FROM webhook_delivery ORDER BY created_at DESC, id DESC LIMIT ${limit}`.execute(
      this.options.db,
    );
    return rows;
  }

  private async attemptNext(): Promise<boolean> {
    const { db, clock } = this.options;
    return db.transaction().execute(async (trx) => {
      const now = clock.now();
      const row = (
        await sql<DeliveryRow>`
          SELECT * FROM webhook_delivery
          WHERE status = 'PENDING' AND next_attempt_at <= ${now.toString()}
          ORDER BY next_attempt_at, created_at
          LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(trx)
      ).rows[0];
      if (!row) return false;

      const attempt = row.attempts + 1;
      let status: number | null = null;
      let error: string | null = null;
      try {
        const res = await fetch(row.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Id': row.event_id,
            'X-Webhook-Event': row.event_type,
            ...signedHeaders(this.options.secret, now.epochMillis, row.body),
          },
          body: row.body,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        });
        status = res.status;
        await res.body?.cancel();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      if (status !== null && status >= 200 && status < 300) {
        await sql`
          UPDATE webhook_delivery SET status = 'DELIVERED', attempts = ${attempt}, last_status = ${status},
                 last_error = NULL, delivered_at = ${now.toString()}
          WHERE id = ${row.id}`.execute(trx);
        return true;
      }
      const exhausted =
        this.options.maxAttempts !== undefined && attempt >= this.options.maxAttempts;
      const delay = this.schedule[Math.min(attempt, this.schedule.length) - 1]!;
      await sql`
        UPDATE webhook_delivery SET status = ${exhausted ? 'FAILED' : 'PENDING'}, attempts = ${attempt},
               last_status = ${status}, last_error = ${error ?? `HTTP ${status}`},
               next_attempt_at = ${now.plusMillis(delay).toString()}
        WHERE id = ${row.id}`.execute(trx);
      return true;
    });
  }
}
