import { Offset, type Client } from 'rabbitmq-stream-js-client';
import { connectStream, type StreamSettings } from './connection.js';

type SuperStreamConsumer = NonNullable<Parameters<Client['declareConsumer']>[2]>;

export interface PartitionReaderOptions {
  /** Grupo SAC. */
  name: string;
  superStream: string;
  /** Índice da partição no super stream. */
  partition: number;
  stream: StreamSettings;
  /** Último offset já gravado (retoma do seguinte), ou `undefined` para começar do início. */
  savedOffset: () => Promise<bigint | undefined>;
  onMessage: (raw: Buffer, offset: bigint) => void;
}

/**
 * Leitura crua de uma partição, em Single Active Consumer, para quem precisa gravar em lote e por
 * conta própria o offset e o efeito (o sequenciador do Motor faz *group commit*, D12). Para o resto,
 * use `EventConsumer`, que abre uma transação por mensagem.
 *
 * Cada leitor tem a própria conexão: fechar só o consumidor quebra o pool (ADR-0001, achado 3), e o
 * dono da partição precisa poder largá-la sem afetar as outras.
 */
export class PartitionReader {
  private client: Client | undefined;

  constructor(private readonly options: PartitionReaderOptions) {}

  get streamName(): string {
    return `${this.options.superStream}-${this.options.partition}`;
  }

  async start(): Promise<void> {
    const { name, superStream, stream } = this.options;
    this.client = await connectStream(stream, `reader:${name}:${this.options.partition}`);
    const from = async () => {
      const saved = await this.options.savedOffset();
      return saved === undefined ? Offset.first() : Offset.offset(saved + 1n);
    };
    await this.client.declareConsumer(
      {
        stream: this.streamName,
        consumerRef: name,
        offset: await from(),
        singleActive: true,
        consumerUpdateListener: from,
      },
      (msg) => this.options.onMessage(msg.content, msg.offset ?? 0n),
      // A mesma propriedade `super-stream` do `EventConsumer` (ADR-0001, achado 2).
      { superStream } as unknown as SuperStreamConsumer,
    );
  }

  async stop(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }
}
