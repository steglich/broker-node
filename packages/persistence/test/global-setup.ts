import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

/** Databases criados para os testes: um por arquivo, para isolar o estado. */
export const TEST_SERVICES = [
  'migrations',
  'appendonly',
  'crypto',
  'leader',
  'ledger',
  'oms',
] as const;

export interface PostgresInfo {
  host: string;
  port: number;
  passwords: Record<string, string>;
  /** Superusuário do contêiner, só para os testes simularem falhas (ex.: derrubar uma sessão). */
  superuser: { user: string; password: string };
}

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: PostgresInfo;
  }
}

const initScript = fileURLToPath(
  new URL('../../../infra/postgres/init/01-services.sh', import.meta.url),
);

let container: StartedPostgreSqlContainer | undefined;

/**
 * Sobe um PostgreSQL 17 real (Testcontainers) e roda nele o MESMO script de init do ambiente
 * local (infra/postgres/init), com um catálogo de teste. Assim os testes usam as credenciais
 * reais `<svc>_app` (DML) e `<svc>_migrator` (DDL).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const passwords: Record<string, string> = {};
  const secretFiles = TEST_SERVICES.flatMap((svc) =>
    (['app', 'migrator'] as const).map((kind) => {
      const role = `${svc}_${kind}`;
      passwords[role] = randomBytes(16).toString('hex');
      return { content: passwords[role], target: `/run/secrets/db/${role}` };
    }),
  );

  container = await new PostgreSqlContainer('postgres:17.11-alpine')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCopyContentToContainer([
      { content: `${TEST_SERVICES.join('\n')}\n`, target: '/etc/broker/services.txt' },
      {
        content: readFileSync(initScript, 'utf8'),
        target: '/docker-entrypoint-initdb.d/01-services.sh',
      },
      ...secretFiles,
    ])
    .start();

  project.provide('postgres', {
    host: container.getHost(),
    port: container.getPort(),
    passwords,
    superuser: { user: 'postgres', password: 'postgres' },
  });
  return async () => {
    await container?.stop();
  };
}
