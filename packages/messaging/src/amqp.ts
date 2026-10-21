import { connect, type ChannelModel, type ConfirmChannel, type Options } from 'amqplib';

export interface AmqpSettings {
  /** `amqp://usuario:senha@host:5672/` */
  url: string;
}

/** Conexão AMQP com um canal de confirmação (publisher confirms). */
export interface AmqpSession {
  connection: ChannelModel;
  channel: ConfirmChannel;
}

export async function openAmqp(settings: AmqpSettings): Promise<AmqpSession> {
  const connection = await connect(settings.url);
  const channel = await connection.createConfirmChannel();
  return { connection, channel };
}

/**
 * Fila quorum (D6): replicada e durável. `deadLetterTo` liga o *dead-lettering* (TTL vencido,
 * rejeição ou limite de entregas) com estratégia at-least-once, para não perder a mensagem na
 * passagem de uma fila para a outra.
 */
export async function assertQuorumQueue(
  channel: ConfirmChannel,
  name: string,
  options: { ttlMs?: number; deadLetterTo?: string; deliveryLimit?: number } = {},
): Promise<void> {
  const args: Record<string, unknown> = { 'x-queue-type': 'quorum' };
  if (options.ttlMs !== undefined) args['x-message-ttl'] = options.ttlMs;
  if (options.deliveryLimit !== undefined) args['x-delivery-limit'] = options.deliveryLimit;
  if (options.deadLetterTo) {
    args['x-dead-letter-exchange'] = '';
    args['x-dead-letter-routing-key'] = options.deadLetterTo;
    args['x-dead-letter-strategy'] = 'at-least-once';
    args['x-overflow'] = 'reject-publish';
  }
  await channel.assertQueue(name, { durable: true, arguments: args });
}

/** Publica numa fila e espera a confirmação do broker. */
export function sendConfirmed(
  channel: ConfirmChannel,
  queue: string,
  body: Buffer,
  options: Options.Publish = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.sendToQueue(queue, body, { persistent: true, ...options }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}
