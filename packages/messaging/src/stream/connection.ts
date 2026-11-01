import { Client } from 'rabbitmq-stream-js-client';

export interface StreamSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  vhost?: string;
  /**
   * Porta AMQP do mesmo broker, para declarar topologia de forma idempotente (`ensureSuperStream`).
   * Padrão: 5672 quando o stream usa a porta padrão (5552); com portas mapeadas (Testcontainers),
   * só se informada.
   */
  amqpPort?: number;
}

const settingsOf = new WeakMap<Client, StreamSettings>();

/** As configurações com que o cliente foi conectado (topologia via AMQP). */
export const streamSettingsOf = (client: Client): StreamSettings | undefined =>
  settingsOf.get(client);

/**
 * Conecta no RabbitMQ streams com o *address resolver* ligado no endpoint configurado
 * (ADR-0001, achado 5): o broker anuncia o hostname interno, que não resolve fora do Docker.
 */
export async function connectStream(
  settings: StreamSettings,
  connectionName: string,
): Promise<Client> {
  const client = await Client.connect({
    hostname: settings.host,
    port: settings.port,
    username: settings.user,
    password: settings.password,
    vhost: settings.vhost ?? '/',
    connectionName,
    addressResolver: { enabled: true, endpoint: { host: settings.host, port: settings.port } },
  });
  settingsOf.set(client, settings);
  return client;
}
