import { startPostgres, startRabbitMq } from '@broker/testing/containers';
import type { TestProject } from 'vitest/node';

/** Databases de teste (um por cenário, para isolar o estado). */
export const TEST_SERVICES = [
  'publisher',
  'relay',
  'relaysink',
  'consumer',
  'retry',
  'blocking',
  'dlqtool',
] as const;

export interface BrokerInfo {
  postgres: {
    host: string;
    port: number;
    passwords: Record<string, string>;
    superuser: { user: string; password: string };
  };
  rabbit: {
    host: string;
    amqpPort: number;
    streamPort: number;
    managementPort: number;
    user: string;
    password: string;
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    broker: BrokerInfo;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [pg, rabbit] = await Promise.all([startPostgres(TEST_SERVICES), startRabbitMq()]);
  project.provide('broker', {
    postgres: { host: pg.host, port: pg.port, passwords: pg.passwords, superuser: pg.superuser },
    rabbit: {
      host: rabbit.host,
      amqpPort: rabbit.amqpPort,
      streamPort: rabbit.streamPort,
      managementPort: rabbit.managementPort,
      user: rabbit.user,
      password: rabbit.password,
    },
  });
  return async () => {
    await Promise.all([pg.container.stop(), rabbit.container.stop()]);
  };
}
