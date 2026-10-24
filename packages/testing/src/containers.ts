import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const infraFile = (path: string) =>
  fileURLToPath(new URL(`../../../infra/${path}`, import.meta.url));

export interface StartedPostgres {
  container: StartedPostgreSqlContainer;
  host: string;
  port: number;
  /** Senha de cada papel `<svc>_app` e `<svc>_migrator`. */
  passwords: Record<string, string>;
  superuser: { user: string; password: string };
}

/**
 * PostgreSQL 17 com o MESMO script de init do ambiente local (infra/postgres/init): um database
 * e as credenciais `<svc>_app` e `<svc>_migrator` para cada serviço de `services`.
 */
export async function startPostgres(services: readonly string[]): Promise<StartedPostgres> {
  const passwords: Record<string, string> = {};
  const secretFiles = services.flatMap((svc) =>
    (['app', 'migrator'] as const).map((kind) => {
      const role = `${svc}_${kind}`;
      passwords[role] = randomBytes(16).toString('hex');
      return { content: passwords[role], target: `/run/secrets/db/${role}` };
    }),
  );
  const container = await new PostgreSqlContainer('postgres:17.11-alpine')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCopyContentToContainer([
      { content: `${services.join('\n')}\n`, target: '/etc/broker/services.txt' },
      {
        content: readFileSync(infraFile('postgres/init/01-services.sh'), 'utf8'),
        target: '/docker-entrypoint-initdb.d/01-services.sh',
      },
      ...secretFiles,
    ])
    .start();
  return {
    container,
    host: container.getHost(),
    port: container.getPort(),
    passwords,
    superuser: { user: 'postgres', password: 'postgres' },
  };
}

export interface StartedRabbitMq {
  container: StartedTestContainer;
  host: string;
  amqpPort: number;
  streamPort: number;
  managementPort: number;
  user: string;
  password: string;
}

/** RabbitMQ 4 com os plugins e a configuração do ambiente local (infra/rabbitmq). */
export async function startRabbitMq(): Promise<StartedRabbitMq> {
  const password = randomBytes(12).toString('hex');
  const container = await new GenericContainer('rabbitmq:4.3.6-management-alpine')
    .withHostname('rabbitmq')
    .withExposedPorts(5672, 5552, 15672)
    .withCopyContentToContainer([
      {
        content: readFileSync(infraFile('rabbitmq/enabled_plugins'), 'utf8'),
        target: '/etc/rabbitmq/enabled_plugins',
      },
      {
        content: readFileSync(infraFile('rabbitmq/rabbitmq.conf'), 'utf8'),
        target: '/etc/rabbitmq/conf.d/10-broker.conf',
      },
      { content: `default_pass = ${password}\n`, target: '/etc/rabbitmq/conf.d/90-secret.conf' },
    ])
    .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
    .withStartupTimeout(120_000)
    .start();
  return {
    container,
    host: container.getHost(),
    amqpPort: container.getMappedPort(5672),
    streamPort: container.getMappedPort(5552),
    managementPort: container.getMappedPort(15672),
    user: 'broker',
    password,
  };
}

export interface StartedValkey {
  container: StartedTestContainer;
  host: string;
  port: number;
}

/** Valkey como no ambiente local: sem persistência (D16). */
export async function startValkey(): Promise<StartedValkey> {
  const container = await new GenericContainer('valkey/valkey:8.1.10-alpine')
    .withCommand(['valkey-server', '--save', '', '--appendonly', 'no'])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  return { container, host: container.getHost(), port: container.getMappedPort(6379) };
}

/** Credenciais de um papel do database de um serviço (`<svc>_app` ou `<svc>_migrator`). */
export function databaseConfig(
  pg: Pick<StartedPostgres, 'host' | 'port' | 'passwords'>,
  service: string,
  kind: 'app' | 'migrator',
): { host: string; port: number; database: string; user: string; password: string } {
  const user = `${service}_${kind}`;
  const password = pg.passwords[user];
  if (password === undefined) throw new Error(`o contêiner não criou o serviço ${service}`);
  return { host: pg.host, port: pg.port, database: service, user, password };
}

export interface StartedMinio {
  container: StartedTestContainer;
  /** `http://host:porta` da API S3. */
  endpoint: string;
  accessKey: string;
  secretKey: string;
}

/** MinIO com a mesma imagem do ambiente local (D16), para testar URLs pré-assinadas. */
export async function startMinio(): Promise<StartedMinio> {
  const secretKey = randomBytes(16).toString('hex');
  const container = await new GenericContainer('pgsty/minio:RELEASE.2026-08-04T00-00-00Z')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: 'broker', MINIO_ROOT_PASSWORD: secretKey })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();
  return {
    container,
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    accessKey: 'broker',
    secretKey,
  };
}
