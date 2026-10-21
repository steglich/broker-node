import type { Client, Publisher } from 'rabbitmq-stream-js-client';
import { partitionIndex } from './routing.js';

interface Pending {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface ProducedMessage {
  partitionKey: string;
  /** Identificador de publicação crescente por produtor (o relay usa o `seq` da outbox). */
  publishingId: bigint;
  body: Buffer;
  messageId: string;
  applicationProperties?: Record<string, string | number>;
}

/**
 * Produtor de super stream com confirmação do broker (ADR-0001, achado 1): roteia pela chave e
 * usa um `Publisher` por partição, esperando o `publish_confirm` de cada mensagem.
 *
 * Com `publisherRef`, o broker descarta reenvios de um `publishingId` já visto (ADR-0001,
 * achado 6). O broker também confirma os descartados, então quem reenvia não fica esperando.
 */
export class PartitionedProducer {
  private readonly pending = new Map<string, Map<bigint, Pending>>();

  private constructor(
    private readonly partitions: readonly string[],
    private readonly publishers: ReadonlyMap<string, Publisher>,
  ) {
    for (const [partition, publisher] of publishers) {
      const waiting = new Map<bigint, Pending>();
      this.pending.set(partition, waiting);
      publisher.on('publish_confirm', (err, ids) => {
        for (const id of ids) {
          const p = waiting.get(id);
          if (!p) continue;
          waiting.delete(id);
          if (err === null) p.resolve();
          else
            p.reject(
              new Error(`broker recusou a publicação ${id} em ${partition} (código ${err})`),
            );
        }
      });
    }
  }

  static async create(
    client: Client,
    superStream: string,
    publisherRef: string,
  ): Promise<PartitionedProducer> {
    const partitions = await client.partitionsQuery({ superStream });
    if (partitions.length === 0) throw new Error(`super stream não existe: ${superStream}`);
    const publishers = new Map<string, Publisher>();
    for (const partition of partitions) {
      publishers.set(
        partition,
        await client.declarePublisher({
          stream: partition,
          publisherRef: `${publisherRef}.${partition}`,
        }),
      );
    }
    return new PartitionedProducer(partitions, publishers);
  }

  partitionFor(key: string): string {
    return this.partitions[partitionIndex(key, this.partitions.length)]!;
  }

  /** Último `publishingId` aceito pelo broker em cada partição (para retomar após reinício). */
  async lastPublishingIds(): Promise<Map<string, bigint>> {
    const result = new Map<string, bigint>();
    for (const [partition, publisher] of this.publishers)
      result.set(partition, await publisher.getLastPublishingId());
    return result;
  }

  /**
   * Envia em ordem e resolve quando o broker confirmar todas. Mensagens da mesma chave vão para a
   * mesma partição na ordem do array (RN-PAD-022).
   */
  async sendAll(messages: readonly ProducedMessage[], confirmTimeoutMs = 10_000): Promise<void> {
    const confirmations: Promise<void>[] = [];
    const touched = new Set<string>();
    for (const m of messages) {
      const partition = this.partitionFor(m.partitionKey);
      const publisher = this.publishers.get(partition)!;
      touched.add(partition);
      confirmations.push(
        new Promise<void>((resolve, reject) =>
          this.pending.get(partition)!.set(m.publishingId, { resolve, reject }),
        ),
      );
      await publisher.basicSend(m.publishingId, m.body, {
        messageProperties: { messageId: m.messageId },
        applicationProperties: { partitionKey: m.partitionKey, ...m.applicationProperties },
      });
    }
    for (const partition of touched) await this.publishers.get(partition)!.flush();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sem confirmação do broker em ${confirmTimeoutMs} ms`)),
        confirmTimeoutMs,
      );
    });
    try {
      await Promise.race([Promise.all(confirmations), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
