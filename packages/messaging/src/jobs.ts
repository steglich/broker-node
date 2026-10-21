import type { ConsumeMessage } from 'amqplib';
import { assertQuorumQueue, sendConfirmed, type AmqpSession } from './amqp.js';

export interface JobQueueOptions {
  /** Fila `<ambiente>.<serviço>.jobs.<nome>`, ex.: `prod.reporting.jobs.brokerage-note`. */
  name: string;
  /** Entregas antes de mandar o job para a DLQ da fila (quorum `x-delivery-limit`). Padrão 5. */
  deliveryLimit?: number;
}

export interface Job<P = unknown> {
  jobId: string;
  payload: P;
  /** Número da entrega (1 = primeira vez). */
  deliveryCount: number;
}

/**
 * Fila de jobs (D6, RN-MSG-B §2 "Job"): fila quorum com entrega pelo menos uma vez, ack manual e
 * prefetch. Se o worker morre sem confirmar, o broker devolve o job para a fila e outro worker o
 * recebe. Jobs que falham `deliveryLimit` vezes vão para `<fila>.dlq` (ver `startJobWorker`).
 * Quem processa precisa ser idempotente pelo `jobId`.
 */
export class JobQueue<P = unknown> {
  constructor(
    private readonly amqp: AmqpSession,
    private readonly options: JobQueueOptions,
  ) {}

  get name(): string {
    return this.options.name;
  }

  get dlqName(): string {
    return `${this.options.name}.dlq`;
  }

  get deliveryLimit(): number {
    return this.options.deliveryLimit ?? 5;
  }

  async declare(): Promise<void> {
    await assertQuorumQueue(this.amqp.channel, this.dlqName);
    await assertQuorumQueue(this.amqp.channel, this.options.name, {
      deadLetterTo: this.dlqName,
      deliveryLimit: this.deliveryLimit,
    });
  }

  /** Enfileira com confirmação do broker. */
  enqueue(jobId: string, payload: P): Promise<void> {
    return sendConfirmed(
      this.amqp.channel,
      this.options.name,
      Buffer.from(JSON.stringify(payload)),
      { messageId: jobId },
    );
  }
}

export interface JobWorkerOptions<P> {
  /** Jobs em processamento ao mesmo tempo neste worker. */
  prefetch: number;
  handle: (job: Job<P>) => Promise<void>;
  /** Espera antes de devolver um job que falhou (padrão 1 s), para não girar em laço. */
  retryDelayMs?: number;
  onError?: (err: unknown, job: Job<P>) => void;
}

const RETRIES_HEADER = 'x-broker-retries';

/**
 * Worker de uma fila de jobs. Confirma (ack) só depois de o job terminar.
 *
 * Falhas são contadas pelo próprio worker: no RabbitMQ 4, um `nack` com requeue não incrementa o
 * `x-delivery-count` da fila quorum, então o limite de entregas nunca seria atingido e o job
 * voltaria em laço. O worker republica o job com o cabeçalho de tentativas (depois de
 * `retryDelayMs`) e confirma o original; no limite, manda para a DLQ da fila. O `x-delivery-limit`
 * da fila continua valendo para as devoluções por queda do worker, que o broker conta.
 * Usa um canal próprio, para o prefetch valer só para ele.
 */
export async function startJobWorker<P>(
  amqp: AmqpSession,
  queue: JobQueue<P>,
  options: JobWorkerOptions<P>,
): Promise<{ stop: () => Promise<void> }> {
  const channel = await amqp.connection.createConfirmChannel();
  await channel.prefetch(options.prefetch);
  const { consumerTag } = await channel.consume(
    queue.name,
    (msg: ConsumeMessage | null) => {
      if (!msg) return;
      const headers = msg.properties.headers ?? {};
      const retries = Number(headers[RETRIES_HEADER] ?? 0);
      const job: Job<P> = {
        jobId: String(msg.properties.messageId ?? ''),
        payload: JSON.parse(msg.content.toString('utf8')) as P,
        // Entregas = devoluções contadas pelo broker (queda do worker) + falhas contadas aqui.
        deliveryCount: Number(headers['x-delivery-count'] ?? 0) + retries + 1,
      };
      options
        .handle(job)
        .then(() => channel.ack(msg))
        .catch(async (err: unknown) => {
          options.onError?.(err, job);
          try {
            const target = job.deliveryCount >= queue.deliveryLimit ? queue.dlqName : queue.name;
            if (target === queue.name)
              await new Promise((r) => setTimeout(r, options.retryDelayMs ?? 1000));
            await sendConfirmed(channel, target, msg.content, {
              messageId: job.jobId,
              headers: {
                [RETRIES_HEADER]: retries + 1,
                'x-broker-error': err instanceof Error ? err.message.slice(0, 500) : String(err),
              },
            });
            channel.ack(msg);
          } catch {
            // Sem confirmar a republicação, devolve o original (pelo menos uma vez).
            channel.nack(msg, false, true);
          }
        });
    },
    { noAck: false },
  );
  return {
    stop: async () => {
      await channel.cancel(consumerTag).catch(() => undefined);
      await channel.close().catch(() => undefined);
    },
  };
}
