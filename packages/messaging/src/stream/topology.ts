import { connect } from 'amqplib';
import type { Client } from 'rabbitmq-stream-js-client';
import { streamSettingsOf, type StreamSettings } from './connection.js';

/** Nome de tópico `<ambiente>.<contexto>.<tipo>` (RN-MSG-B-001): `sandbox.ledger.events`. */
export function topicName(
  environment: string,
  context: string,
  kind: 'events' | 'commands' = 'events',
): string {
  for (const part of [environment, context]) {
    if (!/^[a-z][a-z0-9-]*$/.test(part))
      throw new Error(`parte inválida no nome do tópico: ${part}`);
  }
  return `${environment}.${context}.${kind}`;
}

export interface SuperStreamOptions {
  /** Partições (D6: padrão local 3; a tabela de RN-MSG-B-002 vale para staging). */
  partitions?: number;
  /** Retenção por idade, ex.: `90D` (RN-MSG-B-002). */
  maxAge?: string;
  /** Retenção por tamanho de cada partição, em bytes. */
  maxLengthBytes?: number;
}

/**
 * Cria o super stream se ainda não existir e devolve as partições em ordem.
 *
 * Vários serviços garantem o mesmo tópico na subida (o dono e quem o consome). O comando
 * `create_super_stream` do protocolo de streams não é seguro sob concorrência: quem perde a corrida
 * desfaz a própria criação e apaga a exchange de quem ganhou, deixando as partições órfãs. Por isso,
 * com o AMQP disponível, a topologia é declarada peça por peça (exchange, streams e bindings), de
 * forma idempotente; isso também conserta um tópico que ficou sem a exchange.
 */
export async function ensureSuperStream(
  client: Client,
  name: string,
  options: SuperStreamOptions = {},
): Promise<string[]> {
  const partitions = () =>
    client.partitionsQuery({ superStream: name }).catch(() => [] as string[]);
  const existing = await partitions();
  if (existing.length > 0) return existing;
  const settings = streamSettingsOf(client);
  const amqpPort = settings?.amqpPort ?? (settings?.port === 5552 ? 5672 : undefined);
  if (settings && amqpPort) await declareOverAmqp({ ...settings, amqpPort }, name, options);
  else
    await client.createSuperStream(
      {
        streamName: name,
        arguments: {
          ...(options.maxAge ? { 'max-age': options.maxAge } : {}),
          ...(options.maxLengthBytes ? { 'max-length-bytes': options.maxLengthBytes } : {}),
        },
      },
      undefined,
      options.partitions ?? 3,
    );
  return client.partitionsQuery({ superStream: name });
}

/** Mesma topologia do `create_super_stream`: exchange direct, `<nome>-<i>` com chave e ordem `i`. */
async function declareOverAmqp(
  s: StreamSettings & { amqpPort: number },
  name: string,
  options: SuperStreamOptions,
): Promise<void> {
  const vhost = encodeURIComponent(s.vhost ?? '/');
  const connection = await connect(
    `amqp://${encodeURIComponent(s.user)}:${encodeURIComponent(s.password)}@${s.host}:${s.amqpPort}/${vhost}`,
  );
  // A conferência passiva de uma partição inexistente fecha o canal com erro (404): esperado aqui.
  const ignore = () => undefined;
  connection.on('error', ignore);
  const openChannel = async () => {
    const channel = await connection.createChannel();
    channel.on('error', ignore);
    return channel;
  };
  try {
    let channel = await openChannel();
    await channel.assertExchange(name, 'direct', {
      durable: true,
      arguments: { 'x-super-stream': true },
    });
    const args: Record<string, unknown> = { 'x-queue-type': 'stream' };
    if (options.maxAge) args['x-max-age'] = options.maxAge;
    if (options.maxLengthBytes) args['x-max-length-bytes'] = options.maxLengthBytes;
    for (let i = 0; i < (options.partitions ?? 3); i++) {
      const partition = `${name}-${i}`;
      // Partição que já existe fica como está (mesmo com outros parâmetros): a conferência passiva
      // falha e fecha o canal só quando ela não existe.
      try {
        await channel.checkQueue(partition);
      } catch {
        channel = await openChannel();
        await channel.assertQueue(partition, { durable: true, arguments: args });
      }
      await channel.bindQueue(partition, name, String(i), { 'x-stream-partition-order': i });
    }
  } finally {
    await connection.close().catch(() => undefined);
  }
}
