import { Client } from 'rabbitmq-stream-js-client';

export interface StreamSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  vhost?: string;
}

/**
 * Conecta no RabbitMQ streams com o *address resolver* ligado no endpoint configurado
 * (ADR-0001, achado 5): o broker anuncia o hostname interno, que não resolve fora do Docker.
 */
export function connectStream(settings: StreamSettings, connectionName: string): Promise<Client> {
  return Client.connect({
    hostname: settings.host,
    port: settings.port,
    username: settings.user,
    password: settings.password,
    vhost: settings.vhost ?? '/',
    connectionName,
    addressResolver: { enabled: true, endpoint: { host: settings.host, port: settings.port } },
  });
}
